// Shared CLI presentation helpers. Honors NO_COLOR and non-TTY output. Plain and
// JSON modes emit ZERO ANSI sequences.
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

export function color(code, s) {
  if (NO_COLOR) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

export const c = {
  bold: (s) => color('1', s),
  dim: (s) => color('2', s),
  green: (s) => color('32', s),
  yellow: (s) => color('33', s),
  red: (s) => color('31', s),
  cyan: (s) => color('36', s),
  magenta: (s) => color('35', s),
};

export function out(s = '') {
  process.stdout.write(s + '\n');
}
export function err(s = '') {
  process.stderr.write(s + '\n');
}

export function heading(s) {
  out('\n' + c.bold(s));
}

export function kv(key, val) {
  out(`  ${c.dim(key.padEnd(16))} ${val}`);
}

/** Render a table with no ANSI in the data (safe for redirected output). */
export function table(rows, headers) {
  const cols = headers.length;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells, fmt = (x) => x) => out('  ' + cells.map((cell, i) => fmt(String(cell ?? '').padEnd(widths[i]))).join('  '));
  line(headers, c.bold);
  for (const r of rows) line(r);
}
