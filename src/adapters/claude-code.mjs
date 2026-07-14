// Claude Code adapter. Flags below were verified against the locally installed
// `claude --help` (v2.1.x): -p/--print, --output-format stream-json, --model,
// --effort, --permission-mode {acceptEdits,auto,bypassPermissions,manual,dontAsk,plan},
// --resume, --fork-session, --json-schema. We reuse Claude's own login/keychain;
// we NEVER copy or read its credentials, and never silently pass --dangerously-skip-permissions.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { TrustLevel, Readiness, Capability, CapabilityState, capabilityMap, normEvent } from './contract.mjs';
import { authPresent } from '../process/env-policy.mjs';
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
    process.env.MOH_CLAUDE_PATH, // explicit MOH config first
    onPath('claude'), // then PATH
    join(homedir(), '.local', 'bin', 'claude'), // documented fallbacks
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
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

// --- stream-json parser: tolerant of unknown fields & event types, byte-safe (input is decoded) ---
export function claudeParseEvents(chunk, state) {
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
      out.push(normEvent('notice', { level: 'debug', message: 'non-JSON stream line ignored' }));
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) state.sessionId = ev.session_id;
      if (ev.model) out.push(normEvent('model', { reportedModel: ev.model, evidenceSource: 'stream.system.init' }));
    } else if (ev.type === 'assistant' && ev.message) {
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const c of content) {
        if (c.type === 'text' && c.text) out.push(normEvent('text', { text: c.text }));
        else if (c.type === 'tool_use') out.push(normEvent('tool', { name: c.name, summary: summarizeTool(c) }));
      }
      if (ev.message.model) out.push(normEvent('model', { reportedModel: ev.message.model, evidenceSource: 'stream.assistant.message' }));
    } else if (ev.type === 'result') {
      if (ev.session_id) state.sessionId = ev.session_id;
      if (typeof ev.result === 'string') state.finalText = ev.result;
      state.usage = ev.usage || state.usage || null;
      // modelUsage is keyed by model id — a reliable runtime model signal when present.
      if (ev.modelUsage && typeof ev.modelUsage === 'object') {
        const ids = Object.keys(ev.modelUsage);
        if (ids.length) out.push(normEvent('model', { reportedModel: ids[0], evidenceSource: 'stream.result.modelUsage', usage: ev.usage || null }));
      }
      out.push(normEvent('final', { finalText: state.finalText || '', sessionId: state.sessionId || null, usage: ev.usage || null }));
    }
    // Unknown types are ignored (forward-compatible).
  }
  return out;
}

function summarizeTool(c) {
  const name = c.name || 'tool';
  const inp = c.input || {};
  if (inp.file_path) return `${name} ${inp.file_path}`;
  if (inp.command) return `${name} (command)`;
  return name;
}

export const claudeCodeAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
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

  // OFFLINE readiness — no tokens spent. Determines a sanitized auth LABEL only.
  async probeReadiness() {
    const exe = resolveExe();
    if (!exe) return { readiness: Readiness.MISSING, authLabel: 'not installed', detail: 'Install Claude Code and ensure `claude` is on PATH, or set MOH_CLAUDE_PATH.' };
    if (authPresent('ANTHROPIC_API_KEY')) {
      return { readiness: Readiness.READY, authLabel: 'ANTHROPIC_API_KEY present', detail: 'Using API key from environment (value never read by moh).' };
    }
    // Delegated login: Claude stores its own credentials; we only check for the
    // presence of its config dir, never read secrets.
    const cfg = join(homedir(), '.claude');
    if (existsSync(cfg)) {
      return { readiness: Readiness.READY, authLabel: 'Claude subscription/login (delegated)', detail: 'Reusing Claude Code native authorization. Run a real turn to confirm.' };
    }
    return { readiness: Readiness.NEEDS_LOGIN, authLabel: 'authentication unknown', detail: 'Run `claude` once to log in, or set ANTHROPIC_API_KEY.' };
  },

  capabilities() {
    return capabilityMap({
      [Capability.STRUCTURED_STREAMING]: CapabilityState.SUPPORTED,
      [Capability.FINAL_TEXT_ONLY]: CapabilityState.SUPPORTED,
      [Capability.NATIVE_RESUME]: CapabilityState.SUPPORTED, // --resume verified
      [Capability.EXPLICIT_MODEL_SELECTION]: CapabilityState.SUPPORTED, // --model verified
      [Capability.MODEL_DISCOVERY]: CapabilityState.UNKNOWN, // no offline list command verified
      [Capability.RUNTIME_MODEL_OBSERVATION]: CapabilityState.SUPPORTED, // stream system.init/result
      [Capability.TOOL_EVENTS]: CapabilityState.SUPPORTED,
      [Capability.USAGE_REPORTING]: CapabilityState.SUPPORTED, // result.usage
      [Capability.SANDBOX_CONTROLS]: CapabilityState.SUPPORTED, // --permission-mode
      [Capability.APPROVAL_CONTROLS]: CapabilityState.SUPPORTED,
      [Capability.PROVIDER_SELECTION]: CapabilityState.UNKNOWN,
      [Capability.NETWORK_POLICY_CONTROLS]: CapabilityState.UNKNOWN,
      [Capability.INTERACTIVE_AUTH]: CapabilityState.SUPPORTED,
      [Capability.WORKSPACE_ISOLATION]: CapabilityState.SUPPORTED, // per-seat cwd
    });
  },

  prepareInvocation(ctx) {
    const exe = resolveExe();
    if (!exe) throw new Error('claude executable not found');
    const argv = ['--print', '--output-format', 'stream-json', '--verbose'];
    // Permission mode is a VISIBLE seat setting; default is the non-dangerous acceptEdits.
    const mode = ctx.permissionMode || 'acceptEdits';
    argv.push('--permission-mode', mode);
    if (ctx.requestedModel) argv.push('--model', String(ctx.requestedModel));
    if (ctx.requestedEffort) argv.push('--effort', String(ctx.requestedEffort));
    if (ctx.resume?.sessionId) {
      argv.push('--resume', String(ctx.resume.sessionId));
      if (ctx.resume.fork) argv.push('--fork-session');
    }
    // Prompt via stdin — keeps large/sensitive prompts out of the process listing.
    return {
      executable: exe,
      argv,
      env: {},
      authEnvNames: ['ANTHROPIC_API_KEY'], // ONLY this auth var may be forwarded
      stdinPrompt: true,
    };
  },

  parseEvents: claudeParseEvents,
  finalize(state) {
    return { finalText: state.finalText || '', sessionId: state.sessionId || null, usage: state.usage || null, reportedModel: state.reportedModel || null };
  },
  async runTurn(ctx, hooks) {
    return executeProcessTurn(this, ctx, hooks);
  },
  async diagnostics() {
    const d = await this.discover();
    const v = d.found ? await this.probeVersion() : { version: null };
    return { installed: d.found, path: d.realPath, version: v.version };
  },
};
