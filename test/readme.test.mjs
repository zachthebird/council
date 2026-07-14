import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempStore } from './helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'bin', 'moh.mjs');

// gate 30: exercise the README quickstart commands automatically.
test('README documents the quickstart commands', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const cmd of ['moh.mjs demo', 'moh.mjs doctor', 'moh.mjs --help']) {
    assert.ok(readme.includes(cmd), `README should document: ${cmd}`);
  }
});

test('README quickstart: demo, doctor, and --help all run', () => {
  tempStore();
  const env = { ...process.env, NO_COLOR: '1' };
  // These are exactly the commands in the README Quickstart.
  assert.doesNotThrow(() => execFileSync(process.execPath, [bin, 'demo'], { env, encoding: 'utf8' }));
  assert.doesNotThrow(() => execFileSync(process.execPath, [bin, 'doctor'], { env, encoding: 'utf8' }));
  const help = execFileSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8' });
  assert.match(help, /Mixture of Harnesses/);
});
