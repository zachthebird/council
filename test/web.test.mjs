import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempStore } from './helpers.mjs';

const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'moh.mjs');
let proc, port, base;

before(async () => {
  tempStore();
  port = 7390 + Math.floor(process.pid % 100);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [bin, 'web', '--port', String(port)], { env: { ...process.env, NO_COLOR: '1' } });
  await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('web did not start')), 8000);
    proc.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('moh web on')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('error', reject);
  });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
});

async function getCookie() {
  const res = await fetch(base + '/', { headers: { host: `127.0.0.1:${port}` } });
  const sc = res.headers.get('set-cookie') || '';
  const m = /moh_cap=([^;]+)/.exec(sc);
  return m ? `moh_cap=${m[1]}` : '';
}

// undici/fetch forbids overriding Host, so use raw http to send a spoofed Host.
function rawGet(path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('gate 24: invalid Host header is rejected (DNS-rebinding defense)', async () => {
  const status = await rawGet('/', 'evil.attacker.com');
  assert.equal(status, 421);
});

test('serves the app and sets an HttpOnly SameSite cookie (no token in HTML/URL)', async () => {
  const res = await fetch(base + '/');
  const sc = res.headers.get('set-cookie') || '';
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const html = await res.text();
  assert.doesNotMatch(html, /moh_cap=/, 'capability must not appear in HTML');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('gate 24: mutation without capability is denied', async () => {
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-moh-csrf': '1' } });
  assert.equal(res.status, 403);
});

test('gate 24: mutation with capability but hostile Origin is denied (CSRF defense)', async () => {
  const cookie = await getCookie();
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'http://evil.example', 'x-moh-csrf': '1' } });
  assert.equal(res.status, 403);
});

test('gate 24: mutation missing the custom CSRF header is denied', async () => {
  const cookie = await getCookie();
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base } });
  assert.equal(res.status, 403);
});

test('valid same-origin mutation with capability + csrf header is accepted', async () => {
  const cookie = await getCookie();
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base, 'x-moh-csrf': '1' }, body: '{}' });
  assert.equal(res.status, 200);
});
