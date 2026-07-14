// Identifier generation. Supports a deterministic mode so `moh demo` and tests
// produce byte-stable run records (no Date.now / Math.random in that path).
import { randomBytes, createHash } from 'node:crypto';

const B36 = 36;

export function makeIdFactory({ deterministic = false, seed = 'moh' } = {}) {
  let counter = 0;
  const seedHash = createHash('sha256').update(String(seed)).digest('hex');
  return {
    /** Opaque run id. Deterministic mode derives it from the seed. */
    runId() {
      if (deterministic) return `run-${seedHash.slice(0, 12)}`;
      return `run-${Date.now().toString(B36)}-${randomBytes(4).toString('hex')}`;
    },
    /** Short monotonic id for attempts/turns/events; stable in deterministic mode. */
    next(prefix) {
      counter += 1;
      if (deterministic) return `${prefix}-${counter.toString().padStart(4, '0')}`;
      return `${prefix}-${counter.toString(B36)}-${randomBytes(3).toString('hex')}`;
    },
    /** An unguessable capability token for the loopback web server. */
    capabilityToken() {
      // Always real entropy — never deterministic, even in demo mode.
      return randomBytes(24).toString('base64url');
    },
  };
}

/** Validate a run id shape before using it in a filesystem path. */
export function isSafeRunId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.startsWith('.');
}
