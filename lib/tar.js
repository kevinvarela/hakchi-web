// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
// Generador mínimo de archivos .tar (ustar) para enviar varios archivos en una sola
// transferencia a `tar -x` de busybox en la consola (igual que hace hakchi2 CE).

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name, size, type = '0', mode = 0o644, linkName = '') {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 99) {
    const i = name.lastIndexOf('/', 154);
    if (i <= 0 || Buffer.byteLength(name.slice(i + 1)) > 99) throw new Error(`Ruta demasiado larga: ${name}`);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  h.fill(' ', 148, 156); // checksum provisional
  h.write(type, 156, 'ascii');
  if (linkName) h.write(linkName, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('root', 265, 'ascii');
  h.write('root', 297, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/** entries: [{ name: 'dir/file', data: Buffer }] → Buffer .tar */
function createTar(entries) {
  const parts = [];
  const dirs = new Set();
  for (const e of entries) {
    const segs = e.name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/') + '/';
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(header(d, 0, '5', 0o755));
      }
    }
    if (e.link !== undefined) {
      parts.push(header(e.name, 0, '2', e.mode || 0o777, e.link));
      continue;
    }
    parts.push(header(e.name, e.data.length, '0', e.mode || 0o644));
    parts.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

module.exports = { createTar };
