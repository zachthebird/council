// `moh doctor` — OFFLINE, non-token-consuming diagnostics. Any live probe would be
// a separate explicit action (not performed here). Never prints secret values.
import { execFileSync } from 'node:child_process';
import { listAdapters } from '../adapters/registry.mjs';
import { Readiness } from '../adapters/contract.mjs';
import { stateDir } from '../storage/paths.mjs';
import { redact, redactDeep, stripControl } from '../security/redact.mjs';

function safeText(value, maxLength = 2000) {
  if (value == null) return null;
  return redact(stripControl(String(value))).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength) || null;
}

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
    let path = null;
    let capabilities = {};
    let modelCatalog;
    try {
      const disc = await a.discover();
      path = safeText(disc.realPath || disc.path, 4096);
      const v = disc.found ? await a.probeVersion() : { version: null };
      version = safeText(v.version, 200);
      const r = await a.probeReadiness();
      readiness = r.readiness;
      authLabel = safeText(r.authLabel);
      detail = safeText(r.detail);
      capabilities = redactDeep(a.capabilities() || {});
      if (typeof a.discoverModels === 'function') {
        try {
          const catalog = await a.discoverModels();
          if (catalog && Array.isArray(catalog.models)) modelCatalog = redactDeep(catalog);
        } catch {
          // Model catalogs are optional; readiness remains useful if unavailable.
        }
      }
    } catch {
      detail = 'probe failed; no account or credential details were retained';
    }
    if (a.id !== 'fake' && readiness === Readiness.READY) anyReady = true;
    const entry = { id: a.id, displayName: a.displayName, trustLevel: a.trustLevel, readiness, version, authLabel, detail, path, capabilities };
    if (modelCatalog) entry.modelCatalog = modelCatalog;
    adapters.push(entry);
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
