// Claude Code adapter. Flags below were verified against the locally installed
// `claude --help` (v2.1.x): -p/--print, --output-format stream-json, --model,
// --effort, --permission-mode {acceptEdits,auto,bypassPermissions,default,dontAsk,plan},
// --resume, --fork-session, --json-schema. We reuse Claude's own login/keychain;
// we NEVER copy or read its credentials, and never silently pass --dangerously-skip-permissions.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { TrustLevel, Readiness, Capability, CapabilityState, capabilityMap, normEvent } from './contract.mjs';
import { authPresent, buildChildEnv } from '../process/env-policy.mjs';
import { executeProcessTurn } from './exec.mjs';

// Probes run with a MINIMAL environment (base allowlist only) — never the full
// parent environment. Version/help output does not need caller secrets.
const PROBE_ENV = () => buildChildEnv({}).env;

export const ClaudeAuthMode = Object.freeze({
  NATIVE: 'native',
  API_KEY_ENV: 'api_key_env',
  OAUTH_TOKEN_ENV: 'oauth_token_env',
});

function normalizeAuthMode(value) {
  if (value == null || value === '') return ClaudeAuthMode.NATIVE;
  const mode = String(value).trim().toLowerCase().replaceAll('-', '_');
  if (['native', 'delegated', 'native_login', 'delegated_native_login'].includes(mode)) return ClaudeAuthMode.NATIVE;
  if (['api_key', 'api_key_env', 'anthropic_api_key'].includes(mode)) return ClaudeAuthMode.API_KEY_ENV;
  if (['oauth', 'oauth_token', 'oauth_token_env', 'claude_code_oauth_token'].includes(mode)) return ClaudeAuthMode.OAUTH_TOKEN_ENV;
  throw new Error(`unsupported Claude authMode: ${value}`);
}

const CLAUDE_AUTH_ENV_ALLOWLIST = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

function safeEnvNames(names) {
  if (!Array.isArray(names)) return [];
  return [...new Set(names.filter((name) => CLAUDE_AUTH_ENV_ALLOWLIST.has(name)))];
}

/** Resolve the only auth environment variable names a Claude child may inherit. */
export function claudeAuthEnvNames(ctx = {}) {
  // Once authMode exists it is authoritative. This prevents a stale or forged
  // authEnvNames list from smuggling unrelated parent secrets into the child.
  if (ctx.authMode !== undefined && ctx.authMode !== null && ctx.authMode !== '') {
    const mode = normalizeAuthMode(ctx.authMode);
    if (mode === ClaudeAuthMode.API_KEY_ENV) return ['ANTHROPIC_API_KEY'];
    if (mode === ClaudeAuthMode.OAUTH_TOKEN_ENV) return ['CLAUDE_CODE_OAUTH_TOKEN'];
    return [];
  }
  // Legacy configs predate authMode. Accept at most one of the two historical,
  // fixed Claude auth names; arbitrary uppercase names are never forwarded.
  const explicit = safeEnvNames(ctx.authEnvNames);
  if (explicit.includes('ANTHROPIC_API_KEY')) return ['ANTHROPIC_API_KEY'];
  if (explicit.includes('CLAUDE_CODE_OAUTH_TOKEN')) return ['CLAUDE_CODE_OAUTH_TOKEN'];
  return [];
}

