// External-adapter protocol (versioned JSONL over stdio). Lets contributors add a
// harness WITHOUT editing the orchestrator. Enabling a third-party adapter means
// trusting local code, so it requires EXPLICIT opt-in (opts.trust === true or
// MOH_ALLOW_EXTERNAL_ADAPTERS=1). Protocol spec: docs/PROTOCOL.md.
import { realpathSync, existsSync, statSync, readFileSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { TrustLevel, Readiness, capabilityMap, normEvent } from './contract.mjs';
import { executeProcessTurn } from './exec.mjs';

export const EXTERNAL_PROTOCOL_VERSION = 1;

/** Parse the adapter's JSONL stdout into normalized events. Tolerant of unknowns. */
export function externalParseEvents(chunk, state) {
  state.buf = (state.buf || '') + chunk;
  const out = [];
  let nl;
  while ((nl = state.buf.indexOf('\n')) !== -1) {
    const line = state.buf.slice(0, nl).trim();
    state.buf = state.buf.slice(nl + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // ignore non-protocol noise
    }
    switch (ev.type) {
      case 'ready':
        state.ready = true;
        state.reportedCapabilities = ev.capabilities || null;
        break;
      case 'text':
        if (typeof ev.text === 'string') out.push(normEvent('text', { text: ev.text }));
        break;
      case 'tool':
        out.push(normEvent('tool', { name: ev.name, summary: ev.summary }));
        break;
      case 'model':
        if (ev.reportedModel) out.push(normEvent('model', { reportedModel: ev.reportedModel, evidenceSource: ev.evidenceSource || 'external.protocol', usage: ev.usage || null }));
        break;
      case 'final':
        state.finalText = String(ev.finalText ?? '');
        state.sessionId = ev.sessionId ?? state.sessionId ?? null;
        out.push(normEvent('final', { finalText: state.finalText, sessionId: state.sessionId }));
        break;
      case 'notice':
        out.push(normEvent('notice', { level: ev.level || 'info', message: ev.message }));
        break;
      default:
        break; // forward-compatible: ignore unknown types
    }
  }
  return out;
}

/**
 * Load an external adapter from a JSON manifest:
 *   { id, displayName, version, executable, argv, capabilities, trustLevel }
 * Paths in the manifest are resolved relative to the manifest file.
 */
export function loadExternalAdapter(manifestPath, opts = {}) {
  const allowed = opts.trust === true || process.env.MOH_ALLOW_EXTERNAL_ADAPTERS === '1';
  if (!allowed) {
    throw new Error('external adapters are disabled. Enable explicitly with MOH_ALLOW_EXTERNAL_ADAPTERS=1 (you are trusting local code).');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const baseDir = dirname(resolve(manifestPath));
  const exe = isAbsolute(manifest.executable) ? manifest.executable : resolve(baseDir, manifest.executable);
  if (!existsSync(exe) || !statSync(exe).isFile()) throw new Error(`external adapter executable not found: ${exe}`);
  const realExe = realpathSync(exe);
  const argv = Array.isArray(manifest.argv) ? manifest.argv.map(String) : [];
  const caps = capabilityMap(manifest.capabilities || {});

  return {
    id: manifest.id,
    displayName: manifest.displayName || manifest.id,
    version: manifest.version || '0.0.0',
    contractVersion: 1,
    trustLevel: TrustLevel.THIRD_PARTY,
    protocolVersion: EXTERNAL_PROTOCOL_VERSION,

    async discover() {
      return { found: true, path: realExe, realPath: realExe };
    },
    async probeVersion() {
      return { version: manifest.version || null };
    },
    async probeReadiness() {
      return { readiness: Readiness.EXPERIMENTAL, authLabel: 'third-party (trusted by opt-in)', detail: 'External adapter enabled by explicit user opt-in.' };
    },
    capabilities() {
      return caps;
    },
    prepareInvocation(ctx) {
      // The whole turn request is delivered on stdin as one JSON line.
      const turn = {
        moh: String(EXTERNAL_PROTOCOL_VERSION),
        type: 'turn',
        turn: {
          seatId: ctx.seatId,
          role: ctx.role,
          prompt: ctx.prompt,
          workspaceDir: ctx.workspaceDir,
          requestedModel: ctx.requestedModel ?? null,
          requestedEffort: ctx.requestedEffort ?? null,
        },
      };
      return { executable: realExe, argv, env: {}, authEnvNames: manifest.authEnvNames || [], stdin: JSON.stringify(turn) + '\n' };
    },
    parseEvents: externalParseEvents,
    finalize(state) {
      return { finalText: state.finalText || '', sessionId: state.sessionId || null };
    },
    async runTurn(ctx, hooks) {
      return executeProcessTurn(this, ctx, hooks);
    },
  };
}
