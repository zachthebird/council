import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempStore } from './helpers.mjs';

const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'moh.mjs');

function run(args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
}

const ANSI = /\x1b\[[0-9;]*m/;

test('gate 4: doctor --json contains no ANSI', () => {
  tempStore();
  const out = run(['doctor', '--json']);
  assert.doesNotMatch(out, ANSI);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.adapters));
  assert.match(parsed.note, /no tokens/i);
});

test('gate 4: demo --json is line-oriented JSON with no ANSI', () => {
  tempStore();
  const out = run(['demo', '--json']);
  assert.doesNotMatch(out, ANSI);
  const lines = out.trim().split('\n').filter(Boolean);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), `line is JSON: ${l.slice(0, 40)}`);
});

test('gate 1: demo runs to a finished result offline', () => {
  tempStore();
  const out = run(['demo']);
  assert.match(out, /Local result/);
  assert.match(out, /moh\//);
  assert.match(out, /no credentials, no network/);
});

test('gate 13: demo shows "Not reported by harness" for the unknown seat', () => {
  tempStore();
  const out = run(['demo']);
  assert.match(out, /Effective model: Not reported by harness/);
});

test('help lists the documented commands', () => {
  const out = run(['--help']);
  for (const cmd of ['setup', 'doctor', 'adapters', 'run', 'demo', 'web', 'runs', 'inspect', 'resume', 'export']) {
    assert.match(out, new RegExp(cmd));
  }
});

test('run --task via flag, --yes non-interactive, --json', () => {
  tempStore();
  const out = run(['run', '--task', 'do a thing', '--yes', '--json']);
  const lines = out.trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.ok(last.runId);
});

test('gate 3: TUI launches, survives non-TTY, exits cleanly on q', async () => {
  tempStore();
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin], { env: { ...process.env, NO_COLOR: '1', MOH_STATE_DIR: process.env.MOH_STATE_DIR, MOH_CONFIG_DIR: process.env.MOH_CONFIG_DIR } });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('close', () => resolve(buf));
    p.on('error', reject);
    p.stdin.write('q\n');
    p.stdin.end();
    setTimeout(() => p.kill('SIGKILL'), 5000);
  });
  assert.match(out, /Mixture of Harnesses/);
  assert.doesNotMatch(out, ANSI); // NO_COLOR honored
});

test('gate 3: Ctrl-C (SIGINT) restores the terminal and exits cleanly (130)', async () => {
  tempStore();
  const { code, out } = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin], { env: { ...process.env, NO_COLOR: '1', MOH_STATE_DIR: process.env.MOH_STATE_DIR, MOH_CONFIG_DIR: process.env.MOH_CONFIG_DIR } });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('moh>')) p.kill('SIGINT'); // interrupt at the prompt
    });
    p.on('close', (code) => resolve({ code, out: buf }));
    p.on('error', reject);
    setTimeout(() => p.kill('SIGKILL'), 5000);
  });
  assert.equal(code, 130, 'SIGINT exits with 130');
  assert.match(out, /Terminal restored/);
});
