// Hermes adapter — HONEST state. As with OpenClaw, moh has not verified a Hermes
// headless interface, model provenance, or workspace isolation. Presented as
// Blocked (binary present but interface unverified) or Unavailable (absent). Never
// claims production parity; never scrapes private databases or decorative TTY output.
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
  const c = [process.env.MOH_HERMES_PATH, onPath('hermes')].filter(Boolean);
  for (const x of c) {
    try {
      if (existsSync(x) && statSync(x).isFile()) return realpathSync(x);
    } catch {
      /* ignore */
    }
  }
  return null;
}

export const hermesAdapter = {
  id: 'hermes',
  displayName: 'Hermes',
  version: '0.0.1',
  contractVersion: 1,
  trustLevel: TrustLevel.EXPERIMENTAL,
  authorAllowed: false,

  async discover() {
    const realPath = resolveExe();
    return { found: !!realPath, path: realPath, realPath };
  },
  async probeVersion() {
    return { version: null };
  },
  async probeReadiness() {
    const exe = resolveExe();
    if (!exe) {
      return {
        readiness: Readiness.UNAVAILABLE,
        authLabel: 'not installed',
        detail: 'Hermes is not installed. moh has not verified a Hermes headless/JSON interface; the adapter stays Blocked/Experimental until one is confirmed from `hermes --help` and current docs.',
      };
    }
    return {
      readiness: Readiness.BLOCKED,
      authLabel: 'unverified',
      detail: 'Hermes binary found but its structured interface, model reporting, and workspace isolation are unverified by moh. Blocked from author roles to avoid fabricating behavior.',
    };
  },
  capabilities() {
    return capabilityMap({
      [Capability.STRUCTURED_STREAMING]: CapabilityState.UNKNOWN,
      [Capability.RUNTIME_MODEL_OBSERVATION]: CapabilityState.UNKNOWN,
      [Capability.WORKSPACE_ISOLATION]: CapabilityState.UNKNOWN,
    });
  },
  prepareInvocation() {
    throw new Error('Hermes adapter is Blocked: no verified headless interface. Refusing to invoke.');
  },
  parseEvents() {
    return [];
  },
  finalize() {
    return { finalText: '', sessionId: null };
  },
  async diagnostics() {
    const d = await this.discover();
    return { installed: d.found, path: d.realPath, note: 'blocked; not invocable' };
  },
};
