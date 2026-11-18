// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
const $ = (s) => document.querySelector(s);
const state = { info: null, games: [], queue: [], coverTarget: null };

// ---------- utilidades ----------
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), isErr ? 6000 : 3000);
}
function busy(text) {
  $('#busyText').textContent = text || '';
  $('#busy').hidden = !text;
}
async function api(path, opts = {}) {
  // La cabecera X-Hakchi-Web protege la API frente a peticiones de otras webs (ver server.js).
  const res = await fetch(path, { ...opts, headers: { 'X-Hakchi-Web': '1', ...(opts.headers || {}) } });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const body = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || `Error ${res.status}`);
  return body;
}
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- carátulas (se redimensionan en el navegador) ----------
function canvasToBlob(c) {
  return new Promise((r) => c.toBlob(r, 'image/png'));
}
function fit(img, maxW, maxH) {
  const s = Math.min(maxW / img.width, maxH / img.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
// Carátula por defecto: tamaño máximo de hakchi (228x204) con el nombre del juego.
function defaultCover(name, system) {
  const c = document.createElement('canvas');
  c.width = 228; c.height = 204;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 204);
  if (system === 'snes') { g.addColorStop(0, '#5d4bb3'); g.addColorStop(1, '#2c2266'); }
  else { g.addColorStop(0, '#c8312f'); g.addColorStop(1, '#6e1414'); }
  ctx.fillStyle = g; ctx.fillRect(0, 0, 228, 204);
  ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, 150, 228, 54);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillText(system === 'snes' ? 'SUPER NINTENDO' : 'NINTENDO', 14, 182);
  ctx.font = 'bold 20px system-ui, sans-serif';
  const words = name.split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > 200 && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  lines.slice(0, 5).forEach((l, i) => ctx.fillText(l, 14, 32 + i * 25));
  return c;
}
async function makeCovers(item) {
  let full;
  if (item.coverFile) {
    const img = await createImageBitmap(item.coverFile);
    full = fit(img, 228, 204);
  } else {
    full = defaultCover(item.name || 'Juego', item.system);
  }
  const small = fit(full, 40, 40);
  return { cover: await canvasToBlob(full), small: await canvasToBlob(small), preview: full.toDataURL() };
}

// ---------- estado de la consola ----------
// ---------- pantalla previa: comprobación de la consola ----------
let checkTimer = null;
function showCheck(r) {
  $('#check').hidden = false; $('#app').hidden = true;
  $('#checkIcon').dataset.state = r.state;
  $('#checkTitle').textContent = r.title;
  $('#checkText').textContent = r.text || '';
  $('#checkCommand').hidden = !r.command;
  $('#checkCode').textContent = r.command || '';
  $('#checkSteps').hidden = !r.steps?.length;
  $('#checkSteps').innerHTML = (r.steps || []).map((x) => `<li>${esc(x)}</li>`).join('');
  $('#checkHint').hidden = !r.hint;
  $('#checkHint').textContent = r.hint || '';
  $('#checkDetail').hidden = !r.detail;
  $('#checkDetailText').textContent = r.detail || '';
}
function scheduleCheck() {
  clearTimeout(checkTimer);
  let left = 8;
  const tick = () => {
    if (!$('#app').hidden) return;
    if (left <= 0) { connect(); return; }
    $('#autoCheck').textContent = `Se vuelve a comprobar en ${left} s`;
    left -= 1;
    checkTimer = setTimeout(tick, 1000);
  };
  tick();
}
$('#copyCmd').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#checkCode').textContent); toast('Comando copiado'); }
  catch { toast('No se pudo copiar; selecciónalo y cópialo a mano', true); }
});

