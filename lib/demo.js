// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
// Crea una "consola" simulada en una carpeta local para probar la app sin hardware.
const fs = require('fs');
const path = require('path');
const { buildDesktop } = require('./roms');

// PNG 1x1 gris
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC',
  'base64'
);

function setupDemo(root, system = 'snes') {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const gamepath = system === 'snes' ? '/usr/share/games' : '/usr/share/games/nes/kachikachi';
  const sftype = system === 'snes' ? 'snes' : 'nes';

  fs.writeFileSync(path.join(bin, 'hakchi'), `#!/bin/sh
R=${JSON.stringify(root)}
sftype=${sftype}; sfregion=usa; cfg_separate_games=y; gamepath=${gamepath}; installpath="$R/var/lib/hakchi"
umount() { :; }
case "$1" in
  eval) shift; eval "$*" ;;
  findGameSyncStorage) mkdir -p "$R/var/lib/hakchi/games"; echo "$R/var/lib/hakchi/games" ;;
  get) case "$2" in squashfs) echo "$R/var/squashfs" ;; gamepath) echo "$gamepath" ;; esac ;;
  overmount_games) : ;;
  pack_list) for f in "$installpath"/hmod/uninstall-*; do [ -e "$f" ] && echo "\${f##*/uninstall-}"; done ;;
esac
`, { mode: 0o755 });
  // Reinicio simulado: aplica los módulos pendientes como haría hakchi al arrancar.
  fs.writeFileSync(path.join(bin, 'demo-reboot'), `#!/bin/sh
IP=${JSON.stringify(root)}/var/lib/hakchi; T="$IP/transfer"
mkdir -p "$IP/hmod"
[ -f "$T/uninstall" ] && for m in $(cat "$T/uninstall"); do rm -f "$IP/hmod/uninstall-$m"; done
for f in "$T"/*.hmod; do [ -e "$f" ] && touch "$IP/hmod/uninstall-$(basename "$f" .hmod)"; done
rm -rf "$T"
`, { mode: 0o755 });
  // Emulador de RetroArch simulado para el otro sistema (como si RetroArch estuviera instalado).
  const extra = process.env.DEMO_NO_RETROARCH ? [] : [system === 'snes' ? 'fceumm' : 'snes9x'];
  for (const f of ['uistop', 'uistart', ...extra]) fs.writeFileSync(path.join(bin, f), '#!/bin/sh\n:\n', { mode: 0o755 });

  // Juegos "de fábrica" simulados
  const originals = system === 'snes'
    ? [['CLV-P-SAAAE', 'Super Mario World'], ['CLV-P-SAABE', 'F-ZERO'], ['CLV-P-SAACE', 'The Legend of Zelda: A Link to the Past']]
    : [['CLV-P-NAAAE', 'Super Mario Bros.'], ['CLV-P-NAABE', 'The Legend of Zelda'], ['CLV-P-NAACE', 'Metroid']];
  for (const [code, name] of originals) {
    const dir = path.join(root, 'var/squashfs', gamepath, code);
    fs.mkdirSync(dir, { recursive: true });
    const desktop = buildDesktop({
      code, name, exec: `/usr/bin/clover-emu ${gamepath}/${code}/${code}.rom`,
    })
      .replace(`Path=/var/saves/${code}`, `Path=/var/lib/clover/profiles/0/${code}`)
      .replace(`Icon=/var/games/${code}/${code}.png`, `Icon=${gamepath}/${code}/${code}.png`);
    fs.writeFileSync(path.join(dir, `${code}.desktop`), desktop);
    fs.writeFileSync(path.join(dir, `${code}.png`), PNG);
  }
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

module.exports = { setupDemo };
