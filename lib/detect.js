// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
// Diagnóstico previo: ¿la consola tiene hakchi y se puede usar?
//
// Una consola original (sin hakchi) no se anuncia por USB: no aparece nada al conectarla.
// Con hakchi CE aparece como tarjeta de red USB (04e8:6863). En modo FEL (RESET pulsado al
// encender, o consola en recuperación) aparece como 1f3a:efe8.
const fs = require('fs');
const path = require('path');

const USB_HAKCHI = '04e8:6863';
const USB_FEL = '1f3a:efe8';

function read(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

/** Busca la consola en el USB (solo Linux, vía /sys). Devuelve null si no se puede saber. */
function scanUsb(sysRoot = '/sys') {
  if (process.platform !== 'linux' && sysRoot === '/sys') return null;
  const devDir = path.join(sysRoot, 'bus/usb/devices');
  let devs;
  try { devs = fs.readdirSync(devDir); } catch { return null; }
  const found = { hakchi: false, fel: false, iface: null, ifaceHasIp: false };
  for (const d of devs) {
    const id = `${read(path.join(devDir, d, 'idVendor'))}:${read(path.join(devDir, d, 'idProduct'))}`;
    if (id === USB_FEL) found.fel = true;
    if (id === USB_HAKCHI) found.hakchi = true;
  }
  if (found.hakchi) {
    // Interfaz de red de la consola: /sys/class/net/X/device/.. es el dispositivo USB.
    const netDir = path.join(sysRoot, 'class/net');
    let nets = [];
    try { nets = fs.readdirSync(netDir); } catch { /* sin red */ }
    for (const n of nets) {
      let usbDev;
      // Resolver primero el enlace "device" y luego subir un nivel (path.join quitaría "device/.." sin seguirlo).
      try { usbDev = path.dirname(fs.realpathSync(path.join(netDir, n, 'device'))); } catch { continue; }
      if (`${read(path.join(usbDev, 'idVendor'))}:${read(path.join(usbDev, 'idProduct'))}` === USB_HAKCHI) {
        found.iface = n;
        break;
      }
    }
    if (found.iface) {
      const ifs = require('os').networkInterfaces()[found.iface] || [];
      found.ifaceHasIp = ifs.some((a) => a.family === 'IPv4' && a.address.startsWith('169.254.'));
    }
  }
  return found;
}

/**
 * Clasifica el estado. `connErr` es el error al conectar por SSH (null si conectó).
 * `noHakchi` = conectó pero el comando hakchi no existe.
 */
function classify({ connErr, noHakchi, usb, host }) {
  if (!connErr && !noHakchi) return { state: 'ok' };
  if (noHakchi) {
    return {
      state: 'no-hakchi',
      title: 'La consola responde, pero no tiene hakchi',
      text: `Hay un dispositivo en ${host} que acepta la conexión, pero no tiene hakchi CE instalado.`,
    };
  }
  const msg = String(connErr?.message || connErr || '');
  if (usb?.hakchi && usb.iface && !usb.ifaceHasIp) {
    return {
      state: 'network',
      title: 'Consola con hakchi detectada, falta configurar la red USB',
      text: `Tu consola está conectada y tiene hakchi (aparece como "${usb.iface}"), pero Linux no le asignó dirección. Ejecuta esto en una terminal y pulsa "Volver a comprobar":`,
      command: `sudo ip link set ${usb.iface} up && sudo ip addr add 169.254.1.2/16 dev ${usb.iface}`,
      hint: 'El lanzador iniciar-mac-linux.sh hace esto automáticamente al abrir la app.',
    };
  }
  if (usb?.hakchi) {
    return {
      state: 'starting',
      title: 'Consola con hakchi detectada, esperando respuesta',
      text: `La consola aparece por USB y tiene hakchi, pero todavía no responde en ${host}. Si acaba de encenderse o reiniciarse, espera unos segundos.`,
      hint: 'Si no cambia en un minuto: desconecta y vuelve a conectar el cable, o desactiva VPNs como Cloudflare WARP.',
      detail: msg,
    };
  }
  if (usb?.fel) {
    return {
      state: 'fel',
      title: 'Consola en modo FEL (recuperación)',
      text: 'La consola está conectada en modo FEL: se enciende así cuando se mantiene pulsado RESET al encenderla. En este modo hakchi no está funcionando, y esta app no puede usarla.',
      steps: [
        'Si no querías entrar en este modo: apágala y enciéndela normalmente, sin pulsar RESET.',
        'Si la consola no tiene hakchi, el hack se instala con hakchi2 CE (Windows): Kernel → Install / Repair. Esta app no instala el hack.',
      ],
    };
  }
  if (usb && !usb.hakchi && !usb.fel) {
    return {
      state: 'not-found',
      title: 'No se detecta ninguna consola con hakchi',
      text: 'No aparece ninguna consola en los puertos USB. Una consola original, sin hakchi, no se comunica por USB, así que esto suele significar una de estas cosas:',
      steps: [
        'La consola no está encendida o el cable no está bien conectado (SNES Mini: puerto trasero; NES Mini: puerto lateral).',
        'El cable solo da corriente y no transmite datos: prueba con otro.',
        'La consola no tiene hakchi. El hack se instala una vez con hakchi2 CE (Windows): Kernel → Install / Repair. Esta app no instala el hack.',
      ],
    };
  }
  // No sabemos leer el USB (Windows/macOS): mensaje general.
  return {
    state: 'unknown',
    title: 'No se pudo conectar con la consola',
    text: `No hay respuesta en ${host}. Comprueba:`,
    steps: [
      'Que la consola está encendida y conectada por USB al ordenador (SNES Mini: puerto trasero; NES Mini: puerto lateral) con un cable de datos.',
      'Que tiene hakchi CE instalado: una consola original no se comunica por USB. El hack se instala una vez con hakchi2 CE: Kernel → Install / Repair.',
      'En Windows, que está instalado el driver USB de hakchi2 CE.',
    ],
    detail: msg,
  };
}

module.exports = { scanUsb, classify, USB_HAKCHI, USB_FEL };
