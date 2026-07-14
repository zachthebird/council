// prepublishOnly guard. Fails the publish if forbidden content would ship or if
// checks/tests do not pass. Keeps runs/, credentials, and user data out of the tarball.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' });
}

let failed = false;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${name}\n`);
  } catch (e) {
    failed = true;
    process.stdout.write(`FAIL ${name}: ${e.message}\n`);
  }
}

check('syntax check', () => run(process.execPath, ['scripts/check-syntax.mjs']));
check('tests pass', () => run(process.execPath, ['--test', 'test/*.test.mjs']));

check('pack contains only allowlisted content', () => {
  const out = run('npm', ['pack', '--dry-run', '--json']);
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  const forbidden = files.filter((f) => /^(runs|workspaces)\//.test(f) || /\.(log|env)$/.test(f) || /credentials|secret/i.test(f));
  if (forbidden.length) throw new Error('forbidden files in pack: ' + forbidden.join(', '));
  // Sanity: the CLI entry and core must be present.
  for (const need of ['bin/moh.mjs', 'src/core/app.mjs']) {
    if (!files.includes(need)) throw new Error(`missing required file in pack: ${need}`);
  }
});

if (failed) {
  process.stderr.write('prepublish checks FAILED\n');
  process.exit(1);
}
process.stdout.write('prepublish checks passed\n');
