// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
// Prueba de extremo a extremo contra la consola simulada (modo demo).
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const roms = require('../lib/roms');

// Todas las peticiones de prueba se identifican como la propia app (ver protección en server.js).
const rawFetch = global.fetch;
global.fetch = (u, o = {}) => rawFetch(u, { ...o, headers: { 'X-Hakchi-Web': '1', ...(o.headers || {}) } });

function nesRom(mapper = 0, battery = false) {
  const h = Buffer.alloc(16);
  h.write('NES\x1a', 0, 'latin1'); h[4] = 2; h[5] = 1;
  h[6] = ((mapper & 0x0f) << 4) | (battery ? 2 : 0); h[7] = mapper & 0xf0;
  const body = Buffer.alloc(2 * 16384 + 8192);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + mapper) & 0xff;
  return Buffer.concat([h, body]);
}
function snesRom(title, hirom = false, sram = 0, smcHeader = false) {
  const rom = Buffer.alloc(hirom ? 0x20000 : 0x80000, 0x11);
  const p = hirom ? 0xffc0 : 0x7fc0;
  rom.write(title.padEnd(21, ' '), p, 'latin1');
  rom[p + 21] = hirom ? 0x21 : 0x20; rom[p + 22] = 0x02; rom[p + 24] = sram;
  rom.writeUInt16LE(0x1234 ^ 0xffff, p + 28); rom.writeUInt16LE(0x1234, p + 30);
  return smcHeader ? Buffer.concat([Buffer.alloc(512), rom]) : rom;
}

// --- pruebas unitarias ---
assert.strictEqual(roms.crc32(Buffer.from('123456789')), 0xcbf43926);
const n = roms.prepareGame({ filename: 'Mi Juego (U) [!].nes', data: nesRom(4, true), consoleType: 'nes' });
assert.match(n.code, /^CLV-H-[A-Z]{5}$/);
assert.strictEqual(n.name, 'Mi Juego');
assert.match(n.desktop, new RegExp(`^Exec=/bin/clover-kachikachi-wr /var/games/${n.code}/Mi_Juego_U\\.nes --guest`, 'm'));
assert.match(n.desktop, /^SaveCount=3$/m);
assert.deepStrictEqual(roms.prepareGame({ filename: 'x.nes', data: nesRom(30), consoleType: 'nes' }).warnings.length, 1);

assert.throws(() => roms.prepareGame({ filename: 'x.zip', data: Buffer.alloc(10), consoleType: 'nes' }), /Formato/);

