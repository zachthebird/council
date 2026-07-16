// Redaction of secret-shaped values. Applied to anything that could reach a log,
// event, export, diagnostic, or the web/TUI. We never print secret values.
import { homedir } from 'node:os';

const PATTERNS = [
  // Common token prefixes.
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{16,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(gho_[A-Za-z0-9]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, // JWT
  // Authorization headers / bearer tokens.
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s"']+/gi,
  // key=value where key looks secret.
  /((?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
  // Credentials embedded in URLs: scheme://user:pass@host
  /([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@/\s]+)@/gi,
];

/**
 * Strip/neutralize terminal control sequences (ANSI CSI/OSC, and non-tab/newline
 * C0 controls) so harness output can never drive the terminal (cursor moves,
 * screen clears, title/hyperlink OSC, etc.). Preserves tab and newline.
 */
export function stripControl(input) {
  if (input == null) return input;
  let s = String(input);
  // ANSI CSI: ESC [ ... final-byte
  s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // OSC: ESC ] ... BEL or ST
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // Other escape-prefixed sequences.
  s = s.replace(/\x1b[@-Z\\-_]/g, '');
  // Remaining C0 controls except \t (\x09) and \n (\x0a).
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return s;
}

/** Redact secret-shaped substrings from a string. */
export function redact(input) {
  if (input == null) return input;
  let s = String(input);
  s = s.replace(PATTERNS[1], 'sk-ant-***'); // specific before generic
  s = s.replace(PATTERNS[0], 'sk-***');
  s = s.replace(PATTERNS[2], 'ghp_***');
  s = s.replace(PATTERNS[3], 'gho_***');
  s = s.replace(PATTERNS[4], 'xox***');
  s = s.replace(PATTERNS[5], 'AKIA***');
  s = s.replace(PATTERNS[6], '***.jwt.***');
  s = s.replace(PATTERNS[7], '$1***');
  s = s.replace(PATTERNS[8], '$1$2***$2');
  s = s.replace(PATTERNS[9], '$1$2:***@');
  return s;
}

// Keys whose VALUE is redacted wholesale regardless of shape (a short/opaque
// secret would otherwise slip past pattern matching).
const SECRET_KEY = /^(env|environment|headers?|cookies?|credentials?|secret|secrets|password|passwd|pwd|pass|token|tokens|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|api[_-]?secret|client[_-]?secret|private[_-]?key|session[_-]?key|auth|authorization|bearer|passphrase)$/i;

/** Deep-redact an object for safe persistence/export. */
export function redactDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactDeep(v, seen);
      }
    }
    return out;
  }
  return value;
}

/**
 * Replace the exporting user's home-directory prefix with `~` throughout a value
 * so a privacy-safe export or shareable transcript never leaks the username /
 * home path in an UNENUMERATED field (errors, review prose, config). Complements
 * the export's per-field basenaming, which only covers known path fields.
 * Structure-preserving: rewrites string leaves only.
 */
export function scrubUserPaths(value, home = homedir(), seen = new WeakSet()) {
  if (typeof value === 'string') {
    return home && home.length > 3 ? value.split(home).join('~') : value;
  }
  if (Array.isArray(value)) return value.map((v) => scrubUserPaths(v, home, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubUserPaths(v, home, seen);
    return out;
  }
  return value;
}

/**
 * Strip a URL of embedded credentials, returning a safe form. Throws if the URL
 * carries credentials and `reject` is set (used at persistence boundaries).
 */
const CRED_QUERY_KEYS = /^(token|access_token|private_token|api[_-]?key|key|password|passwd|pwd|secret|auth|oauth_token|x-oauth-basic)$/i;

export function sanitizeGitUrl(url, { reject = false } = {}) {
  if (typeof url !== 'string') throw new Error('url must be a string');

  // 1) userinfo credentials: scheme://user:pass@host
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+@)/i.exec(url);
  if (m) {
    if (reject) throw new Error('refusing credential-bearing clone URL; use harness/OS credential storage instead');
    url = url.replace(m[2], '');
  }

  // 2) token-bearing query parameters: ?token=..., ?access_token=..., etc.
  try {
    const u = new URL(url);
    let hadCredParam = false;
    for (const key of [...u.searchParams.keys()]) {
      if (CRED_QUERY_KEYS.test(key)) {
        hadCredParam = true;
        u.searchParams.delete(key);
      }
    }
    if (hadCredParam) {
      if (reject) throw new Error('refusing clone URL with a credential-bearing query parameter; use harness/OS credential storage instead');
      url = u.toString();
    }
  } catch (e) {
    // Non-absolute/opaque URLs (e.g. scp-like git@host:path) have no query to parse.
    if (e instanceof Error && /credential-bearing query/.test(e.message)) throw e;
  }
  return url;
}
