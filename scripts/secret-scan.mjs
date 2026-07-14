// Basic secret scanner for CI. Fails if a secret-shaped token appears in tracked
// source/docs. Not a replacement for a dedicated scanner; a cheap zero-dependency
// backstop so an accidental key never ships.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.git', 'runs', 'workspaces', 'coverage']);
const PATTERNS = [
  { name: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
// This scanner file and the redactor legitimately contain example prefixes.
const ALLOW_FILES = new Set([join(root, 'scripts', 'secret-scan.mjs'), join(root, 'src', 'security', 'redact.mjs'), join(root, 'test', 'security.test.mjs')]);

let hits = 0;
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|js|json|md|html|yml|yaml|txt)$/.test(e.name)) {
      if (ALLOW_FILES.has(p)) continue;
      let text;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      for (const { name, re } of PATTERNS) {
        const m = re.exec(text);
        if (m) {
          hits++;
          process.stderr.write(`SECRET? ${name} in ${p}\n`);
        }
      }
    }
  }
}

walk(root);
if (hits) {
  process.stderr.write(`secret-scan: ${hits} potential secret(s) found\n`);
  process.exit(1);
}
process.stdout.write('secret-scan: clean\n');