async function connect() {
  clearTimeout(checkTimer);
  const st = $('#status');
  st.className = 'status'; $('#statusText').textContent = 'Comprobando…';
  $('#autoCheck').textContent = 'Comprobando…';
  let r;
  try {
    r = await api('/api/check');
  } catch (e) {
    r = { state: 'unknown', title: 'No se pudo comprobar la consola', text: e.message };
  }
  if (r.state !== 'ok' || !r.info) {
    st.className = 'status err'; $('#statusText').textContent = 'Sin consola';
    showCheck(r);
    scheduleCheck();
    return;
  }
  const info = r.info;
  state.info = info;
  st.className = 'status ok';
  $('#statusText').textContent = r.demo ? 'Conectado (modo demo)' : `Conectado · ${info.connection}`;
  $('#check').hidden = true; $('#app').hidden = false;
  renderInfo();
  // Se aceptan siempre todos los formatos: el análisis avisa si algo puede no funcionar.
  const exts = info.consoleType === 'snes' ? '.sfc,.smc,.sfrom,.nes' : '.nes,.sfc,.smc';
  $('#fileInput').accept = exts;
  $('#formats').textContent = exts.split(',').join(' · ');
  try {
    await loadGames();
    loadMods();
  } catch (e) { toast(e.message, true); }
}
function renderInfo() {
  const i = state.info;
  const other = (i.supports || []).filter((s) => s !== i.consoleType).map((s) => s.toUpperCase());
  $('#consoleName').textContent = i.consoleName + (other.length ? ` · también ${other.join(', ')} (RetroArch)` : '');
  const used = i.totalBytes ? 1 - i.freeBytes / i.totalBytes : 0;
  $('#spaceBar').style.width = `${Math.round(used * 100)}%`;
  $('#spaceText').textContent = i.totalBytes ? `${mb(i.freeBytes)} libres de ${mb(i.totalBytes)}` : 'Desconocido';
}

