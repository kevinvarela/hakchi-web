// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
// Lectura de .tar, .tar.gz (.hmod) y .zip sin dependencias externas.
const zlib = require('zlib');
const { createTar } = require('./tar');

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZip = (b) => b.length > 4 && b.readUInt32LE(0) === 0x04034b50;
const isTar = (b) => b.length >= 512 && b.toString('ascii', 257, 262) === 'ustar';

function cstr(buf, start, len) {
  const s = buf.slice(start, start + len);
  const z = s.indexOf(0);
  return s.slice(0, z < 0 ? s.length : z).toString('utf8');
}

/** Devuelve [{ name, type: 'file'|'dir'|'link', data, mode }] de un .tar */
function readTar(buf) {
  const out = [];
  let pos = 0;
  let longName = null;
  while (pos + 512 <= buf.length) {
    const h = buf.slice(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    let name = cstr(h, 0, 100);
    const prefix = h.toString('ascii', 257, 262) === 'ustar' ? cstr(h, 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8) || 0;
    const mode = parseInt(cstr(h, 100, 8).trim() || '0', 8) || 0o644;
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.slice(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'x' || type === 'g') continue; // cabeceras pax
    if (longName) { name = longName; longName = null; }
    name = name.replace(/^\.\//, '');
    if (!name || name === '.') continue;
    if (type === '5') out.push({ name: name.replace(/\/$/, ''), type: 'dir', mode });
    else if (type === '0' || type === '\0' || type === '7') out.push({ name, type: 'file', data, mode });
    else if (type === '2') out.push({ name, type: 'link', target: cstr(h, 157, 100), mode });
  }
  return out;
}

/** Devuelve [{ name, type, data, mode }] de un .zip (métodos "stored" y "deflate"). */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El .zip está dañado (no se encontró el índice).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('El .zip está dañado.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const unixMode = (ext >>> 16) & 0o7777;
    if (name.endsWith('/')) { out.push({ name: name.slice(0, -1), type: 'dir', mode: unixMode || 0o755 }); continue; }
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(lstart, lstart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`El .zip usa una compresión no soportada (método ${method}).`);
    const isLink = ((ext >>> 16) & 0o170000) === 0o120000;
    out.push(isLink ? { name, type: 'link', target: data.toString('utf8'), mode: 0o777 } : { name, type: 'file', data, mode: unixMode || 0o644 });
  }
  return out;
}

/** Lee cualquier archivo soportado y devuelve sus entradas. */
function readArchive(buf) {
  if (isGzip(buf)) {
    const inner = zlib.gunzipSync(buf);
    if (!isTar(inner) && !readTar(inner).length) throw new Error('El archivo comprimido no contiene un .tar.');
    return readTar(inner);
  }
  if (isZip(buf)) return readZip(buf);
  if (isTar(buf)) return readTar(buf);
  throw new Error('Formato no reconocido: se esperaba un .hmod (tar.gz), .tar o .zip.');
}

/**
 * Convierte el contenido de un módulo (.hmod, o un .zip/.tar con la carpeta del módulo) a un
 * .hmod válido (tar.gz) listo para que hakchi lo instale con `tar -xzf`.
 */
function toHmod(buf) {
  let entries = readArchive(buf).filter((e) => !e.name.split('/').includes('..') && !e.name.startsWith('/'));
  // Si todo está dentro de una única carpeta "algo.hmod/", la quitamos (zip de la carpeta del módulo).
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  if (tops.size === 1) {
    const top = [...tops][0];
    if (/\.hmod$/i.test(top) && entries.some((e) => e.name.startsWith(`${top}/`))) {
      entries = entries.filter((e) => e.name !== top).map((e) => ({ ...e, name: e.name.slice(top.length + 1) }));
    }
  }
  const files = entries.filter((e) => e.type === 'file' || e.type === 'link');
  if (!files.length) throw new Error('El módulo está vacío.');
  const readme = entries.find((e) => e.type === 'file' && /^readme(\.md|\.txt)?$/i.test(e.name));
  return {
    hmod: zlib.gzipSync(createTar(files.map((e) => ({ name: e.name, data: e.data, mode: e.mode, link: e.type === 'link' ? e.target : undefined })))),
    readme: readme ? readme.data.toString('utf8') : '',
    files: files.length,
  };
}

/** Front matter de los readme de módulos (--- Name: X ... ---), igual que HmodReadme. */
function parseReadme(text = '') {
  const m = /^(?:-{3,}[\r\n]+([\s\S]*?)[\r\n]*-{3,})?[\r\n\t\s]*([\s\S]*?)[\r\n\t\s]*$/.exec(text);
  const meta = {};
  for (const line of (m?.[1] || '').split(/\r?\n/)) {
    const mm = /^[\s\t]*([^:]+?)[\s\t]*:[\s\t]*(.*?)[\s\t]*$/.exec(line);
    if (mm && !(mm[1] in meta)) meta[mm[1]] = mm[2];
  }
  return { meta, body: (m?.[2] || '').trim() };
}

module.exports = { readTar, readZip, readArchive, toHmod, parseReadme, isGzip, isZip, isTar };