const lo = snesRom('SUPER MARIOWORLD', false, 1, true);
const s = roms.prepareGame({ filename: 'smw.smc', data: lo, consoleType: 'snes' });
assert.strictEqual(s.romData.length, 0x80000 + 96, 'cabecera SMC quitada + 48 + 48');
assert.strictEqual(s.romData.readUInt32LE(4), 0x80000 + 96);
assert.strictEqual(s.romData.toString('ascii', 0x24, 0x2c), 'WUP-XXXX');
const h2 = 48 + 0x80000;
assert.strictEqual(s.romData[h2], 60);
assert.strictEqual(s.romData.readUInt16LE(h2 + 0x0d), 0x1011, 'preset de SMW');
assert.strictEqual(s.romData[h2 + 0x11], 0x14, 'LoROM');
assert.match(s.desktop, /^SaveCount=3$/m);
assert.match(s.desktop, /clover-canoe-shvc-wr -rom \/var\/games\/CLV-U-[A-Z]{5}\/smw\.sfrom --volume 100/);
const hi = roms.prepareGame({ filename: 'hi.sfc', data: snesRom('HIGAME', true), consoleType: 'snes' });
assert.strictEqual(hi.romData[48 + 0x20000 + 0x11], 0x15, 'HiROM');
// NES en SNES Mini y SNES en NES Mini mediante RetroArch
const ra = roms.prepareGame({ filename: 'Contra (U).nes', data: nesRom(2), consoleType: 'snes', cores: ['fceumm', 'snes9x'] });
assert.match(ra.desktop, new RegExp(`^Exec=/bin/fceumm /var/games/${ra.code}/Contra_U\\.nes$`, 'm'));
assert.strictEqual(ra.emulator, 'fceumm');
assert.strictEqual(roms.prepareGame({ filename: 'x.nes', data: nesRom(30), consoleType: 'snes', cores: ['nestopia'] }).warnings.length, 0, 'sin aviso de mapper con RetroArch');
const fb = roms.prepareGame({ filename: 'x.nes', data: nesRom(0), consoleType: 'snes', cores: [] });
assert.match(fb.desktop, /^Exec=\/bin\/clover-kachikachi-wr \/var\/games\/CLV-H-[A-Z]{5}\/x\.nes --guest/m, 'sin emulador detectado: igual que hakchi2 CE');
assert.strictEqual(fb.warnings.length, 1);
const rs = roms.prepareGame({ filename: 'smw.smc', data: snesRom('SUPER MARIOWORLD', false, 1, true), consoleType: 'nes', cores: ['snes9x'] });
assert.strictEqual(rs.romData.length, 0x80000, 'cabecera SMC quitada, sin convertir a sfrom');
assert.match(rs.desktop, /^Exec=\/bin\/snes9x \/var\/games\/CLV-U-[A-Z]{5}\/smw\.sfc$/m);
assert.match(rs.desktop, /^SaveCount=3$/m);
assert.throws(() => roms.prepareGame({ filename: 'x.sfrom', data: Buffer.alloc(2048), consoleType: 'nes', cores: ['snes9x'] }), /\.sfrom/);
assert.deepStrictEqual(roms.supportedSystems('snes', ['fceumm']), ['nes', 'snes']);
assert.deepStrictEqual(roms.supportedSystems('snes', []), ['snes']);
console.log('✓ pruebas unitarias de ROMs');

