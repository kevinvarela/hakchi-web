// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
// Basado en el comportamiento de hakchi / hakchi2 CE (GPL-3.0). Ver NOTICE.md.
'use strict';
const { q } = require('./shell');
const { parseDesktop, buildDesktop, CORE_CANDIDATES, supportedSystems, learnEmulators } = require('./roms');
const { createTar } = require('./tar');

const CODE_RE = /^CLV-[A-Z0-9]-[A-Z0-9]{5}$/;
const MENU_RE = /^\d{3}$/;

class Hakchi {
  constructor(shell, { rebootCmd = 'reboot' } = {}) {
    this.shell = shell;
    this.rebootCmd = rebootCmd;
    this.info = null;
    this.queue = Promise.resolve();
    this.iconCache = new Map();
  }

  // Serializa las operaciones: la consola solo puede hacer una cosa a la vez.
  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async run(cmd, input) {
    const r = await this.shell.exec(cmd, input);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout.toString()).trim();
      throw new Error(`Error en la consola (código ${r.code})${msg ? `: ${msg}` : ''}`);
    }
    return r.stdout.toString();
  }

  /** Detecta consola, ruta de sincronización y espacio libre. */
  async detect() {
    const script = `
      command -v hakchi >/dev/null 2>&1 || { echo "nohakchi=1"; exit 0; }
      echo "code=$(hakchi eval 'echo "$sftype-$sfregion"')"
      echo "sep=$(hakchi eval 'echo "$cfg_separate_games"')"
      S="$(hakchi findGameSyncStorage)"
      echo "sync=$S"
      echo "squashfs=$(hakchi get squashfs)"
      echo "gamepath=$(hakchi get gamepath)"
      echo "version=$(cat /var/version 2>/dev/null || hakchi eval 'echo "$bootVersion"' 2>/dev/null)"
      df -Pk "$S" 2>/dev/null | tail -n 1 | awk '{print "total=" $2; print "free=" $4}'
      printf 'cores='
      for c in ${CORE_CANDIDATES.join(' ')}; do
        { command -v "$c" || [ -e "/bin/$c" ] || [ -e "/usr/bin/$c" ] || [ -e "/var/lib/hakchi/rootfs/bin/$c" ] \
          || [ -e "/etc/libretro/core/\${c}_libretro.so" ] || [ -e "/var/lib/hakchi/rootfs/etc/libretro/core/\${c}_libretro.so" ]; } >/dev/null 2>&1 && printf '%s ' "$c"
      done
      echo
      # Cómo se lanzan los juegos que ya están en la consola (p. ej. los que agregaste con hakchi2 CE).
      for f in "$S"/[0-9][0-9][0-9]/CLV-*/*.desktop "$S"/*/[0-9][0-9][0-9]/CLV-*/*.desktop "$S"/*/.storage/CLV-*/*.desktop "$S"/.storage/CLV-*/*.desktop; do
        [ -f "$f" ] && sed -n 's/^Exec=/@exec /p' "$f"
      done | grep -iE '[.](nes|sfc|smc)( |$)' | head -n 40
    `;
    const out = await this.run(script);
    const kv = {};
    const execs = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('@exec ')) { execs.push(line.slice(6).trim()); continue; }
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (kv.nohakchi) {
      throw new Error('La consola respondió, pero no tiene hakchi CE instalado.');
    }
    const systemCode = kv.code || '';
    const consoleType = systemCode.startsWith('snes') ? 'snes' : 'nes';
    const syncRoot = kv.sync;
    if (!syncRoot) throw new Error('hakchi no devolvió la carpeta de juegos (findGameSyncStorage).');
    const syncPath = kv.sep === 'n' ? syncRoot : `${syncRoot}/${systemCode}`;
    this.info = {
      connection: this.shell.label,
      systemCode,
      consoleType,
      consoleName: {
        'nes-usa': 'NES Classic Mini', 'nes-eur': 'NES Classic Mini (EUR)', 'nes-jpn': 'Famicom Mini',
        'hvcj-jpn': 'Famicom Mini Shonen Jump', 'snes-usa': 'SNES Classic Mini (USA)',
        'snes-eur': 'Super Nintendo Mini (EUR)', 'snes-jpn': 'Super Famicom Mini',
      }[systemCode] || `Consola (${systemCode || 'desconocida'})`,
      syncPath,
      squashfs: kv.squashfs || '/var/squashfs',
      gamepath: kv.gamepath || '/usr/share/games',
      totalBytes: (parseInt(kv.total, 10) || 0) * 1024,
      freeBytes: (parseInt(kv.free, 10) || 0) * 1024,
      cores: (kv.cores || '').split(/\s+/).filter(Boolean),
      learned: learnEmulators(execs, consoleType),
    };
    this.info.supports = supportedSystems(consoleType, this.info.cores, this.info.learned);
    const summary = `Consola: ${systemCode} · emuladores RetroArch: ${this.info.cores.join(', ') || 'ninguno detectado'}`
      + ` · copiados de juegos existentes: ${Object.entries(this.info.learned).map(([k, v]) => `${k} → ${v.bin}`).join(', ') || 'ninguno'}`;
    if (summary !== this.lastSummary) console.log(summary);
    this.lastSummary = summary;
    return this.info;
  }

  async ensureInfo() {
    return this.info || this.detect();
  }

  /** Lista los juegos de todos los menús (000, 001, ...) de la carpeta de sincronización. */
  async listGames() {
    const info = await this.ensureInfo();
    const script = `
      cd ${q(info.syncPath)} 2>/dev/null || exit 0
      for f in [0-9][0-9][0-9]/CLV-*/CLV-*.desktop; do
        [ -f "$f" ] || continue
        echo "@@@ $f"
        sed -n '1,/^\\[Description\\]/p' "$f"
      done
    `;
    const out = await this.run(script);
    const games = [];
    const parts = out.split(/^@@@ /m).filter((s) => s.trim());
    for (const part of parts) {
      const nl = part.indexOf('\n');
      const file = part.slice(0, nl).trim();
      const [menu, dir] = file.split('/');
      const d = parseDesktop(part.slice(nl + 1));
      const code = d.code || dir;
      const isFolder = /\/bin\/chmenu/.test(d.exec || '');
      games.push({
        menu,
        code: dir,
        name: d.name || code,
        exec: d.exec || '',
        players: parseInt(d.players, 10) || 1,
        releaseDate: d.releasedate || '',
        publisher: d.sortrawpublisher || '',
        original: /^CLV-P-/.test(code),
        folder: isFolder,
      });
    }
    games.sort((a, b) => a.menu.localeCompare(b.menu) || a.name.localeCompare(b.name));
    return { info, games };
  }

  /** Devuelve el PNG de la carátula de un juego. */
  async getIcon(menu, code) {
    if (!MENU_RE.test(menu) || !CODE_RE.test(code)) throw new Error('Juego no válido');
    const key = `${menu}/${code}`;
    if (this.iconCache.has(key)) return this.iconCache.get(key);
    const info = await this.ensureInfo();
    const base = `${info.syncPath}/${menu}/${code}`;
    const script = `
      S=${q(info.syncPath)}; D=${q(base)}; C=${q(code)}; M=${q(menu)}
      ICON="$(sed -n 's/^Icon=//p' "$D/$C.desktop" | head -n 1)"
      case "$ICON" in /var/games/*) ICON="$S/$M/\${ICON#/var/games/}";; esac
      for f in "$ICON" "$D/$C.png" "$S/.storage/$C/$C.png" "$S/.storage/$C/$(basename "$ICON")"; do
        [ -n "$f" ] && [ -f "$f" ] && { cat "$f"; exit 0; }
      done
      exit 3
    `;
    const r = await this.shell.exec(script);
    if (r.code !== 0 || !r.stdout.length) return null;
    this.iconCache.set(key, r.stdout);
    return r.stdout;
  }

  // Detiene la interfaz y desmonta los juegos (como PrepareRemoteTransfer de hakchi2 CE).
  async uiStop() {
    await this.shell.exec(`uistop >/dev/null 2>&1; hakchi eval 'umount "$gamepath"' >/dev/null 2>&1; true`);
  }

  async uiStart() {
    await this.shell.exec('sync; hakchi overmount_games >/dev/null 2>&1; uistart >/dev/null 2>&1 &');
  }

  /**
   * Si el menú 000 aún no existe, copia los .desktop de los juegos de fábrica apuntando a la
   * memoria original (squashfs). Así no desaparecen al crear el menú personalizado.
   */
  seedOriginalsScript(info) {
    const src = `${info.squashfs}${info.gamepath}`;
    return `
      S=${q(info.syncPath)}; SRC=${q(src)}; GP=${q(info.gamepath)}; SQ=${q(info.squashfs)}
      if [ -z "$(ls -d "$S"/000/CLV-* 2>/dev/null)" ]; then
        mkdir -p "$S/000"
        for d in "$SRC"/CLV-*; do
          c="$(basename "$d")"
          [ -f "$d/$c.desktop" ] || continue
          mkdir -p "$S/000/$c"
          sed "s#$GP/#$SQ$GP/#g" "$d/$c.desktop" > "$S/000/$c/$c.desktop"
        done
        echo seeded
      fi
    `;
  }

  /**
   * Sube juegos preparados con roms.prepareGame. Cada uno puede traer cover (PNG) y small (PNG).
   */
  addGames(games) {
    return this.lock(async () => {
      const info = await this.detect();
      const needed = games.reduce((n, g) => n + g.romData.length + (g.cover?.length || 0) + (g.small?.length || 0) + 4096, 0);
      if (info.freeBytes && needed > info.freeBytes - 512 * 1024) {
        throw new Error(`No hay espacio suficiente en la consola: se necesitan ${(needed / 1048576).toFixed(1)} MB y quedan ${(info.freeBytes / 1048576).toFixed(1)} MB.`);
      }
      const entries = [];
      for (const g of games) {
        const dir = `000/${g.code}`;
        entries.push({ name: `${dir}/${g.romFile}`, data: g.romData });
        if (g.cover) entries.push({ name: `${dir}/${g.code}.png`, data: g.cover });
        if (g.small) entries.push({ name: `${dir}/${g.code}_small.png`, data: g.small });
        entries.push({ name: `${dir}/${g.code}.desktop`, data: Buffer.from(g.desktop, 'utf8') });
      }
      const tar = createTar(entries);
      await this.uiStop();
      let seeded = false;
      try {
        const out = await this.run(this.seedOriginalsScript(info));
        seeded = out.includes('seeded');
        const rmOld = games.map((g) => `rm -rf ${q(`${info.syncPath}/000/${g.code}`)}`).join('; ');
        await this.run(`${rmOld}; mkdir -p ${q(info.syncPath)} && tar -xf - -C ${q(info.syncPath)}`, tar);
      } finally {
        await this.uiStart();
        this.iconCache.clear();
      }
      await this.detect();
      return { added: games.map((g) => ({ code: g.code, name: g.name })), seededOriginals: seeded };
    });
  }

  deleteGame(menu, code) {
    if (!MENU_RE.test(menu) || !CODE_RE.test(code)) return Promise.reject(new Error('Juego no válido'));
    return this.lock(async () => {
      const info = await this.ensureInfo();
      await this.uiStop();
      try {
        // .storage solo se usa con la sincronización "enlazada" de hakchi2 CE.
        await this.run(`
          S=${q(info.syncPath)}; C=${q(code)}
          rm -rf "$S/"${q(menu)}"/$C"
          [ -n "$(ls -d "$S"/[0-9][0-9][0-9]/"$C" 2>/dev/null)" ] || rm -rf "$S/.storage/$C"
        `);
      } finally {
        await this.uiStart();
        this.iconCache.delete(`${menu}/${code}`);
      }
      await this.detect();
    });
  }

  renameGame(menu, code, newName) {
    if (!MENU_RE.test(menu) || !CODE_RE.test(code)) return Promise.reject(new Error('Juego no válido'));
    const name = String(newName || '').replace(/[\r\n]+/g, ' ').trim();
    if (!name) return Promise.reject(new Error('El nombre no puede estar vacío'));
    return this.lock(async () => {
      const info = await this.ensureInfo();
      const file = `${info.syncPath}/${menu}/${code}/${code}.desktop`;
      const text = await this.run(`cat ${q(file)}`);
      const updated = text
        .replace(/^Name=.*$/m, `Name=${name}`)
        .replace(/^SortRawTitle=.*$/m, `SortRawTitle=${name.toLowerCase()}`);
      await this.uiStop();
      try {
        await this.run(`cat > ${q(file)}`, Buffer.from(updated, 'utf8'));
      } finally {
        await this.uiStart();
      }
    });
  }

  reboot() {
    return this.shell.exec(`sync; (sleep 1; ${this.rebootCmd}) >/dev/null 2>&1 &`);
  }
}

module.exports = { Hakchi, buildDesktop };
