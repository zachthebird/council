// OpenClaw adapter — HONEST state. We have not verified an OpenClaw headless/JSON
// interface, model-identity reporting, or workspace-isolation guarantees on this
// build. Therefore OpenClaw is presented as Experimental (if a binary is found) or
// Unavailable (if not), never as production parity, and it is NOT granted an author
// role until work is proven to occur inside the isolated run workspace. We never
// modify global OpenClaw configuration and never scrape private state.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { TrustLevel, Readiness, Capability, CapabilityState, capabilityMap } from './contract.mjs';
import { buildChildEnv } from '../process/env-policy.mjs';

const PROBE_ENV = () => buildChildEnv({}).env;

function onPath(name) {
  try {
    const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', env: PROBE_ENV() }).split('\n')[0].trim();
    return p || null;
  } catch {
    return null;
  }
}

function resolveExe() {
  const c = [process.env.MOH_OPENCLAW_PATH, onPath('openclaw')].filter(Boolean);
  for (const x of c) {
    try {
      if (existsSync(x) && statSync(x).isFile()) return realpathSync(x);
    } catch {
      /* ignore */
    }
  }
  return null;
}

export const openclawAdapter = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  version: '0.0.1',
  contractVersion: 1,
  trustLevel: TrustLevel.EXPERIMENTAL,
  authorAllowed: false, // gated until isolated-workspace authoring is proven

  async discover() {
    const realPath = resolveExe();
    return { found: !!realPath, path: realPath, realPath };
  },
  async probeVersion() {
    const exe = resolveExe();
    if (!exe) return { version: null };
    try {
      return { version: execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000, env: PROBE_ENV() }).trim() };
    } catch {
      return { version: null };
    }
  },
  async probeReadiness() {
    const exe = resolveExe();
    if (!exe) {
      return {
        readiness: Readiness.UNAVAILABLE,
        authLabel: 'not installed',
        detail: 'OpenClaw is not installed and its headless interface is not yet verified by moh. Install it and inspect `openclaw --help`; the adapter stays Experimental until a public structured interface and workspace isolation are confirmed.',
      };
    }
    return {
      readiness: Readiness.EXPERIMENTAL,
      authLabel: 'unverified',
      detail: 'OpenClaw binary found but moh has not verified a headless/JSON interface, runtime model reporting, or workspace isolation. Available for inspection only; not granted an author role.',
    };
  },
  capabilities() {
    // Everything unverified is UNKNOWN/EXPERIMENTAL — never fabricated as supported.
    return capabilityMap({
      [Capability.STRUCTURED_STREAMING]: CapabilityState.UNKNOWN,
      [Capability.RUNTIME_MODEL_OBSERVATION]: CapabilityState.UNKNOWN,
      [Capability.WORKSPACE_ISOLATION]: CapabilityState.UNKNOWN,
      [Capability.NATIVE_RESUME]: CapabilityState.UNKNOWN,
    });
  },
  prepareInvocation() {
    throw new Error('OpenClaw adapter is Experimental: no verified headless interface. Refusing to invoke to avoid fabricating behavior.');
  },
  parseEvents() {
    return [];
  },
  finalize() {
    return { finalText: '', sessionId: null };
  },
  async diagnostics() {
    const d = await this.discover();
    return { installed: d.found, path: d.realPath, note: 'experimental; not invocable' };
  },
};
