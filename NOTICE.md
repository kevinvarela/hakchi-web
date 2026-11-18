# Avisos y créditos

**hakchi web** — Copyright (C) 2026 Kevin Varela ([@kevinvarela](https://github.com/kevinvarela))

Este programa es software libre: puedes redistribuirlo y/o modificarlo bajo los términos de la
Licencia Pública General GNU (GPL) publicada por la Free Software Foundation, versión 3 o
(a tu elección) cualquier versión posterior. Se distribuye SIN NINGUNA GARANTÍA. Consulta el
archivo [LICENSE](LICENSE).

## Código derivado de terceros

Partes de este proyecto están portadas a JavaScript desde código GPL-3.0 de otros proyectos.
Gracias a sus autores:

| Proyecto | Licencia | Qué se usa |
|---|---|---|
| [hakchi2 CE](https://github.com/TeamShinkansen/Hakchi2-CE) — Alexey "Cluster" Avdyukhin, Team Shinkansen y colaboradores | GPL-3.0 | Formato de los archivos `.desktop`, códigos `CLV-X-XXXXX`, conversión de ROMs de SNES a `.sfrom` (cabeceras, presets y lista de juegos problemáticos), argumentos de los emuladores, rutas de sincronización y formato del Mod Hub (`lib/roms.js`, `lib/hakchi.js`, `lib/mods.js`). |
| [hakchi](https://github.com/ClusterM/hakchi) — Alexey "Cluster" Avdyukhin, madmonkey y colaboradores | GPL-3.0 | Comportamiento de los scripts de la consola que esta app invoca: `overmount_games`, `findGameSyncStorage`, instalación de módulos al arrancar, red USB (`lib/hakchi.js`, `lib/mods.js`, `lib/detect.js`). |

## Dependencias

| Paquete | Licencia |
|---|---|
| [express](https://expressjs.com/) | MIT |
| [multer](https://github.com/expressjs/multer) | MIT |
| [ssh2](https://github.com/mscdex/ssh2) | MIT |

## Marcas

Nintendo, NES, Super Nintendo, SNES, Famicom y Super Famicom son marcas registradas de Nintendo.
Este proyecto no está afiliado, patrocinado ni aprobado por Nintendo. RetroArch es una marca de
sus respectivos propietarios.