// ---------- lista de juegos ----------
async function loadGames() {
  const { info, games } = await api('/api/games');
  state.info = info; state.games = games;
  renderInfo(); renderGames();
}
function renderGames() {
  const term = $('#search').value.trim().toLowerCase();
  const list = state.games.filter((g) => !g.folder && (!term || g.name.toLowerCase().includes(term)));
  const all = state.games.filter((g) => !g.folder);
  $('#gameCount').textContent = all.length ? `(${all.length})` : '';
  $('#noGames').hidden = all.length > 0;
  const multiMenu = new Set(all.map((g) => g.menu)).size > 1;
  $('#games').innerHTML = list.map((g) => `
    <div class="game" data-menu="${g.menu}" data-code="${g.code}">
      <div class="art"><img loading="lazy" alt="" src="/api/icon/${g.menu}/${g.code}" onerror="this.remove()"></div>
      <div class="meta">
        <div class="name">${esc(g.name)}</div>
        <div class="tags">
          ${g.original ? '<span class="tag">De fábrica</span>' : '<span class="tag">Agregado</span>'}
          ${multiMenu ? `<span class="tag">Menú ${g.menu}</span>` : ''}
          ${g.players > 1 ? `<span class="tag">${g.players} jugadores</span>` : ''}
        </div>
        <div class="btns">
          <button class="btn sm" data-act="rename">Renombrar</button>
          <button class="btn sm danger" data-act="delete">Quitar</button>
        </div>
      </div>
    </div>`).join('');
}
$('#games').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const el = btn.closest('.game');
  const g = state.games.find((x) => x.menu === el.dataset.menu && x.code === el.dataset.code);
  if (btn.dataset.act === 'delete') {
    const extra = g.original ? '\n\nEs un juego de fábrica: solo se oculta del menú, no se borra de la consola.' : '';
    if (!confirm(`¿Quitar "${g.name}" de la consola?${extra}`)) return;
    busy(`Quitando "${g.name}"…`);
    try {
      await api(`/api/games/${g.menu}/${g.code}`, { method: 'DELETE' });
      toast(`"${g.name}" se quitó de la consola`);
      await loadGames();
    } catch (err) { toast(err.message, true); } finally { busy(); }
  } else if (btn.dataset.act === 'rename') {
    const name = prompt('Nuevo nombre del juego:', g.name);
    if (!name || name.trim() === g.name) return;
    busy('Guardando nombre…');
    try {
      await api(`/api/games/${g.menu}/${g.code}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      toast('Nombre actualizado');
      await loadGames();
    } catch (err) { toast(err.message, true); } finally { busy(); }
  }
});
$('#search').addEventListener('input', renderGames);

// ---------- cola de subida ----------
async function addFiles(files) {
  files = [...files];
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f, i) => fd.append(`f${i}`, f, f.name));
  busy(`Analizando ${files.length} ROM${files.length > 1 ? 's' : ''}…`);
  try {
    const { results } = await api('/api/analyze', { method: 'POST', body: fd });
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const item = { ...r, id: crypto.randomUUID(), file: files[i], players: 1 };
      if (r.ok && (state.queue.some((q) => q.code === r.code) || state.games.some((g) => g.code === r.code))) {
        item.warnings = [...(item.warnings || []), 'Este juego ya está en la consola o en la lista; se reemplazará.'];
      }
      if (r.ok) Object.assign(item, await makeCovers(item));
      state.queue.push(item);
    }
    renderQueue();
  } catch (e) { toast(e.message, true); } finally { busy(); }
}
function renderQueue() {
  const q = state.queue;
  $('#queueActions').hidden = q.length === 0;
  const ok = q.filter((x) => x.ok);
  const size = ok.reduce((n, x) => n + x.size, 0);
  $('#queueSummary').textContent = `${ok.length} juego${ok.length === 1 ? '' : 's'} listo${ok.length === 1 ? '' : 's'} · ${mb(size)}`
    + (q.length > ok.length ? ` · ${q.length - ok.length} con error` : '');
  $('#uploadBtn').disabled = ok.length === 0;
  $('#queue').innerHTML = q.map((x) => x.ok ? `
    <div class="qitem" data-id="${x.id}">
      <div class="qcover" title="Elegir carátula"><img alt="" src="${x.preview}"></div>
      <div class="qfields">
        <input type="text" value="${esc(x.name)}" data-f="name" maxlength="80" aria-label="Nombre del juego">
        <div class="qrow">
          <span>${esc(x.details)}</span>
          <label>Jugadores
            <select data-f="players">
              ${[1, 2, 3, 4].map((n) => `<option ${n === x.players ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </label>
          <span class="muted">${esc(x.file.name)}</span>
        </div>
        ${(x.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
      </div>
      <button class="btn sm ghost" data-act="remove" aria-label="Quitar de la lista">✕</button>
    </div>` : `
    <div class="qitem bad" data-id="${x.id}">
      <div class="qcover"></div>
      <div class="qfields"><strong>${esc(x.file.name)}</strong><div class="errtxt">${esc(x.error)}</div></div>
      <button class="btn sm ghost" data-act="remove" aria-label="Quitar de la lista">✕</button>
    </div>`).join('');
}
$('#queue').addEventListener('click', (e) => {
  const el = e.target.closest('.qitem'); if (!el) return;
  const item = state.queue.find((x) => x.id === el.dataset.id);
  if (e.target.closest('[data-act=remove]')) {
    state.queue = state.queue.filter((x) => x !== item); renderQueue();
  } else if (e.target.closest('.qcover') && item.ok) {
    state.coverTarget = item; $('#coverInput').value = ''; $('#coverInput').click();
  }
});
$('#queue').addEventListener('change', async (e) => {
  const el = e.target.closest('.qitem'); if (!el) return;
  const item = state.queue.find((x) => x.id === el.dataset.id);
  const f = e.target.dataset.f;
  if (f === 'players') item.players = parseInt(e.target.value, 10);
  if (f === 'name') {
    item.name = e.target.value.trim() || item.name;
    if (!item.coverFile) { Object.assign(item, await makeCovers(item)); renderQueue(); }
  }
});
$('#coverInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; const item = state.coverTarget;
  if (!file || !item) return;
  try {
    item.coverFile = file;
    Object.assign(item, await makeCovers(item));
    renderQueue();
  } catch { item.coverFile = null; toast('No se pudo leer esa imagen', true); }
});
$('#clearQueue').addEventListener('click', () => { state.queue = []; renderQueue(); });

$('#uploadBtn').addEventListener('click', async () => {
  const items = state.queue.filter((x) => x.ok);
  if (!items.length) return;
  const fd = new FormData();
  const meta = [];
  items.forEach((x, i) => {
    meta.push({ name: x.name, players: x.players, simultaneous: x.players > 1 });
    fd.append(`rom_${i}`, x.file, x.file.name);
    fd.append(`cover_${i}`, x.cover, `${i}.png`);
    fd.append(`small_${i}`, x.small, `${i}_small.png`);
  });
  fd.append('meta', JSON.stringify(meta));
  busy(`Enviando ${items.length} juego${items.length > 1 ? 's' : ''}… La pantalla de la consola se quedará en negro unos segundos.`);
  try {
    const r = await api('/api/games', { method: 'POST', body: fd });
    state.queue = state.queue.filter((x) => !x.ok);
    renderQueue();
    toast(`${r.added.length} juego${r.added.length > 1 ? 's' : ''} agregado${r.added.length > 1 ? 's' : ''}`
      + (r.seededOriginals ? ' (se mantuvieron los juegos de fábrica)' : ''));
    await loadGames();
  } catch (e) { toast(e.message, true); } finally { busy(); }
});

// ---------- arrastrar y soltar ----------
const drop = $('#drop');
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// ---------- otros botones ----------
$('#retry').addEventListener('click', connect);
$('#refresh').addEventListener('click', async () => {
  busy('Actualizando…');
  try { await loadGames(); } catch (e) { toast(e.message, true); } finally { busy(); }
});
$('#reboot').addEventListener('click', async () => {
  if (!confirm('¿Reiniciar la consola?')) return;
  try { await api('/api/reboot', { method: 'POST' }); toast('La consola se está reiniciando…'); } catch (e) { toast(e.message, true); }
  setTimeout(connect, 25000);
});

connect();

// ---------- módulos (hmods) ----------
const mods = { state: null, hub: null };

async function loadMods() {
  try {
    mods.state = await api('/api/mods');
    renderMods();
  } catch (e) {
    $('#modList').innerHTML = `<p class="errtxt">${esc(e.message)}</p>`;
  }
}
function renderMods() {
  const s = mods.state;
  const add = new Set(s.pendingInstall);
  const del = new Set(s.pendingRemove);
  const names = [...new Set([...s.installed, ...s.pendingInstall])].sort((a, b) => a.localeCompare(b));
  $('#modCount').textContent = s.installed.length ? `(${s.installed.length} instalados)` : '';
  const pend = [];
  if (add.size) pend.push(`Instalar: ${[...add].join(', ')}`);
  if (del.size) pend.push(`Desinstalar: ${[...del].join(', ')}`);
  $('#pending').hidden = pend.length === 0;
  $('#pendingText').textContent = pend.join(' · ');
  $('#modList').innerHTML = names.length ? names.map((n) => {
    const installed = s.installed.includes(n);
    let tag = '';
    if (add.has(n)) tag = `<span class="tag add">${installed ? 'Se reinstalará' : 'Se instalará'}</span>`;
    else if (del.has(n)) tag = '<span class="tag del">Se desinstalará</span>';
    const pending = add.has(n) || del.has(n);
    return `<div class="mod" data-name="${esc(n)}">
      <span class="mname">${esc(n)}</span>
      <span class="mbtns">${tag}
        ${pending ? '<button class="btn sm" data-act="cancel">Cancelar</button>'
                  : '<button class="btn sm danger" data-act="remove">Desinstalar</button>'}
      </span></div>`;
  }).join('') : '<p class="small muted">No hay módulos instalados con hakchi.</p>';
}
$('#modList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const name = btn.closest('.mod').dataset.name;
  try {
    if (btn.dataset.act === 'remove') {
      if (!confirm(`¿Desinstalar el módulo "${name}"?\n\nSe aplicará cuando pulses "Aplicar y reiniciar".`)) return;
      await api(`/api/mods/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } else {
      await api(`/api/mods/${encodeURIComponent(name)}/cancel`, { method: 'POST' });
    }
    await loadMods();
  } catch (err) { toast(err.message, true); }
});

$('#hmodInput').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f, i) => fd.append(`hmod${i}`, f, f.name));
  busy(`Enviando ${files.length} módulo${files.length > 1 ? 's' : ''} a la consola…`);
  try {
    const r = await api('/api/mods', { method: 'POST', body: fd });
    toast(`Listo para instalar: ${r.staged.map((m) => m.title).join(', ')}. Pulsa "Aplicar y reiniciar".`);
    await loadMods();
  } catch (err) { toast(err.message, true); } finally { busy(); }
});

$('#applyMods').addEventListener('click', async () => {
  if (!confirm('La consola se reiniciará para aplicar los módulos. Tardará 1–2 minutos y se reiniciará dos veces.\n\nNo la apagues ni desconectes durante el proceso. ¿Continuar?')) return;
  try {
    await api('/api/mods-apply', { method: 'POST' });
  } catch (err) { toast(err.message, true); return; }
  busy('Aplicando módulos… La consola se está reiniciando. No la apagues.');
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 20000));
  while (Date.now() - start < 4 * 60 * 1000) {
    try {
      const st = await api('/api/mods');
      if (!st.pendingInstall.length && !st.pendingRemove.length) {
        busy(); toast('Módulos aplicados.'); mods.state = st; renderMods(); connect(); return;
      }
    } catch { /* aún reiniciando */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  busy();
  toast('La consola tarda en volver. Si estás en Linux, puede que debas reconfigurar la red USB (vuelve a abrir el lanzador) y pulsar Reintentar.', true);
  connect();
});

// Mod Hub
$('#openHub').addEventListener('click', async () => {
  $('#hub').hidden = false;
  if (mods.hub) return renderHub();
  $('#hubList').innerHTML = '<p class="small muted">Descargando la lista del Mod Hub…</p>';
  try {
    mods.hub = (await api('/api/modhub')).items;
    const cats = [...new Set(mods.hub.map((m) => m.category))].sort((a, b) => a.localeCompare(b));
    $('#hubCat').innerHTML = '<option value="">Todas las categorías</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    renderHub();
    $('#hubSearch').focus();
  } catch (e) {
    $('#hubList').innerHTML = `<p class="errtxt">${esc(e.message)}</p>`;
  }
});
// Texto sin etiquetas: nunca mostrar <img ...> ni otro HTML dentro de la descripción.
function plainText(s) {
  return String(s || '').replace(/<[^>]*>?/g, ' ').replace(/&lt;[\s\S]*?(&gt;|$)/gi, ' ').replace(/\s+/g, ' ').trim();
}
function renderHub() {
  const term = $('#hubSearch').value.trim().toLowerCase();
  const cat = $('#hubCat').value;
  const installed = new Set([...(mods.state?.installed || []), ...(mods.state?.pendingInstall || [])].map((n) => n.toLowerCase()));
  const list = mods.hub.filter((m) => (!cat || m.category === cat)
    && (!term || `${m.title} ${m.name} ${m.system} ${m.description}`.toLowerCase().includes(term)));
  $('#hubList').innerHTML = list.length ? list.slice(0, 120).map((m) => `
    <div class="hitem">
      ${m.image ? `<div class="himg"><img loading="lazy" alt="" referrerpolicy="no-referrer" src="${esc(m.image)}" onerror="this.parentNode.remove()"></div>` : ''}
      <div class="htitle">${esc(m.title)}</div>
      <div class="tags">
        <span class="tag">${esc(m.category)}</span>
        ${m.version ? `<span class="tag">v${esc(m.version)}</span>` : ''}
        ${m.system ? `<span class="tag">${esc(m.system)}</span>` : ''}
      </div>
      <div class="hdesc">${esc(plainText(m.description))}${m.creator ? ` <em>— ${esc(m.creator)}</em>` : ''}</div>
      ${installed.has(m.name.toLowerCase())
        ? '<span class="tag add">Instalado / pendiente</span>'
        : `<button class="btn sm primary" data-id="${esc(m.id)}">Instalar</button>`}
    </div>`).join('') : '<p class="small muted">No se encontró ningún módulo.</p>';
}
$('#hubSearch').addEventListener('input', () => mods.hub && renderHub());
$('#hubCat').addEventListener('change', () => mods.hub && renderHub());
$('#hubList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]'); if (!btn) return;
  const m = mods.hub.find((x) => x.id === btn.dataset.id);
  busy(`Descargando "${m.title}" y enviándolo a la consola… (los módulos grandes como RetroArch pueden tardar)`);
  try {
    await api('/api/modhub/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id }) });
    toast(`"${m.title}" listo para instalar. Pulsa "Aplicar y reiniciar".`);
    await loadMods(); renderHub();
  } catch (err) { toast(err.message, true); } finally { busy(); }
});
