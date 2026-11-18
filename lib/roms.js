// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
// Partes portadas de hakchi2 CE (GPL-3.0) — Alexey "Cluster" Avdyukhin y Team Shinkansen. Ver NOTICE.md.
'use strict';
// Procesamiento de ROMs portado de hakchi2 CE (Apps/NesGame.cs, Apps/SnesGame.cs,
// Apps/NesApplication.cs, Apps/DesktopFile.cs).

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Igual que NesApplication.GenerateCode: CLV-<prefijo>-XXXXX
function generateCode(crc, prefix) {
  const ch = (v) => String.fromCharCode(65 + (v % 26));
  return `CLV-${prefix}-${ch(crc)}${ch(crc >>> 5)}${ch(crc >>> 10)}${ch(crc >>> 15)}${ch(crc >>> 20)}`;
}

// Nombre "limpio" a partir del nombre de archivo, como hace hakchi.
function nameFromFilename(filename) {
  let name = filename.replace(/\.[^.]+$/, '');
  name = name.replace(/ ?\(.*?\)| ?\[.*?\]/g, '');
  return name.replace(/_/g, ' ').replace(/ {2,}/g, ' ').trim() || 'Juego';
}

function safeFileName(filename) {
  const ext = (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  let base = filename.slice(0, filename.length - ext.length);
  base = base.replace(/[^A-Za-z0-9 _.\-()!]/g, '').replace(/[ ()!]+/g, '_').replace(/_+/g, '_');
  base = base.replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || 'rom';
  return base + ext;
}

// ---------- NES ----------
const NES_ARGS = '--guest-overscan-dimensions 0,0,9,3 --initial-fadein-durations 10,2 --volume 75 --enable-armet';
const NES_BIN = '/bin/clover-kachikachi-wr';
const NES_SUPPORTED_MAPPERS = [0, 1, 2, 3, 4, 5, 7, 9, 10, 86, 87, 184];

function parseNes(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'NES\x1a') {
    throw new Error('No es una ROM de NES válida (falta la cabecera iNES).');
  }
  const flags6 = buf[6];
  const flags7 = buf[7];
  const nes2 = (flags7 & 0x0c) === 0x08;
  // Con cabeceras antiguas "sucias" (DiskDude!, etc.) se ignora el nibble alto.
  const dirty = !nes2 && buf.slice(12, 16).some((b) => b !== 0);
  const mapper = (flags6 >> 4) | (dirty ? 0 : flags7 & 0xf0);
  return {
    mapper,
    battery: (flags6 & 0x02) !== 0,
    trainer: (flags6 & 0x04) !== 0,
    fourScreen: (flags6 & 0x08) !== 0,
  };
}

// Emuladores de RetroArch (instalado con hakchi2 CE) para jugar un sistema que no es el de la consola.
// El orden es la preferencia: fceumm y snes9x son los que hakchi2 CE usa por defecto.
const RA_CORES = {
  nes: ['fceumm', 'nestopia', 'quicknes', 'mesen', 'nes'],
  snes: ['snes9x', 'snes9x2010', 'snes10', 'snes05', 'snes02', 'snes'],
};

/**
 * Aprende el emulador a partir de los Exec= de juegos que ya están en la consola: si un .nes
 * ya funciona en una SNES Mini, usamos exactamente el mismo comando para los nuevos.
 */
