// Codex CLI adapter. Codex is NOT installed on the build machine, so this adapter
// honestly reports MISSING here. To avoid inventing flags, when Codex IS present it
// DETECTS supported flags from the installed `codex --help` / `codex exec --help`
// output (capability negotiation) and only uses flags it actually observes. The
// JSONL parser is tolerant/best-effort and marks runtime-model observation UNKNOWN
// until proven against a real installed CLI. We reuse Codex's native login and never
// inherit unrelated provider secrets.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { TrustLevel, Readiness, Capability, CapabilityState, capabilityMap, normEvent } from './contract.mjs';
import { executeProcessTurn } from './exec.mjs';

function onPath(name) {
  try {
    const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split('\n')[0].trim();
    return p || null;
  } catch {
    return null;
  }
}

function resolveExe() {
  const candidates = [
    process.env.MOH_CODEX_PATH, // explicit MOH config
    process.env.CODEX_PATH, // env override
    onPath('codex'), // PATH
    // macOS application-bundled fallback (documented location; only used if present):
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), '.codex', 'bin', 'codex'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return realpathSync(c);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Detect which flags the installed Codex actually supports (no invention). */
function detectFlags(exe) {
  const help = (args) => {
    try {
      return execFileSync(exe, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };
  const root = help(['--help']);
  const exec = help(['exec', '--help']);
  const both = root + '\n' + exec;
  return {
    hasExec: /\bexec\b/.test(root),
    json: /--json\b/.test(both),
    model: /--model\b/.test(both),
    sandbox: /--sandbox\b/.test(both),
    profile: /--profile\b/.test(both),
    cd: /(--cd\b|-C\b)/.test(both),
  };
}

// Best-effort tolerant JSONL parser. Handles several plausible shapes without
// crashing on unknowns; captures text/model/session where clearly present.
export function codexParseEvents(chunk, state) {
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
      continue; // ignore non-JSON decorative lines
    }
    const msg = ev.msg || ev;
    const sid = ev.thread_id || ev.session_id || msg.thread_id || msg.session_id;
    if (sid) state.sessionId = sid;
    const model = ev.model || msg.model;
    if (model) out.push(normEvent('model', { reportedModel: model, evidenceSource: 'codex.jsonl' }));
    // Text-bearing fields across plausible shapes.
    const text = pickText(ev) ?? pickText(msg);
    if (text) out.push(normEvent('text', { text }));
    if (ev.type === 'item.completed' || msg.type === 'agent_message' || ev.type === 'result') {
      if (text) state.finalText = text;
    }
    if (ev.type === 'turn.completed' || ev.type === 'result' || msg.type === 'task_complete') {
      out.push(normEvent('final', { finalText: state.finalText || text || '', sessionId: state.sessionId || null }));
    }
  }
  return out;
}

function pickText(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.text === 'string') return o.text;
  if (typeof o.message === 'string') return o.message;
  if (o.item && typeof o.item.text === 'string') return o.item.text;
  return null;
}

export const codexCliAdapter = {
  id: 'codex-cli',
  displayName: 'Codex CLI',
  version: '0.1.0',
  contractVersion: 1,
  trustLevel: TrustLevel.BUILTIN,

  async discover() {
    const realPath = resolveExe();
    return { found: !!realPath, path: realPath, realPath };
  },
  async probeVersion() {
    const exe = resolveExe();
    if (!exe) return { version: null };
    try {
      const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000 }).trim();
      const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(out);
      return { version: m ? m[1] : out };
    } catch (e) {
      return { version: null, error: e.message };
    }
  },
  async probeReadiness() {
    const exe = resolveExe();
    if (!exe) return { readiness: Readiness.MISSING, authLabel: 'not installed', detail: 'Install Codex CLI and ensure `codex` is on PATH, or set MOH_CODEX_PATH.' };
    const flags = detectFlags(exe);
    if (!flags.hasExec || !flags.json) {
      return { readiness: Readiness.EXPERIMENTAL, authLabel: 'readiness unknown', detail: 'Installed Codex CLI does not expose a verified JSON exec interface; adapter is experimental for this version.' };
    }
    // Codex stores its own login under ~/.codex; presence is a non-secret signal only.
    const cfg = join(homedir(), '.codex');
    if (existsSync(cfg)) return { readiness: Readiness.READY, authLabel: 'Codex login (delegated)', detail: 'Reusing Codex native authorization.' };
    return { readiness: Readiness.NEEDS_LOGIN, authLabel: 'authentication unknown', detail: 'Run `codex login` first.' };
  },
  capabilities() {
    const exe = resolveExe();
    const flags = exe ? detectFlags(exe) : {};
    const yn = (b) => (b ? CapabilityState.SUPPORTED : CapabilityState.UNKNOWN);
    return capabilityMap({
      [Capability.STRUCTURED_STREAMING]: yn(flags.json),
      [Capability.FINAL_TEXT_ONLY]: yn(flags.hasExec),
      [Capability.EXPLICIT_MODEL_SELECTION]: yn(flags.model),
      [Capability.PROVIDER_SELECTION]: yn(flags.profile),
      [Capability.SANDBOX_CONTROLS]: yn(flags.sandbox),
      [Capability.RUNTIME_MODEL_OBSERVATION]: CapabilityState.UNKNOWN, // unverified on this build
      [Capability.NATIVE_RESUME]: CapabilityState.UNKNOWN,
      [Capability.WORKSPACE_ISOLATION]: CapabilityState.SUPPORTED,
      [Capability.INTERACTIVE_AUTH]: CapabilityState.SUPPORTED,
    });
  },
  prepareInvocation(ctx) {
    const exe = resolveExe();
    if (!exe) throw new Error('codex executable not found');
    const flags = detectFlags(exe);
    if (!flags.hasExec) throw new Error('installed codex CLI lacks a non-interactive `exec` subcommand');
    const argv = ['exec'];
    if (flags.json) argv.push('--json');
    if (flags.model && ctx.requestedModel) argv.push('--model', String(ctx.requestedModel));
    if (flags.sandbox && ctx.sandbox && ctx.sandbox !== 'unknown') argv.push('--sandbox', String(ctx.sandbox));
    if (flags.profile && ctx.profile) argv.push('--profile', String(ctx.profile));
    // Prompt via stdin to keep it out of the process listing.
    return { executable: exe, argv, env: {}, authEnvNames: [], stdinPrompt: true };
  },
  parseEvents: codexParseEvents,
  finalize(state) {
    return { finalText: state.finalText || '', sessionId: state.sessionId || null };
  },
  async runTurn(ctx, hooks) {
    return executeProcessTurn(this, ctx, hooks);
  },
  async diagnostics() {
    const d = await this.discover();
    return { installed: d.found, path: d.realPath };
  },
};