// --- extremo a extremo con el servidor en modo demo ---
// ---------- Mod Hub falso ----------
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { createTar } = require('../lib/tar');
const archive = require('../lib/archive');
const hmodRA = zlib.gzipSync(createTar([
  { name: 'bin/retroarch-clover', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
  { name: 'readme.md', data: Buffer.from('---\nName: RetroArch\nCategory: Emulators\nVersion: 1.0\n---\nEmuladores **varios**') },
]));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
let hubPort;
const hubServer = http.createServer((req, res) => {
  if (req.url === '/repo/.repo/pack.tgz') {
    const url = `http://127.0.0.1:${hubPort}`;
    res.end(zlib.gzipSync(createTar([
      { name: 'list', data: Buffer.from('RetroArch.hmod\nBroken.hmod\nGame.clvg\n') },
      { name: 'RetroArch.hmod/link', data: Buffer.from(`${url}/files/ra.hmod\n`) },
      { name: 'RetroArch.hmod/md5', data: Buffer.from(md5(hmodRA)) },
      { name: 'RetroArch.hmod/readme.md', data: Buffer.from('---\nName: RetroArch\nCategory: Emulators\nVersion: 1.0\n---\nEmuladores') },
      { name: 'Broken.hmod/link', data: Buffer.from(`${url}/files/ra.hmod`) },
      { name: 'Broken.hmod/md5', data: Buffer.from('0'.repeat(32)) },
      { name: 'Game.clvg/link', data: Buffer.from(`${url}/files/x`) },
      { name: 'Hidden.hmod/link', data: Buffer.from(`${url}/files/ra.hmod`) },
    ])));
  } else if (req.url === '/files/ra.hmod') res.end(hmodRA);
  else { res.statusCode = 404; res.end(); }
});

async function e2e(system) {
  const root = path.join(os.tmpdir(), `hakchi-web-demo-${system}`);
  fs.rmSync(root, { recursive: true, force: true });
  const port = system === 'snes' ? 18081 : 18082;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--demo', '--system', system, '--port', String(port)],
    { env: { ...process.env, HAKCHI_MODHUB_URL: `http://127.0.0.1:${hubPort}/repo/` } });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50 && !log.includes('listo'); i++) await new Promise((r) => setTimeout(r, 100));
    const j = async (p, o) => { const r = await fetch(base + p, o); const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
    // Protección CSRF / DNS rebinding
    assert.strictEqual((await rawFetch(`${base}/api/reboot`, { method: 'POST' })).status, 403, 'POST sin cabecera rechazado');
    const fdx = new FormData(); fdx.append('h', new Blob([Buffer.from('x')]), 'x.hmod');
    assert.strictEqual((await rawFetch(`${base}/api/mods`, { method: 'POST', body: fdx })).status, 403, 'subida desde otra web rechazada');
    const hostStatus = (host) => new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.strictEqual(await hostStatus(`evil.example:${port}`), 403, 'Host ajeno rechazado (DNS rebinding)');
    assert.strictEqual(await hostStatus(`localhost:${port}`), 200, 'localhost permitido');
    const chk = await j('/api/check');
    assert.strictEqual(chk.state, 'ok'); assert.strictEqual(chk.info.consoleType, system);
    const st = await j('/api/status');
    assert.strictEqual(st.consoleType, system);
    let list = await j('/api/games');
    assert.strictEqual(list.games.length, 0, 'sin menú 000 aún');

    const rom = system === 'snes' ? snesRom('MY HACK', false, 0) : nesRom(1);
    const fname = system === 'snes' ? 'My Hack (Hack).sfc' : 'My Game (E).nes';
    const fd = new FormData();
    fd.append('rom_0', new Blob([rom]), fname);
    fd.append('cover_0', new Blob([Buffer.from('PNGDATA')]), '0.png');
    fd.append('small_0', new Blob([Buffer.from('SMALL')]), '0s.png');
    fd.append('meta', JSON.stringify([{ name: 'Mi Juego Ñ', players: 2 }]));
    const add = await j('/api/games', { method: 'POST', body: fd });
    assert.strictEqual(add.seededOriginals, true);
    const code = add.added[0].code;

    list = await j('/api/games');
    assert.strictEqual(list.games.length, 4, '3 de fábrica + 1 nuevo');
    const g = list.games.find((x) => x.code === code);
    assert.strictEqual(g.name, 'Mi Juego Ñ'); assert.strictEqual(g.players, 2);
    const sync = path.join(root, 'var/lib/hakchi/games', `${system}-usa`, '000');
    const files = fs.readdirSync(path.join(sync, code)).sort();
    assert.strictEqual(files.length, 4, files.join(','));
    const orig = list.games.find((x) => x.original);
    const od = fs.readFileSync(path.join(sync, orig.code, `${orig.code}.desktop`), 'utf8');
    assert.ok(od.includes(`${root}/var/squashfs/usr/share/games`), 'original apunta a squashfs');
    assert.ok(od.includes('Path=/var/lib/clover/profiles/0/'), 'partidas guardadas originales intactas');

    let icon = await fetch(`${base}/api/icon/000/${code}`);
    assert.strictEqual(Buffer.from(await icon.arrayBuffer()).toString(), 'PNGDATA');
    icon = await fetch(`${base}/api/icon/000/${orig.code}`);
    assert.strictEqual(icon.status, 200, 'icono original desde squashfs');

    await j(`/api/games/000/${code}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nuevo nombre' }) });
    list = await j('/api/games');
    assert.strictEqual(list.games.find((x) => x.code === code).name, 'Nuevo nombre');

    await j(`/api/games/000/${code}`, { method: 'DELETE' });
    list = await j('/api/games');
    assert.strictEqual(list.games.length, 3);
    assert.ok(!fs.existsSync(path.join(sync, code)));

    // ROM del otro sistema: debe ir a RetroArch
    assert.deepStrictEqual(st.supports.sort(), ['nes', 'snes']);
    const other = system === 'snes' ? { rom: nesRom(0), name: 'Otro.nes', core: 'fceumm' } : { rom: snesRom('OTRO'), name: 'Otro.sfc', core: 'snes9x' };
    const fd2 = new FormData();
    fd2.append('rom_0', new Blob([other.rom]), other.name);
    fd2.append('meta', JSON.stringify([{}]));
    const add2 = await j('/api/games', { method: 'POST', body: fd2 });
    const c2 = add2.added[0].code;
    const d2 = fs.readFileSync(path.join(sync, c2, `${c2}.desktop`), 'utf8');
    assert.match(d2, new RegExp(`^Exec=/bin/${other.core} /var/games/${c2}/Otro\\.(nes|sfc)$`, 'm'));
    await j(`/api/games/000/${c2}`, { method: 'DELETE' });

    // ---------- módulos ----------
    let m = await j('/api/mods');
    assert.deepStrictEqual(m.installed, []);
    const fdm = new FormData();
    fdm.append('h', new Blob([hmodRA]), 'my mod!.hmod');
    const up = await j('/api/mods', { method: 'POST', body: fdm });
    assert.strictEqual(up.staged[0].name, 'my_mod_');
    assert.strictEqual(up.staged[0].title, 'RetroArch');
    const fdBad = new FormData();
    fdBad.append('h', new Blob([Buffer.from('no soy un hmod')]), 'x.hmod');
    assert.strictEqual((await fetch(`${base}/api/mods`, { method: 'POST', body: fdBad })).status, 400);

    const hub = (await j('/api/modhub')).items;
    assert.deepStrictEqual(hub.map((x) => x.name).sort(), ['Broken', 'RetroArch'], 'solo .hmod de la lista');
    assert.strictEqual(hub.find((x) => x.name === 'RetroArch').category, 'Emulators');
    await j('/api/modhub/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'RetroArch.hmod' }) });
    const brk = await fetch(`${base}/api/modhub/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'Broken.hmod' }) });
    assert.match((await brk.json()).error, /MD5/);

    m = await j('/api/mods');
    assert.deepStrictEqual(m.pendingInstall.sort(), ['RetroArch', 'my_mod_']);
    const staged = archive.readArchive(fs.readFileSync(path.join(root, 'var/lib/hakchi/transfer/RetroArch.hmod')));
    assert.strictEqual(staged.find((e) => e.name === 'bin/retroarch-clover').mode, 0o755, 'permisos conservados');

    await j('/api/mods-apply', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1800));
    m = await j('/api/mods');
    assert.deepStrictEqual([...m.installed].sort(), ['RetroArch', 'my_mod_']);
    assert.deepStrictEqual(m.pendingInstall, []);

    await j('/api/mods/RetroArch', { method: 'DELETE' });
    assert.deepStrictEqual((await j('/api/mods')).pendingRemove, ['RetroArch']);
    await j('/api/mods/RetroArch/cancel', { method: 'POST' });
    assert.deepStrictEqual((await j('/api/mods')).pendingRemove, []);
    await j('/api/mods/my_mod_', { method: 'DELETE' });
    await j('/api/mods-apply', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1800));
    assert.deepStrictEqual((await j('/api/mods')).installed, ['RetroArch']);
    assert.notStrictEqual((await fetch(`${base}/api/mods/..%2Fetc`, { method: 'DELETE' })).status, 200);

    const bad = await fetch(`${base}/api/games/000/..%2F..`, { method: 'DELETE' });
    assert.notStrictEqual(bad.status, 200);
    console.log(`✓ extremo a extremo (${system})`);
  } catch (e) {
    console.error(log); throw e;
  } finally { srv.kill(); }
}

