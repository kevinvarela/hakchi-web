// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
// Basado en el comportamiento de hakchi / hakchi2 CE (GPL-3.0). Ver NOTICE.md.
'use strict';
// Gestión de módulos de hakchi (.hmod).
//
// Se usa el mecanismo de arranque de hakchi (preinit p7080_hmods): los .hmod que estén en
// "$installpath/transfer" se instalan, y los nombres listados en "$installpath/transfer/uninstall"
// se desinstalan, la próxima vez que la consola arranca. Después hakchi reinicia otra vez solo.
// No usa el modo FEL/memboot de hakchi2 CE.
const crypto = require('crypto');
const zlib = require('zlib');
const { q } = require('./shell');
const { readTar, toHmod, parseReadme } = require('./archive');

const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const DEFAULT_HUB = 'https://hakchi.net/KMFDManic/NESC-SNESC-Modifications/.repo/';

/**
 * Convierte el readme (Markdown/HTML) de un módulo en texto plano y extrae la primera imagen.
 * Las URLs de imágenes y enlaces se conservan intactas (antes se rompían al quitar "_" y "*").
 */
function summarizeReadme(body, baseUrl) {
  let image = null;
  const take = (src) => {
    if (image || !src) return;
    try {
      const u = new URL(src.trim().replace(/^<|>$/g, ''), baseUrl);
      if (u.protocol === 'https:' || u.protocol === 'http:') image = u.href;
    } catch { /* URL no válida */ }
  };
  // Primero decodificar entidades (&lt;img src=&quot;...&quot;&gt;): si se hace al final, aparecen
  // etiquetas <img> nuevas después de haberlas quitado y se ven rotas en la descripción.
  let t = decodeEntities(decodeEntities(String(body || '')));
  // Imágenes HTML y Markdown en el orden en que aparecen.
  t = t.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)[^>]*>|!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/gi,
    (_, html, md) => { take(html || md); return ' '; });
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [texto](url) -> texto
  t = t.replace(/<[^>]*>?/g, ' '); // resto de etiquetas HTML (también las que quedaron sin cerrar)
  t = t.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, ''); // títulos, citas, listas
  t = t.replace(/(\*\*|__|\*|`+|~~)(?=\S)([\s\S]*?\S)\1/g, '$2'); // negrita, cursiva, código
  t = t.replace(/(^|[\s(])_(?=\S)([^_]*?\S)_(?=[\s.,;:!?)]|$)/g, '$1$2'); // _cursiva_ (sin tocar nombres_con_guiones)
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim(); // ningún resto de etiqueta en el texto
  return { description: t.length > 280 ? `${t.slice(0, 277)}…` : t, image };
}

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
    hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿',
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
    Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return named[e] ?? named[e.toLowerCase()] ?? m;
  });
}

function cleanModName(name) {
  return String(name).replace(/\.hmod$/i, '').replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 80);
}

class Mods {
  constructor(hakchi, { hubUrl = process.env.HAKCHI_MODHUB_URL || DEFAULT_HUB } = {}) {
    this.hakchi = hakchi;
    // Igual que hakchi2 CE: la URL del repositorio siempre termina en "/.repo/".
    const u = hubUrl.endsWith('/') ? hubUrl : `${hubUrl}/`;
    this.hubUrl = u.endsWith('/.repo/') ? u : `${u}.repo/`;
    this.hub = null;
    this.hubTime = 0;
  }

  // Carpeta de transferencia, igual que la calcula hakchi al arrancar.
  transferScript() {
    return `
      IP="$(hakchi eval 'echo "$installpath"')"; [ -n "$IP" ] || IP=/var/lib/hakchi
      T="$IP/transfer"; [ -d /media/hakchi/transfer ] && T=/media/hakchi/transfer
    `;
  }

  async list() {
    const out = await this.hakchi.run(`
      ${this.transferScript()}
      echo "@transfer $T"
      hakchi pack_list 2>/dev/null | while read m; do [ -n "$m" ] && echo "@installed $m"; done
      for f in "$T"/*.hmod; do [ -e "$f" ] && echo "@pending $(basename "$f" .hmod)"; done
      [ -f "$T/uninstall" ] && for m in $(cat "$T/uninstall"); do echo "@remove $m"; done
      df -Pk "$IP" 2>/dev/null | tail -n 1 | awk '{print "@free " $4}'
      true
    `);
    const r = { transfer: '', installed: [], pendingInstall: [], pendingRemove: [], freeBytes: 0 };
    for (const line of out.split('\n')) {
      const [tag, ...rest] = line.trim().split(' ');
      const v = rest.join(' ').trim();
      if (tag === '@transfer') r.transfer = v;
      else if (tag === '@installed') r.installed.push(v);
      else if (tag === '@pending') r.pendingInstall.push(v);
      else if (tag === '@remove') r.pendingRemove.push(v);
      else if (tag === '@free') r.freeBytes = (parseInt(v, 10) || 0) * 1024;
    }
    r.installed.sort((a, b) => a.localeCompare(b));
    return r;
  }

  /** Deja un .hmod listo para instalarse en el próximo arranque. */
  stage(name, buffer) {
    const mod = cleanModName(name);
    if (!NAME_RE.test(mod)) return Promise.reject(new Error('Nombre de módulo no válido.'));
    const { hmod, readme, files } = toHmod(buffer);
    return this.hakchi.lock(async () => {
      const st = await this.list();
      if (st.freeBytes && hmod.length > st.freeBytes - 1024 * 1024) {
        throw new Error(`No hay espacio suficiente en la consola para este módulo (${(hmod.length / 1048576).toFixed(1)} MB).`);
      }
      await this.hakchi.run(`
        ${this.transferScript()}
        mkdir -p "$T" && cat > "$T/"${q(`${mod}.hmod`)}
        [ -f "$T/uninstall" ] && { grep -vx ${q(mod)} "$T/uninstall" > "$T/uninstall.tmp"; mv "$T/uninstall.tmp" "$T/uninstall"; [ -s "$T/uninstall" ] || rm -f "$T/uninstall"; }
        true
      `, hmod);
      const { meta } = parseReadme(readme);
      return { name: mod, title: meta.Name || mod, files, size: hmod.length };
    });
  }

  /** Marca un módulo instalado para desinstalarlo en el próximo arranque. */
  markRemove(name) {
    if (!NAME_RE.test(name)) return Promise.reject(new Error('Nombre de módulo no válido.'));
    return this.hakchi.lock(() => this.hakchi.run(`
      ${this.transferScript()}
      mkdir -p "$T"
      grep -qx ${q(name)} "$T/uninstall" 2>/dev/null || echo ${q(name)} >> "$T/uninstall"
    `));
  }

  /** Cancela un cambio pendiente (instalación o desinstalación). */
  cancel(name) {
    if (!NAME_RE.test(name)) return Promise.reject(new Error('Nombre de módulo no válido.'));
    return this.hakchi.lock(() => this.hakchi.run(`
      ${this.transferScript()}
      rm -f "$T/"${q(`${name}.hmod`)}
      if [ -f "$T/uninstall" ]; then
        grep -vx ${q(name)} "$T/uninstall" > "$T/uninstall.tmp"; mv "$T/uninstall.tmp" "$T/uninstall"
        [ -s "$T/uninstall" ] || rm -f "$T/uninstall"
      fi
      rmdir "$T" 2>/dev/null; true
    `));
  }

  /** Reinicia la consola para que hakchi aplique los cambios al arrancar. */
  async apply() {
    const st = await this.list();
    if (!st.pendingInstall.length && !st.pendingRemove.length) throw new Error('No hay cambios pendientes.');
    await this.hakchi.reboot();
    this.hakchi.info = null;
    return st;
  }

  // ---------- Mod Hub (el mismo repositorio que usa hakchi2 CE) ----------
  async fetchHub(force = false) {
    if (this.hub && !force && Date.now() - this.hubTime < 30 * 60 * 1000) return this.hub;
    let res;
    try {
      res = await fetch(`${this.hubUrl}pack.tgz`, { signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`No se pudo descargar la lista del Mod Hub (${this.hubUrl}). Comprueba tu conexión a internet. (${e.cause?.code || e.message})`);
    }
    if (!res.ok) throw new Error(`El Mod Hub respondió con un error (${res.status}).`);
    const entries = readTar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
    const items = new Map();
    let list = null;
    for (const e of entries) {
      if (e.type !== 'file') continue;
      if (/^list$/i.test(e.name)) { list = e.data.toString('utf8').split(/[\r\n]+/).filter(Boolean); continue; }
      const m = /^([^/]+)\/(extract|link|md5|sha1|readme(?:\.(?:md|txt))?)$/i.exec(e.name);
      if (!m) continue;
      const key = m[1];
      const it = items.get(key) || { file: key };
      const val = e.data.toString('utf8').trim();
      const field = m[2].toLowerCase();
      if (field === 'extract') it.extract = true;
      else if (field === 'link') it.url = val;
      else if (field === 'md5') it.md5 = val.toLowerCase();
      else if (field === 'sha1') it.sha1 = val.toLowerCase();
      else it.readme = val;
      items.set(key, it);
    }
    const out = [];
    for (const it of items.values()) {
      if (list && !list.includes(it.file)) continue;
      if (!/\.hmod$/i.test(it.file) || !it.url) continue; // solo módulos (no juegos .clvg)
      const { meta, body } = parseReadme(it.readme || '');
      const name = cleanModName(it.file);
      const { description, image } = summarizeReadme(body, `${this.hubUrl}${encodeURIComponent(it.file)}/`);
      out.push({
        id: it.file, name, title: meta.Name || name, category: meta.Category || 'Otros',
        version: meta.Version || '', creator: meta.Creator || '', system: meta['Emulated System'] || '',
        description, image,
        url: it.url, md5: it.md5, sha1: it.sha1, extract: !!it.extract,
      });
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
    this.hub = out;
    this.hubTime = Date.now();
    return out;
  }

  /** Descarga un módulo del Mod Hub, lo verifica y lo deja listo para instalar. */
  async installFromHub(id) {
    const hub = await this.fetchHub();
    const item = hub.find((x) => x.id === id);
    if (!item) throw new Error('Ese módulo no está en el Mod Hub.');
    let res;
    try {
      res = await fetch(item.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    } catch (e) {
      throw new Error(`No se pudo descargar "${item.title}": ${e.cause?.code || e.message}`);
    }
    if (!res.ok) throw new Error(`No se pudo descargar "${item.title}" (error ${res.status}).`);
    const data = Buffer.from(await res.arrayBuffer());
    if (item.md5 && crypto.createHash('md5').update(data).digest('hex') !== item.md5) {
      throw new Error(`La descarga de "${item.title}" está dañada (no coincide el MD5). Inténtalo de nuevo.`);
    }
    if (item.sha1 && crypto.createHash('sha1').update(data).digest('hex') !== item.sha1) {
      throw new Error(`La descarga de "${item.title}" está dañada (no coincide el SHA1). Inténtalo de nuevo.`);
    }
    try {
      return await this.stage(item.name, data);
    } catch (e) {
      if (/Formato no reconocido|compresión no soportada/.test(e.message)) {
        throw new Error(`"${item.title}" viene en un formato que esta app no sabe abrir (por ejemplo .7z). Descárgalo de ${item.url}, conviértelo y súbelo con "Subir .hmod".`);
      }
      throw e;
    }
  }
}

module.exports = { Mods, cleanModName, summarizeReadme };
