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
import { execFileSync, spawnSync } from 'node:child_process';
import { TrustLevel, Readiness, Capability, CapabilityState, capabilityMap, normEvent } from './contract.mjs';
import { buildChildEnv } from '../process/env-policy.mjs';
import { executeProcessTurn } from './exec.mjs';
import { redact, stripControl } from '../security/redact.mjs';

// Probes run with a MINIMAL environment (base allowlist only), never the full parent
// environment, and never inherit unrelated provider secrets.
const PROBE_ENV = () => buildChildEnv({}).env;
const MODEL_CATALOG_SOURCE = Object.freeze({
  BUNDLED: 'codex debug models (bundled)',
  REFRESHED: 'codex debug models (refreshed)',
});

function safeCatalogText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const safe = redact(stripControl(value)).trim().slice(0, maxLength);
  return safe || null;
}

function frontierFromDescription(description) {
  if (!description) return false;
  // A model is marked frontier only when the provider itself makes the stronger
  // "latest frontier" claim. Merely saying "frontier" is insufficient.
  return /\blatest\b[\s\S]*\bfrontier\b|\bfrontier\b[\s\S]*\blatest\b/i.test(description);
}

/** Project Codex's raw catalog onto the safe fields moh is allowed to persist. */
export function sanitizeCodexModelCatalog(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const input = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  const models = [];
  const seen = new Set();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const slug = safeCatalogText(item.slug, 200);
    if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const displayName = safeCatalogText(item.display_name ?? item.displayName, 200) || slug;
    const description = safeCatalogText(item.description, 1000) || '';
    const defaultReasoningEffort = safeCatalogText(
      item.default_reasoning_level ?? item.defaultReasoningEffort ?? item.defaultReasoningLevel,
      50,
    );
    const rawEfforts = item.supported_reasoning_levels ?? item.supportedReasoningEfforts ?? item.supportedReasoningLevels;
    const supportedReasoningEfforts = [...new Set((Array.isArray(rawEfforts) ? rawEfforts : [])
      .map((entry) => safeCatalogText(typeof entry === 'string' ? entry : entry?.effort ?? entry?.level, 50))
      .filter(Boolean))];
    models.push({
      slug,
      displayName,
      description,
      frontier: frontierFromDescription(description),
      defaultReasoningEffort,
      supportedReasoningEfforts,
    });
  }
  return models;
}

