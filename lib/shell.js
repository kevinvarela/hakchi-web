// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Kevin Varela — hakchi web (https://github.com/kevinvarela/hakchi-web)
'use strict';
const { Client } = require('ssh2');
const { spawn } = require('child_process');

// Comillas simples seguras para sh/busybox.
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Conexión SSH a la consola con hakchi CE (dropbear, usuario root sin contraseña).
 * Se conecta por el cable USB: la consola aparece como red USB en 169.254.13.37.
 */
class SshShell {
  constructor({ host = '169.254.13.37', port = 22, timeout = 8000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.conn = null;
    this.connecting = null;
  }

  get label() {
    return `${this.host}:${this.port}`;
  }

  connect() {
    if (this.conn) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const conn = new Client();
      const fail = (err) => {
        this.connecting = null;
        this.conn = null;
        reject(err);
      };
      conn.on('ready', () => {
        this.conn = conn;
        this.connecting = null;
        resolve();
      });
      conn.on('error', fail);
      conn.on('close', () => {
        this.conn = null;
      });
      conn.connect({
        host: this.host,
        port: this.port,
        username: 'root',
        readyTimeout: this.timeout,
        keepaliveInterval: 10000,
        // hakchi CE acepta root sin contraseña; versiones antiguas usaban "clover".
        authHandler: [
          'none',
          { type: 'password', username: 'root', password: '' },
          { type: 'password', username: 'root', password: 'clover' },
        ],
        // dropbear de la consola es antiguo: añadimos algoritmos heredados.
        algorithms: {
          kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
          cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'] },
          serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
          hmac: { append: ['hmac-sha1'] },
        },
      });
    });
    return this.connecting;
  }

  close() {
    if (this.conn) this.conn.end();
    this.conn = null;
  }

  /** Ejecuta un comando. `input` (Buffer) se envía por stdin. */
  async exec(cmd, input) {
    await this.connect();
    return new Promise((resolve, reject) => {
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        const out = [];
        const errOut = [];
        stream.on('data', (d) => out.push(d));
        stream.stderr.on('data', (d) => errOut.push(d));
        stream.on('close', (code) => {
          resolve({ code: code ?? 0, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut).toString() });
        });
        if (input) stream.end(input);
        else stream.end();
      });
    });
  }
}

/** Modo demo: ejecuta los comandos en local con un "hakchi" simulado (ver mock/). */
class LocalShell {
  constructor({ env }) {
    this.env = env;
  }

  get label() {
    return 'demo (consola simulada)';
  }

  connect() {
    return Promise.resolve();
  }

  close() {}

  exec(cmd, input) {
    return new Promise((resolve, reject) => {
      const p = spawn('sh', ['-c', cmd], { env: this.env });
      const out = [];
      const errOut = [];
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => errOut.push(d));
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut).toString() }));
      if (input) p.stdin.end(input);
      else p.stdin.end();
    });
  }
}

module.exports = { SshShell, LocalShell, q };