// .zip con la carpeta del módulo → .hmod
{
  const { execSync } = require('child_process');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hmodzip-'));
  fs.mkdirSync(path.join(d, 'Cosa.hmod/bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Cosa.hmod/bin/run'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'Cosa.hmod/readme.md'), '---\nName: Cosa\n---\n');
  execSync('zip -qr m.zip Cosa.hmod', { cwd: d });
  const r = archive.toHmod(fs.readFileSync(path.join(d, 'm.zip')));
  const e = archive.readArchive(r.hmod);
  assert.ok(e.some((x) => x.name === 'bin/run' && x.mode === 0o755), 'zip convertido sin la carpeta raíz');
  assert.strictEqual(archive.parseReadme(r.readme).meta.Name, 'Cosa');
  fs.rmSync(d, { recursive: true });
  console.log('✓ conversión de módulos .zip');
{
  const { summarizeReadme } = require('../lib/mods');
  const r = summarizeReadme('# T\n![a_b](https://h.net/img/retro_arch_v1.png)\n**Hola** _mundo_ snes9x_2010 [link](https://x/a_b)\n<img src="b.png">', 'https://h.net/r/.repo/M.hmod/');
  assert.strictEqual(r.image, 'https://h.net/img/retro_arch_v1.png', 'URL de imagen intacta');
  assert.strictEqual(r.description, 'T Hola mundo snes9x_2010 link');
  assert.strictEqual(summarizeReadme('<img src="pics/x_y.jpg">', 'https://h.net/r/.repo/M.hmod/').image, 'https://h.net/r/.repo/M.hmod/pics/x_y.jpg', 'ruta relativa');
  assert.strictEqual(summarizeReadme('![x](javascript:alert(1))', 'https://h/').image, null, 'solo http/https');
  const enc = summarizeReadme('Hola &lt;img src=&quot;https://h.net/a_b.png&quot; width=&quot;200&quot;&gt; mundo &amp;amp; m&aacute;s', 'https://h/');
  assert.strictEqual(enc.image, 'https://h.net/a_b.png', 'imagen codificada con entidades');
  assert.ok(!/img|<|>|&quot;/.test(enc.description), `sin restos de etiqueta: ${enc.description}`);
  const cut = summarizeReadme('Texto <img src="https://h.net/x.png"', 'https://h/');
  assert.ok(!/img|</.test(cut.description), 'etiqueta sin cerrar eliminada');
  console.log('✓ descripciones e imágenes del Mod Hub');
}
}

