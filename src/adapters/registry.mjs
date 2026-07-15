// Adapter registry. Built-in adapters self-register here. Third-party adapters
// are loaded only via the external-adapter protocol with explicit user opt-in.
import { assertAdapterShape } from './contract.mjs';
import { fakeAdapter } from './fake.mjs';
import { claudeCodeAdapter } from './claude-code.mjs';
import { codexCliAdapter } from './codex-cli.mjs';
import { openclawAdapter } from './openclaw.mjs';
import { hermesAdapter } from './hermes.mjs';
import { loadExternalAdapter } from './external.mjs';

const registry = new Map();

export function register(adapter) {
  assertAdapterShape(adapter);
  registry.set(adapter.id, adapter);
  return adapter;
}

/**
 * Load and register a third-party adapter from a manifest path. Requires explicit
 * opt-in (opts.trust === true or MOH_ALLOW_EXTERNAL_ADAPTERS=1); enabling one means
 * trusting local code. Returns the registered adapter.
 */
export function registerExternalAdapter(manifestPath, opts = {}) {
  const adapter = loadExternalAdapter(manifestPath, opts);
  return register(adapter);
}

export function getAdapter(id) {
  return registry.get(id) || null;
}

export function listAdapters() {
  return [...registry.values()];
}

// Built-in registration. Fake first so the demo always has a participant.
register(fakeAdapter);
register(claudeCodeAdapter);
register(codexCliAdapter);
register(openclawAdapter);
register(hermesAdapter);