function probeLoginStatus(exe) {
  const result = spawnSync(exe, ['login', 'status'], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: PROBE_ENV(),
    maxBuffer: 256 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
  if (/unknown command|unrecognized|unexpected argument|invalid command/.test(output)) {
    return { supported: false, loggedIn: false };
  }
  if (/not logged in|not authenticated|no active (?:login|session)|login required/.test(output)) {
    return { supported: true, loggedIn: false };
  }
  // The official command exits successfully only for an active login. Its text can
  // contain account details, so none of it is retained or returned.
  if (result.status === 0 || /logged in|authenticated/.test(output)) {
    return { supported: true, loggedIn: true };
  }
  return { supported: false, loggedIn: false };
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
      return execFileSync(exe, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], env: PROBE_ENV() });
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };
  const root = help(['--help']);
  const exec = help(['exec', '--help']);
  const models = help(['debug', 'models', '--help']);
  const both = root + '\n' + exec;
  return {
    hasExec: /\bexec\b/.test(root),
    json: /--json\b/.test(both),
    model: /--model\b/.test(both),
    config: /(?:^|[\s,])--config(?=$|[\s,=<])|(?:^|[\s,])-c(?=$|[\s,=<])/m.test(both),
    sandbox: /--sandbox\b/.test(both),
    // Profile is a global Codex option. Detect it from root help so we can place
    // it before the subcommand instead of relying on permissive argument parsing.
    profile: /--profile(?=$|[\s,=<])/m.test(root),
    cd: /(--cd\b|-C\b)/.test(both),
    modelDiscovery: /raw model catalog|--bundled\b/i.test(models),
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
      const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 8000, env: PROBE_ENV() }).trim();
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
    const login = probeLoginStatus(exe);
    if (!flags.hasExec || !flags.json) {
      return {
        readiness: Readiness.EXPERIMENTAL,
        authLabel: login.supported ? (login.loggedIn ? 'Codex native login (delegated)' : 'Codex native login required') : 'readiness unknown',
        detail: 'Installed Codex CLI does not expose a verified JSON exec interface; adapter is experimental for this version.',
      };
    }
    if (login.supported) {
      return login.loggedIn
        ? { readiness: Readiness.READY, authLabel: 'Codex native login (delegated)', detail: 'Confirmed by `codex login status`; account identifiers were discarded.' }
        : { readiness: Readiness.NEEDS_LOGIN, authLabel: 'Codex native login required', detail: 'Run `codex login` first.' };
    }
    // Safe fallback for older CLIs without `login status`: check directory presence,
    // never credential contents or values.
    const cfg = join(homedir(), '.codex');
    if (existsSync(cfg)) return { readiness: Readiness.READY, authLabel: 'Codex native login (delegated, unverified)', detail: 'The installed CLI lacks the official status probe; native authorization will be confirmed by the first real turn.' };
    return { readiness: Readiness.NEEDS_LOGIN, authLabel: 'Codex native login required', detail: 'Run `codex login` first.' };
  },

  /** Model discovery. Current Codex exposes this command only outside profiles. */
  async discoverModels({ refresh = false, profile = null } = {}) {
    const checkedAt = new Date().toISOString();
    const profileScoped = profile !== null && profile !== undefined && profile !== '';
    if (profileScoped) {
      throw new Error('installed Codex CLI does not support profile-scoped `debug models`; verify profile model selection at runtime');
    }
    const source = refresh ? MODEL_CATALOG_SOURCE.REFRESHED : MODEL_CATALOG_SOURCE.BUNDLED;
    const exe = resolveExe();
    if (!exe) return { models: [], source, checkedAt };
    const argv = ['debug', 'models'];
    if (!refresh) argv.push('--bundled');
    const result = spawnSync(exe, argv, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: PROBE_ENV(),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return { models: [], source, checkedAt };
    }
    return { models: sanitizeCodexModelCatalog(result.stdout), source, checkedAt };
  },
  capabilities() {
    const exe = resolveExe();
    const flags = exe ? detectFlags(exe) : {};
    const yn = (b) => (b ? CapabilityState.SUPPORTED : CapabilityState.UNKNOWN);
    return capabilityMap({
      [Capability.STRUCTURED_STREAMING]: yn(flags.json),
      [Capability.FINAL_TEXT_ONLY]: yn(flags.hasExec),
      [Capability.EXPLICIT_MODEL_SELECTION]: yn(flags.model),
      [Capability.MODEL_DISCOVERY]: yn(flags.modelDiscovery),
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
    const argv = [];
    if (ctx.profile !== undefined && ctx.profile !== null && ctx.profile !== '') {
      if (!flags.profile) {
        throw new Error('installed codex CLI lacks global `--profile` support; cannot honor requested profile');
      }
      argv.push('--profile', String(ctx.profile));
    }
    argv.push('exec');
    if (flags.json) argv.push('--json');
    if (ctx.requestedModel !== undefined && ctx.requestedModel !== null && ctx.requestedModel !== '') {
      if (!flags.model) {
        throw new Error('installed codex CLI lacks `--model` support; cannot honor requested model');
      }
      argv.push('--model', String(ctx.requestedModel));
    }
    if (ctx.requestedEffort !== undefined && ctx.requestedEffort !== null) {
      if (!flags.config) {
        throw new Error('installed codex CLI lacks `--config`/`-c` support; cannot honor requested reasoning effort');
      }
      // Codex parses the value after '=' as TOML. JSON string encoding is also a
      // valid TOML basic string and keeps the complete override in one inert argv
      // element; the shared process supervisor always spawns with shell:false.
      argv.push('--config', `model_reasoning_effort=${JSON.stringify(String(ctx.requestedEffort))}`);
    }
    if (flags.sandbox && ctx.sandbox && ctx.sandbox !== 'unknown') argv.push('--sandbox', String(ctx.sandbox));
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