// ---------- detección previa (USB simulado en un /sys falso) ----------
const { scanUsb, classify } = require('../lib/detect');
function fakeSys(devices) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-'));
  fs.mkdirSync(path.join(root, 'bus/usb/devices'), { recursive: true });
  fs.mkdirSync(path.join(root, 'class/net'), { recursive: true });
  devices.forEach(([vid, pid, iface], i) => {
    const d = path.join(root, 'devices/usb', `3-${i}`);
    fs.mkdirSync(path.join(d, `3-${i}:1.0`), { recursive: true });
    fs.writeFileSync(path.join(d, 'idVendor'), `${vid}\n`);
    fs.writeFileSync(path.join(d, 'idProduct'), `${pid}\n`);
    fs.symlinkSync(d, path.join(root, 'bus/usb/devices', `3-${i}`));
    if (iface) {
      fs.mkdirSync(path.join(root, 'class/net', iface));
      fs.symlinkSync(path.join(d, `3-${i}:1.0`), path.join(root, 'class/net', iface, 'device'));
    }
  });
  return root;
}
{
  const err = new Error('connect EHOSTUNREACH 169.254.13.37:22');
  let u = scanUsb(fakeSys([['046d', 'c092'], ['04e8', '6863', 'enx0a1b2c3d4e5f']]));
  assert.deepStrictEqual(u, { hakchi: true, fel: false, iface: 'enx0a1b2c3d4e5f', ifaceHasIp: false });
  let c = classify({ connErr: err, usb: u, host: 'h' });
  assert.strictEqual(c.state, 'network');
  assert.match(c.command, /ip addr add 169\.254\.1\.2\/16 dev enx0a1b2c3d4e5f/);
  assert.strictEqual(classify({ connErr: err, usb: { ...u, ifaceHasIp: true }, host: 'h' }).state, 'starting');
  u = scanUsb(fakeSys([['1f3a', 'efe8']]));
  assert.strictEqual(classify({ connErr: err, usb: u, host: 'h' }).state, 'fel');
  u = scanUsb(fakeSys([['046d', 'c092']]));
  assert.strictEqual(classify({ connErr: err, usb: u, host: 'h' }).state, 'not-found');
  assert.strictEqual(classify({ connErr: err, usb: null, host: 'h' }).state, 'unknown');
  assert.strictEqual(classify({ noHakchi: true, usb: null, host: 'h' }).state, 'no-hakchi');
  assert.strictEqual(classify({ usb: null, host: 'h' }).state, 'ok');
  console.log('✓ detección previa de la consola');
}

(async () => {
  await new Promise((r) => hubServer.listen(0, '127.0.0.1', r));
  hubPort = hubServer.address().port;
  await e2e('snes'); await e2e('nes');
  hubServer.close();
  console.log('Todo OK');
})().catch((e) => { console.error(e); process.exit(1); });