function learnEmulators(execs, consoleType) {
  const learned = {};
  for (const exec of execs) {
    const tokens = exec.split(/\s+/);
    const idx = tokens.findIndex((t) => t.startsWith('/') && /\.(nes|sfc|smc)$/i.test(t));
    if (idx <= 0) continue;
    const system = /\.nes$/i.test(tokens[idx]) ? 'nes' : 'snes';
    if (system === consoleType || learned[system]) continue;
    const bin = tokens.slice(0, idx).join(' ');
    learned[system] = { bin, args: tokens.slice(idx + 1).join(' '), label: bin.replace(/^\/(usr\/)?bin\//, '') };
  }
  return learned;
}
const CORE_CANDIDATES = [...RA_CORES.nes, ...RA_CORES.snes];
const SYSTEM_NAME = { nes: 'NES', snes: 'SNES' };

/** Elige el emulador: el original si el sistema coincide con la consola, si no RetroArch. */
function pickEmulator(system, consoleType, cores = [], learned = {}) {
  if (!consoleType || system === consoleType) return { native: true };
  if (learned[system]) return { native: false, learned: true, core: learned[system].label, bin: learned[system].bin, args: learned[system].args };
  const core = RA_CORES[system].find((c) => cores.includes(c));
  if (core) return { native: false, core, bin: `/bin/${core}` };
  // No se detectó el emulador: usamos lo mismo que escribe hakchi2 CE. Para NES es el lanzador
  // de hakchi (clover-kachikachi-wr), que busca él mismo el emulador disponible (/bin/nes, etc.).
  // No bloqueamos: la detección puede fallar y el usuario sabe si su consola lo ejecuta.
  const warning = `No pude confirmar qué emulador de ${SYSTEM_NAME[system]} tiene tu consola. Se configurará igual que lo hace hakchi2 CE; si no arranca, instala RetroArch con hakchi2 CE.`;
  return system === 'nes'
    ? { native: false, fallback: true, warning, core: 'lanzador de hakchi', bin: NES_BIN, args: NES_ARGS }
    : { native: false, fallback: true, warning, core: 'snes9x', bin: '/bin/snes9x', args: '' };
}

/** Sistemas que puede ejecutar la consola: el suyo y los que tenga en RetroArch. */
function supportedSystems(consoleType, cores = [], learned = {}) {
  return ['nes', 'snes'].filter((s) => s === consoleType || learned[s] || RA_CORES[s].some((c) => cores.includes(c)));
}

function processNes(buf, emu = { native: true }) {
  const info = parseNes(buf);
  const warnings = emu.warning ? [emu.warning] : [];
  if (emu.native) {
    if (!NES_SUPPORTED_MAPPERS.includes(info.mapper)) {
      warnings.push(`El mapper ${info.mapper} no está soportado por el emulador original (kachikachi). Puede que el juego no arranque.`);
    }
    if (info.fourScreen) warnings.push('Usa mirroring "four screen", que el emulador original no soporta.');
    if (info.trainer) warnings.push('La ROM tiene "trainer", que el emulador original puede no soportar.');
  }
  return {
    data: buf,
    crc: crc32(buf.slice(16)), // CRC sin cabecera, como NesFile.CRC32
    prefix: 'H',
    bin: emu.native ? NES_BIN : emu.bin,
    args: emu.native ? NES_ARGS : emu.args || '',
    ext: '.nes',
    saveCount: info.battery ? 3 : 0,
    warnings,
    details: `NES · mapper ${info.mapper}${info.battery ? ' · batería' : ''}${emu.native ? '' : emu.learned ? ` · igual que tus otros juegos de NES (${emu.core})` : ` · RetroArch (${emu.core})`}`,
  };
}

// ---------- SNES ----------
const SNES_ARGS = '--volume 100 -rollback-snapshot-period 600';
const SNES_BIN = '/bin/clover-canoe-shvc-wr -rom';
const LOROM = 0x14;
const HIROM = 0x15;
const SFX_TYPES = [0x13, 0x14, 0x15, 0x1a];
const DSP1_TYPES = [0x03, 0x05];
const SA1_TYPES = [0x34, 0x35];
const KNOWN_PRESETS = {
  'SUPER MARIOWORLD': 0x1011, 'F-ZERO': 0x1018, 'SUPER MARIO KART': 0x10bd, 'Super Metroid': 0x1040,
  'EARTH BOUND': 0x1070, "Kirby's Dream Course": 0x1058, 'DONKEY KONG COUNTRY': 0x1077,
  'KIRBY SUPER DELUXE': 0x109f, 'Super Punch-Out!!': 0x10a9, 'MEGAMAN X': 0x1109,
  "SUPER GHOULS'N GHOST": 0x1003, 'Street Fighter2 Turb': 0x1065, 'SUPER MARIO RPG': 0x109e,
  'FINAL FANTASY 3': 0x10dc, 'SUPER CASTLEVANIA 4': 0x1030, 'CONTRA3 THE ALIEN WA': 0x1036,
  'STAR FOX': 0x1242, 'STARFOX2': 0x123c, 'SHVC FIREEMBLEM': 0x102b, 'SUPER DONKEY KONG': 0x1023,
  'ROCKMAN X': 0x110a, 'CHOHMAKAIMURA': 0x1004, 'SeikenDensetsu 2': 0x10b2, 'FINAL FANTASY 6': 0x10dd,
  'CONTRA SPIRITS': 0x1037, 'ganbare goemon': 0x1048, 'SUPER FORMATION SOCC': 0x1240,
  "YOSSY'S ISLAND": 0x1243, 'FINAL FIGHT': 0x100e, "DIDDY'S KONG QUEST": 0x105d,
  'BREATH OF FIRE 2': 0x1068, 'FINAL FIGHT 2': 0x10e1, 'MEGAMAN X2': 0x1117, 'FINAL FIGHT 3': 0x10e3,
  'GENGHIS KHAN 2': 0x10c4, 'CASTLEVANIA DRACULA': 0x1131, 'STREET FIGHTER ALPHA': 0x10df,
  'MEGAMAN 7': 0x113a, 'MEGAMAN X3': 0x113d, 'Breath of Fire': 0x1144,
};
const PROBLEM_GAMES = new Set([
  'ActRaiser-2 USA', 'ALIEN vs. PREDATOR', 'ASTERIX', 'BATMAN--REVENGE JOKER', 'CHAMPIONSHIP POOL',
  'ClayFighter 2', 'CLOCK TOWER SFX', 'COOL WORLD', 'CRYSTAL BEANS', 'CYBER KNIGHT 2', 'ASCII DARK LAW',
  'DIRT TRAX FX', 'DBZ HYPER DIMENSION', 'DRAGON BALL Z HD', 'DRAGONBALL Z 2', 'SFX DRAGONBALLZ2',
  'SFX SUPERBUTOUDEN2', 'DUNGEON MASTER', 'EARTHWORM JIM 2', 'F1 WORLD CHAMP EDTION', 'FACEBALL 2000',
  'THE FIREMEN     PAL', "HAMMERIN' HARRY (JPN)", 'HARMELUNNOBAIOLINHIKI', 'HOME ALONE', 'HUMAN GRANDPRIX',
  'HUMAN GRANDPRIX 3', 'ILLUSION OF GAIA USA', 'ILLUSION OF TIME ENG', 'JumpinDerby',
  'KRUSTYS SUPERFUNHOUSE', "Mario's Time Machine", 'MARKOS MAGIC FOOTBALL', 'POWER RANGERS FIGHT',
  'MOMOTETSU HAPPY', 'NHL HOCKEY 1998', 'RENDERING RANGER R2', 'ROBOTREK 1 USA', 'ROMANCING SAGA3',
  'SECRET OF EVERMORE', 'SIM CITY 2000', 'SMASH TENNIS', 'Star Ocean', 'STREET FIGHTER ALPHA2',
  'SUPER BASES LOADED 2', 'PANIC BOMBER WORLD', 'TALES OF PHANTASIA', 'TERRANIGMA P', 'TOP GEAR 3000',
  'UNIRACERS', "WARIO'S WOODS", 'WORLD CLASS RUGBY', 'WORLD CUP STRIKER', 'WORLD MASTERS GOLF',
  'WWF SUPER WRESTLEMANI', 'WRESTLEMANIA',
]);

function readSnesHeader(buf, pos) {
  if (buf.length < pos + 32) return null;
  const titleBytes = buf.slice(pos, pos + 21);
  let title = '';
  if (!titleBytes.includes(0) && !titleBytes.includes(0xff) && titleBytes[0] !== 0x20) {
    title = titleBytes.toString('latin1').replace(/ +$/, '');
  }
  return {
    title,
    romMakeup: buf[pos + 21],
    romType: buf[pos + 22],
    sramSize: buf[pos + 24],
    checksumComplement: buf.readUInt16LE(pos + 28),
    checksum: buf.readUInt16LE(pos + 30),
  };
}

function detectSnesHeader(rom) {
  const lo = readSnesHeader(rom, 0x7fc0);
  const hi = readSnesHeader(rom, 0xffc0);
  if (!lo && !hi) throw new Error('La ROM de SNES es demasiado pequeña o está dañada.');
  const ok = (h) => h && (h.checksum ^ 0xffff) === h.checksumComplement && h.checksum !== 0 && h.checksumComplement !== 0;
  const okLoose = (h) => h && (h.checksum ^ 0xffff) === h.checksumComplement;
  const printable = (s) => [...s].every((c) => c.charCodeAt(0) >= 31 && c.charCodeAt(0) <= 127);
  let type;
  if (okLoose(lo) && !ok(hi)) type = LOROM;
  else if (!ok(lo) && okLoose(hi)) type = HIROM;
  else if (lo && hi && lo.title && !hi.title) type = LOROM;
  else if (lo && hi && !lo.title && hi.title) type = HIROM;
  else if (lo && hi && lo.title === hi.title && (lo.romMakeup & 1) === 0) type = LOROM;
  else if (lo && hi && lo.title === hi.title && (hi.romMakeup & 1) === 1) type = HIROM;
  else if (!hi) type = LOROM;
  else {
    const l = printable(lo.title);
    const h = printable(hi.title);
    if (l && !h) type = LOROM;
    else if (!l && h) type = HIROM;
    else throw new Error('No se pudo detectar el tipo de ROM (LoROM/HiROM); parece estar dañada.');
  }
  const header = type === LOROM ? lo : hi;
  return { type, header, title: header.title };
}

function makeSfrom(rom) {
  const { type, header, title } = detectSnesHeader(rom);
  let presetId = 0;
  let chip = 0;
  if (SFX_TYPES.includes(header.romType)) chip = 0x0c;
  if (Object.prototype.hasOwnProperty.call(KNOWN_PRESETS, title)) {
    presetId = KNOWN_PRESETS[title];
  } else {
    if (DSP1_TYPES.includes(header.romType)) presetId = 0x10bd;
    if (SA1_TYPES.includes(header.romType)) presetId = 0x109c;
  }
  const H1 = 48;
  const H2 = 48;
  const romSize = rom.length;
  const fileSize = romSize + H1 + H2;
  const romEnd = H1 + romSize;

  const h1 = Buffer.alloc(H1);
  h1.writeUInt32LE(0x100, 0x00);
  h1.writeUInt32LE(fileSize, 0x04);
  h1.writeUInt32LE(0x30, 0x08);
  h1.writeUInt32LE(romEnd, 0x0c);
  h1.writeUInt32LE(fileSize, 0x10); // FooterStart
  h1.writeUInt32LE(romEnd, 0x14); // Header2
  h1.writeUInt32LE(fileSize, 0x18); // Header3
  h1.writeUInt32LE(0, 0x1c);
  h1.writeUInt32LE(romEnd + 27, 0x20); // Flags
  h1.write('WUP-XXXX', 0x24, 'ascii');
  h1.writeUInt32LE(0, 0x2c);

  const h2 = Buffer.alloc(H2);
  h2.writeUInt8(60, 0x00); // FPS
  h2.writeUInt32LE(romSize, 0x01);
  h2.writeUInt32LE(0, 0x05); // PCM size
  h2.writeUInt32LE(0, 0x09); // Footer size
  h2.writeUInt16LE(presetId, 0x0d);
  h2.writeUInt8(2, 0x0f); // Max controllers
  h2.writeUInt8(0x5a, 0x10); // Volume
  h2.writeUInt8(type, 0x11);
  h2.writeUInt32LE(chip, 0x12);
  h2.writeUInt32LE(1, 0x1b);
  h2.writeUInt32LE(1, 0x1f);

  return {
    data: Buffer.concat([h1, rom, h2]),
    title,
    type,
    sram: header.sramSize > 0,
    problem: PROBLEM_GAMES.has(title),
    presetId,
    chip,
  };
}

function processSnes(buf, ext, emu = { native: true }) {
  const warnings = emu.warning ? [emu.warning] : [];
  if (!emu.native) {
    if (ext === '.sfrom') {
      throw new Error('Los archivos .sfrom solo funcionan con el emulador original de la SNES Mini. Usa la ROM en formato .sfc o .smc.');
    }
    const rom = buf.length % 1024 !== 0 ? buf.slice(512) : buf;
    let title = '';
    let sram = false;
    try {
      const h = detectSnesHeader(rom);
      title = h.title;
      sram = h.header.sramSize > 0;
    } catch (e) {
      warnings.push('No se pudo leer la cabecera de la ROM; puede estar dañada.');
    }
    return {
      data: rom, crc: crc32(rom), prefix: 'U', bin: emu.bin, args: emu.args || '', ext: '.sfc',
      saveCount: sram ? 3 : 0, warnings,
      details: `SNES${title ? ` · "${title}"` : ''}${sram ? ' · SRAM' : ''} · ${emu.learned ? `igual que tus otros juegos de SNES (${emu.core})` : `RetroArch (${emu.core})`}`,
    };
  }
  if (ext === '.sfrom') {
    return {
      data: buf, crc: crc32(buf), prefix: 'U', bin: SNES_BIN, args: SNES_ARGS, ext: '.sfrom',
      saveCount: 3, warnings, details: 'SNES · .sfrom (sin conversión)',
    };
  }
  let rom = buf;
  if (rom.length % 1024 !== 0) rom = rom.slice(512); // quitar cabecera de copiador (SMC)
  const crc = crc32(rom);
  const s = makeSfrom(rom);
  if (s.problem) {
    warnings.push('Este juego aparece en la lista de juegos problemáticos con el emulador original (canoe). Puede fallar o tener errores gráficos/sonido.');
  }
  return {
    data: s.data, crc, prefix: 'U', bin: SNES_BIN, args: SNES_ARGS, ext: '.sfrom',
    saveCount: s.sram ? 3 : 0, warnings,
    details: `SNES · ${s.type === LOROM ? 'LoROM' : 'HiROM'}${s.title ? ` · "${s.title}"` : ''}${s.sram ? ' · SRAM' : ''}${s.chip ? ' · Super FX' : ''}`,
  };
}

const NES_EXTS = ['.nes'];
const SNES_EXTS = ['.sfc', '.smc', '.sfrom'];

function systemForExt(ext) {
  if (NES_EXTS.includes(ext)) return 'nes';
  if (SNES_EXTS.includes(ext)) return 'snes';
  return null;
}

/**
 * Prepara un juego para subirlo. Devuelve el código CLV, los archivos y el .desktop.
 * `consoleType` es "nes" o "snes" (tipo de la consola conectada).
 */
function prepareGame({ filename, data, name, consoleType, cores = [], learned = {}, players = 1, simultaneous = false, publisher = '', releaseDate = '' }) {
  const ext = (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const system = systemForExt(ext);
  if (!system) throw new Error(`Formato no soportado: "${ext || 'sin extensión'}". Usa .nes, .sfc, .smc o .sfrom.`);
  const emu = pickEmulator(system, consoleType, cores, learned);
  const r = system === 'nes' ? processNes(data, emu) : processSnes(data, ext, emu);
  const code = generateCode(r.crc, r.prefix);
  const romFile = safeFileName(filename).replace(/\.[^.]+$/, '') + r.ext;
  const gameName = (name && name.trim()) || nameFromFilename(filename);
  const desktop = buildDesktop({
    code, name: gameName, exec: `${r.bin} /var/games/${code}/${romFile} ${r.args}`,
    saveCount: r.saveCount, players, simultaneous, publisher, releaseDate,
  });
  return { code, name: gameName, system, romFile, romData: r.data, desktop, warnings: r.warnings, details: r.details, emulator: emu.native ? 'original' : emu.core };
}

function cleanLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// Igual que DesktopFile.GetConfig (con snesExtraFields = false), en modo sync no enlazado.
function buildDesktop({ code, name, exec, saveCount = 0, players = 1, simultaneous = false, publisher = '', releaseDate = '' }) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(releaseDate) ? releaseDate : '1900-01-01';
  const pl = Math.min(Math.max(parseInt(players, 10) || 1, 1), 4);
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Exec=${cleanLine(exec)}`,
    `Path=/var/saves/${code}`,
    `Name=${cleanLine(name)}`,
    'CePrefix=',
    `Icon=/var/games/${code}/${code}.png`,
    '',
    '[X-CLOVER Game]',
    `Code=${code}`,
    'TestID=777',
    'ID=0',
    `Players=${pl}`,
    `Simultaneous=${simultaneous && pl > 1 ? 1 : 0}`,
    `ReleaseDate=${date}`,
    `SaveCount=${saveCount}`,
    `SortRawTitle=${cleanLine(name).toLowerCase()}`,
    `SortRawPublisher=${(cleanLine(publisher) || 'UNKNOWN').toUpperCase()}`,
    'Copyright=hakchi2 CE ©2017 Alexey \'Cluster\' Avdyukhin',
    '',
    '[m2engage]',
    'regionTag=',
    'sortRawGenre=',
    'index=',
    'demo_time=',
    'country=',
    '',
    '[Description]',
    'Text = ',
    '',
  ].join('\n');
}

function parseDesktop(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '[Description]') break;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

module.exports = {
  crc32, generateCode, nameFromFilename, safeFileName, parseNes, makeSfrom, detectSnesHeader,
  prepareGame, buildDesktop, parseDesktop, systemForExt, pickEmulator, supportedSystems, learnEmulators, CORE_CANDIDATES,
};
