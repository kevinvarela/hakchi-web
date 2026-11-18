// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
const path = require('path');
const os = require('os');
const express = require('express');
const multer = require('multer');
const { SshShell, LocalShell } = require('./lib/shell');
const { Hakchi } = require('./lib/hakchi');
const { prepareGame } = require('./lib/roms');
const { setupDemo } = require('./lib/demo');
const { Mods } = require('./lib/mods');
const { scanUsb, classify } = require('./lib/detect');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const DEMO = args.includes('--demo');
const PORT = parseInt(opt('port', process.env.PORT || '8080'), 10);
const HOST = opt('console', process.env.CONSOLE_HOST || '169.254.13.37');

let shell;
if (DEMO) {
  const root = path.join(os.tmpdir(), `hakchi-web-demo-${opt('system', 'snes')}`);
  shell = new LocalShell({ env: setupDemo(root, opt('system', 'snes')) });
  console.log(`Modo demo: consola simulada en ${root}`);
} else {
  shell = new SshShell({ host: HOST });
}
const hakchi = new Hakchi(shell, { rebootCmd: DEMO ? 'demo-reboot' : 'reboot' });
const mods = new Mods(hakchi);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024, files: 300 } });
// Seguridad: la API controla la consola (incluido instalar módulos que se ejecutan como root),
// así que solo debe usarla esta misma página.
// 1) Host: bloquea ataques de "DNS rebinding" desde otras webs.
// 2) Cabecera propia en peticiones que cambian algo: otra web no puede enviarla sin permiso CORS (CSRF).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
app.use('/api', (req, res, next) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    return res.status(403).json({ error: 'Acceso no permitido.' });
  }
  if (req.method !== 'GET' && req.headers['x-hakchi-web'] !== '1') {
    return res.status(403).json({ error: 'Petición no permitida.' });
  }
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const msg = friendlyError(err);
    res.status(err.status || 500).json({ error: msg });
  }
};

function friendlyError(err) {
  const m = String(err && err.message ? err.message : err);
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Timed out while waiting for handshake|ENOTFOUND/i.test(m)) {
    shell.close?.();
    return `No se pudo conectar con la consola en ${HOST}. Comprueba que está encendida, conectada por USB al ordenador y que tiene hakchi CE instalado.`;
  }
  if (/authentication/i.test(m)) return 'La consola rechazó la conexión SSH (autenticación).';
  return m;
}

app.get('/api/status', wrap(async (req, res) => {
  const info = await hakchi.lock(() => hakchi.detect());
  res.json({ demo: DEMO, ...info });
}));

// Pantalla previa: comprueba si hay una consola con hakchi y, si no, explica por qué.
app.get('/api/check', async (req, res) => {
  let info = null;
  let connErr = null;
  let noHakchi = false;
  try {
    info = await hakchi.lock(() => hakchi.detect());
  } catch (e) {
    if (/no tiene hakchi/i.test(e.message)) noHakchi = true;
    else connErr = e;
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Timed out|ENOTFOUND|ECONNRESET/i.test(String(e.message))) shell.close?.();
  }
  const usb = DEMO ? null : scanUsb(process.env.HAKCHI_SYS_ROOT || '/sys');
  const result = classify({ connErr, noHakchi, usb, host: HOST });
  res.json({ ...result, demo: DEMO, info, usb });
});

app.get('/api/games', wrap(async (req, res) => {
  res.json(await hakchi.lock(() => hakchi.listGames()));
}));

app.get('/api/icon/:menu/:code', wrap(async (req, res) => {
  const png = await hakchi.lock(() => hakchi.getIcon(req.params.menu, req.params.code));
  if (!png) return res.status(404).end();
  res.type('png').set('Cache-Control', 'private, max-age=300').send(png);
}));

// Analiza ROMs sin subirlas (para mostrar nombre, avisos y errores antes de enviar).
app.post('/api/analyze', upload.any(), wrap(async (req, res) => {
  const info = await hakchi.lock(() => hakchi.ensureInfo());
  const results = req.files.map((f) => {
    try {
      const g = prepareGame({ filename: f.originalname, data: f.buffer, consoleType: info.consoleType, cores: info.cores, learned: info.learned });
      return { file: f.originalname, ok: true, code: g.code, name: g.name, system: g.system, details: g.details, warnings: g.warnings, size: g.romData.length };
    } catch (e) {
      return { file: f.originalname, ok: false, error: e.message };
    }
  });
  res.json({ results });
}));