function probeNativeAuth(exe) {
  const result = spawnSync(exe, ['auth', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: PROBE_ENV(),
    maxBuffer: 256 * 1024,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout) {
    try {
      const status = JSON.parse(stdout);
      // Deliberately project only the boolean. The official response can also
      // contain email, organization, subscription, and provider identifiers.
      if (status && typeof status === 'object' && typeof status.loggedIn === 'boolean') {
        return { supported: true, loggedIn: status.loggedIn };
      }
    } catch {
      /* unsupported/older output; use the safe fallback below */
    }
  }
  const diagnostic = `${result.stderr || ''}\n${stdout}`.toLowerCase();
  if (/unknown command|unrecognized|unexpected argument|invalid command/.test(diagnostic)) {
    return { supported: false, loggedIn: false };
  }
  return { supported: false, loggedIn: false };
}

function modelEvent(out, state, reportedModel, evidenceSource, extra = {}) {
  if (typeof reportedModel !== 'string' || !reportedModel.trim()) return;
  const model = reportedModel.trim();
  state.reportedModel = model;
  if (!Array.isArray(state.reportedModels)) state.reportedModels = [];
  if (!state.reportedModels.includes(model)) state.reportedModels.push(model);
  out.push(normEvent('model', { reportedModel: model, evidenceSource, ...extra }));
}

function onPath(name) {
  try {
    const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', env: PROBE_ENV() }).split('\n')[0].trim();
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
      modelEvent(out, state, ev.model, 'stream.system.init');
    } else if (ev.type === 'assistant' && ev.message) {
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const c of content) {
        if (c.type === 'text' && c.text) out.push(normEvent('text', { text: c.text }));
        else if (c.type === 'tool_use') out.push(normEvent('tool', { name: c.name, summary: summarizeTool(c) }));
      }
      modelEvent(out, state, ev.message.model, 'stream.assistant.message');
    } else if (ev.type === 'result') {
      if (ev.session_id) state.sessionId = ev.session_id;
      if (typeof ev.result === 'string') state.finalText = ev.result;
      state.usage = ev.usage || state.usage || null;
      modelEvent(out, state, ev.model, 'stream.result.model', { usage: ev.usage || null });
      // modelUsage is an aggregate map, not an ordered execution trace. It can
      // include auxiliary models, so use it only as a fallback when it names one
      // unambiguous model and no primary runtime event reported a model.
      if (!state.reportedModel && ev.modelUsage && typeof ev.modelUsage === 'object') {
        const ids = Object.keys(ev.modelUsage).filter(Boolean);
        if (ids.length === 1) modelEvent(out, state, ids[0], 'stream.result.modelUsage', { usage: ev.usage || null });
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
      const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000, env: PROBE_ENV() }).trim();
      const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(out);
      return { version: m ? m[1] : out };
    } catch (e) {
      return { version: null, error: e.message };
    }
  },

  // OFFLINE readiness — no tokens spent. Determines a sanitized auth LABEL only.
  async probeReadiness(options = {}) {
    const exe = resolveExe();
    if (!exe) return { readiness: Readiness.MISSING, authLabel: 'not installed', detail: 'Install Claude Code and ensure `claude` is on PATH, or set MOH_CLAUDE_PATH.' };

    const explicit = claudeAuthEnvNames(options);
    if (explicit.length) {
      const present = explicit.find((name) => authPresent(name));
      if (present) return { readiness: Readiness.READY, authLabel: `${present} present`, detail: 'Using an explicitly configured authentication environment variable (value never read by moh).' };
      return { readiness: Readiness.NEEDS_LOGIN, authLabel: 'configured auth environment missing', detail: 'Set one of the explicitly configured authentication environment variables.' };
    }

    const authMode = normalizeAuthMode(options.authMode);
    if (authMode === ClaudeAuthMode.API_KEY_ENV) {
      return authPresent('ANTHROPIC_API_KEY')
        ? { readiness: Readiness.READY, authLabel: 'ANTHROPIC_API_KEY present', detail: 'Using the explicitly selected API-key environment mode (value never read by moh).' }
        : { readiness: Readiness.NEEDS_LOGIN, authLabel: 'ANTHROPIC_API_KEY missing', detail: 'Set ANTHROPIC_API_KEY or select delegated native login.' };
    }
    if (authMode === ClaudeAuthMode.OAUTH_TOKEN_ENV) {
      return authPresent('CLAUDE_CODE_OAUTH_TOKEN')
        ? { readiness: Readiness.READY, authLabel: 'CLAUDE_CODE_OAUTH_TOKEN present', detail: 'Using the explicitly selected OAuth-token environment mode (value never read by moh).' }
        : { readiness: Readiness.NEEDS_LOGIN, authLabel: 'CLAUDE_CODE_OAUTH_TOKEN missing', detail: 'Set CLAUDE_CODE_OAUTH_TOKEN or select delegated native login.' };
    }

    // Native login is the default. The official status command is authoritative
    // when supported, and only its boolean is retained.
    const native = probeNativeAuth(exe);
    if (native.supported) {
      return native.loggedIn
        ? { readiness: Readiness.READY, authLabel: 'Claude native login (delegated)', detail: 'Confirmed by `claude auth status --json`; account identifiers were discarded.' }
        : { readiness: Readiness.NEEDS_LOGIN, authLabel: 'Claude native login required', detail: 'Run `claude auth login`.' };
    }

    // Older CLIs may not expose `auth status`. Directory presence is a deliberately
    // weak fallback: no credential files or values are read.
    const cfg = join(homedir(), '.claude');
    if (existsSync(cfg)) {
      return { readiness: Readiness.READY, authLabel: 'Claude native login (delegated, unverified)', detail: 'The installed CLI lacks the official status probe; native authorization will be confirmed by the first real turn.' };
    }
    return { readiness: Readiness.NEEDS_LOGIN, authLabel: 'Claude native login required', detail: 'Run `claude auth login`, or explicitly select an environment-based auth mode.' };
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
      // --permission-mode controls approvals, not filesystem/network sandboxing.
      [Capability.SANDBOX_CONTROLS]: CapabilityState.UNKNOWN,
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
    const argv = ['--print', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local'];
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
      authMode: normalizeAuthMode(ctx.authMode),
      authEnvNames: claudeAuthEnvNames(ctx),
      stdinPrompt: true,
    };
  },

  parseEvents: claudeParseEvents,
  finalize(state) {
    return { finalText: state.finalText || '', sessionId: state.sessionId || null, usage: state.usage || null, reportedModel: state.reportedModel || null, reportedModels: state.reportedModels || [] };
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
