// Lightweight "lint": syntax-check every source file with the real Node parser.
// Zero dependencies; catches parse errors in CI without a heavyweight linter.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = ['bin', 'src', 'scripts', 'test'];
let count = 0;
let failed = 0;

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mjs')) {
      count++;
      try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
      } catch (err) {
        failed++;
        process.stderr.write(`SYNTAX ERROR: ${p}\n${err.stderr || err.message}\n`);
      }
    }
  }
}

for (const d of dirs) {
  try {
    if (statSync(join(root, d)).isDirectory()) walk(join(root, d));
  } catch {
    /* dir may not exist */
  }
}

process.stdout.write(`checked ${count} file(s), ${failed} error(s)\n`);
process.exit(failed ? 1 : 0);
