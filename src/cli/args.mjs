// Argument parsing + non-interactive task input (flag, file, or stdin).
import { readFileSync } from 'node:fs';

/** Parse `--key value` and `--flag` into an object. */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

/** Read a task prompt from --task, --task-file, or stdin (--stdin or piped). */
export async function readPromptInput(flags) {
  if (flags.task && typeof flags.task === 'string') return flags.task;
  if (flags['task-file']) return readFileSync(flags['task-file'], 'utf8');
  if (flags.stdin || !process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8').trim();
    return s || null;
  }
  return null;
}
