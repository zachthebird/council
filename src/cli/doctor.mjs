// `moh doctor` — OFFLINE, non-token-consuming diagnostics. Any live probe would be
// a separate explicit action (not performed here). Never prints secret values.
import { execFileSync } from 'node:child_process';
import { listAdapters } from '../adapters/registry.mjs';
import { Readiness } from '../adapters/contract.mjs';
import { stateDir } from '../storage/paths.mjs';
import { redact } from '../security/redact.mjs';

function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim().replace('git version ', '');
  } catch {
    return null;
  }
}

export async function doctor() {
  const adapters = [];
  let anyReady = false;
  for (const a of listAdapters()) {
    let readiness = Readiness.PROBE_FAILED;
    let version = null;
    let authLabel = null;
    let detail = null;
    try {
      const disc = await a.discover();
      const v = disc.found ? await a.probeVersion() : { version: null };
      version = v.version;
      const r = await a.probeReadiness();
      readiness = r.readiness;
      authLabel = redact(r.authLabel || '');
      detail = redact(r.detail || '');
    } catch (e) {
      detail = `probe failed: ${redact(e.message)}`;
    }
    if (a.id !== 'fake' && readiness === Readiness.READY) anyReady = true;
    adapters.push({ id: a.id, displayName: a.displayName, trustLevel: a.trustLevel, readiness, version, authLabel, detail });
  }
  return {
    ok: anyReady,
    node: process.version,
    platform: process.platform,
    git: gitVersion(),
    stateDir: stateDir(),
    adapters,
    note: 'Offline diagnostics only. No model calls, no tokens spent, no secrets read.',
  };
}