// Sube juegos: campos rom_N (ROM), cover_N y small_N (PNG) y "meta" (JSON con un objeto por juego).
app.post('/api/games', upload.any(), wrap(async (req, res) => {
  const info = await hakchi.lock(() => hakchi.detect());
  const meta = JSON.parse(req.body.meta || '[]');
  const files = Object.fromEntries(req.files.map((f) => [f.fieldname, f]));
  const games = [];
  meta.forEach((m, i) => {
    const rom = files[`rom_${i}`];
    if (!rom) return;
    const g = prepareGame({
      filename: rom.originalname, data: rom.buffer, consoleType: info.consoleType, cores: info.cores, learned: info.learned,
      name: m.name, players: m.players, simultaneous: m.simultaneous, publisher: m.publisher, releaseDate: m.releaseDate,
    });
    g.cover = files[`cover_${i}`]?.buffer;
    g.small = files[`small_${i}`]?.buffer;
    games.push(g);
  });
  if (!games.length) return res.status(400).json({ error: 'No se recibió ninguna ROM.' });
  const seen = new Set();
  for (const g of games) {
    if (seen.has(g.code)) throw Object.assign(new Error(`"${g.name}" está repetido en la lista.`), { status: 400 });
    seen.add(g.code);
  }
  res.json(await hakchi.addGames(games));
}));

app.delete('/api/games/:menu/:code', wrap(async (req, res) => {
  await hakchi.deleteGame(req.params.menu, req.params.code);
  res.json({ ok: true });
}));

app.patch('/api/games/:menu/:code', wrap(async (req, res) => {
  await hakchi.renameGame(req.params.menu, req.params.code, req.body.name);
  res.json({ ok: true });
}));

// ---------- Módulos (hmods) ----------
const uploadMods = multer({ storage: multer.memoryStorage(), limits: { fileSize: 400 * 1024 * 1024, files: 20 } });

app.get('/api/mods', wrap(async (req, res) => {
  res.json(await hakchi.lock(async () => { await hakchi.ensureInfo(); return mods.list(); }));
}));

app.post('/api/mods', uploadMods.any(), wrap(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No se recibió ningún módulo.' });
  await hakchi.lock(() => hakchi.ensureInfo());
  const staged = [];
  for (const f of req.files) {
    try {
      staged.push(await mods.stage(f.originalname, f.buffer));
    } catch (e) {
      throw Object.assign(new Error(`${f.originalname}: ${e.message}`), { status: 400 });
    }
  }
  res.json({ staged });
}));

app.delete('/api/mods/:name', wrap(async (req, res) => {
  await mods.markRemove(req.params.name);
  res.json({ ok: true });
}));

app.post('/api/mods/:name/cancel', wrap(async (req, res) => {
  await mods.cancel(req.params.name);
  res.json({ ok: true });
}));

app.post('/api/mods-apply', wrap(async (req, res) => {
  res.json(await hakchi.lock(() => mods.apply()));
}));

app.get('/api/modhub', wrap(async (req, res) => {
  res.json({ items: await mods.fetchHub(req.query.refresh === '1') });
}));

app.post('/api/modhub/install', wrap(async (req, res) => {
  await hakchi.lock(() => hakchi.ensureInfo());
  res.json(await mods.installFromHub(String(req.body.id || '')));
}));

app.post('/api/reboot', wrap(async (req, res) => {
  await hakchi.reboot();
  hakchi.info = null;
  res.json({ ok: true });
}));

// Solo escucha en localhost: la app controla la consola y no debe exponerse a la red.
app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  hakchi web está listo.');
  console.log(`  Abre en tu navegador:  http://localhost:${PORT}`);
  console.log(DEMO ? '  (modo demo, sin consola real)' : `  Consola esperada en:   ${HOST} (USB)`);
  console.log('');
});
