// Environment policy: harnesses receive a MINIMAL, intentional environment.
// We never pass the full parent environment, and never place secret VALUES in
// argv/urls. Only an allowlist of base vars plus explicitly-referenced auth
// variable NAMES are forwarded.

// Base vars every child needs to function on a POSIX/Windows system.
const BASE_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'COMSPEC',
];

/**
 * Build a child environment from a base allowlist plus explicitly named auth
 * variables. `authEnvNames` are variable NAMES the seat is allowed to inherit
 * (e.g. ["ANTHROPIC_API_KEY"]). Their values are copied but never logged.
 *
 * @param {object} opts
 * @param {string[]} opts.authEnvNames  Names of auth env vars to forward, if present.
 * @param {object} [opts.extra]         Non-secret extra vars set by the adapter.
 * @returns {{env: object, forwarded: string[], missing: string[]}}
 */
export function buildChildEnv({ authEnvNames = [], extra = {} } = {}) {
  const parent = process.env;
  const env = Object.create(null);
  for (const key of BASE_ALLOW) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  const forwarded = [];
  const missing = [];
  for (const name of authEnvNames) {
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    if (parent[name] !== undefined) {
      env[name] = parent[name];
      forwarded.push(name);
    } else {
      missing.push(name);
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return { env, forwarded, missing };
}

/** Detect whether a given auth env NAME currently has a value (no value returned). */
export function authPresent(name) {
  return typeof name === 'string' && process.env[name] !== undefined && process.env[name] !== '';
}
