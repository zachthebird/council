// Loopback web companion. Same core, same events as the TUI. Security:
//  - binds 127.0.0.1 (0.0.0.0 only via explicit --dangerously-expose with warning)
//  - unguessable per-launch capability, delivered as an HttpOnly SameSite=Strict
//    cookie (never in URL / HTML / localStorage / SSE)
//  - canonical loopback Host validation (DNS-rebinding defense)
//  - Origin validation + custom-header requirement on mutations (CSRF defense)
//  - no permissive CORS, restrictive CSP, locally-bundled assets
//  - harness/repo content HTML-escaped; no secrets in responses/events
import { createServer } from 'node:http';
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Application } from '../core/app.mjs';
import { sanitizeRuntimeMetadata } from '../core/provenance.mjs';
import { isSafeRunId, isSafeSegment } from '../core/ids.mjs';
import { Preset } from '../core/state.mjs';
import { RunStore } from '../storage/store.mjs';
import { legacyCouncilDirs } from '../storage/paths.mjs';
import { migrateCouncilRun, scanLegacyCouncil } from '../storage/migrate.mjs';
import { doctor } from '../cli/doctor.mjs';
import { getAdapter, listAdapters } from '../adapters/registry.mjs';
import { loadConfig, saveConfig } from '../tui/config.mjs';
import { redact, redactDeep, sanitizeGitUrl, stripControl } from '../security/redact.mjs';
import { parseFlags } from '../cli/args.mjs';
import { out, err, c } from '../cli/ui.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TASK_CHARS = 64 * 1024;
const CAPABILITY_STATES = new Set(['supported', 'unsupported', 'unknown', 'experimental', 'blocked']);
const MODEL_POLICY_ALIASES = new Map([
  ['harness_default', 'harness_default'],
  ['harness-default', 'harness_default'],
  ['default', 'harness_default'],
  ['pinned', 'pinned'],
  ['explicit', 'pinned'],
  ['user', 'pinned'],
  ['catalog_frontier', 'catalog_frontier'],
  ['catalog-frontier', 'catalog_frontier'],
  ['frontier', 'catalog_frontier'],
  ['latest_frontier', 'catalog_frontier'],
  ['latest-frontier', 'catalog_frontier'],
]);
const SERVER_OBSERVED_MODEL_FIELDS = Object.freeze([
  'configuredModel',
  'requestedModelSource',
  'modelCatalog',
  'catalogEvidence',
  'modelCatalogSource',
  'modelCatalogCheckedAt',
  'modelClaim',
]);

const AUTH_GUIDANCE = Object.freeze({
  fake: {
    defaultMode: 'none',
    instructions: 'No authentication is required; the deterministic adapter makes no network calls.',
    modes: [{ id: 'none', label: 'No authentication', envNames: [] }],
  },
  'claude-code': {
    defaultMode: 'delegated',
    instructions: 'Sign in with Claude Code outside moh, or set the selected environment variable before starting moh. Credential values are never accepted by this page.',
    modes: [
      { id: 'delegated', label: 'Reuse Claude Code login', envNames: [] },
      { id: 'api_key_env', label: 'ANTHROPIC_API_KEY from environment', envNames: ['ANTHROPIC_API_KEY'] },
      { id: 'oauth_token_env', label: 'CLAUDE_CODE_OAUTH_TOKEN from environment', envNames: ['CLAUDE_CODE_OAUTH_TOKEN'] },
    ],
  },
  'codex-cli': {
    defaultMode: 'delegated',
    instructions: 'Run `codex login` outside moh (ChatGPT OAuth by default, or the CLI API-key flow), then restart or refresh this page. moh reuses that official CLI session and never reads the credential.',
    modes: [{ id: 'delegated', label: 'Reuse Codex login (OAuth or API key)', envNames: [] }],
  },
});

export async function startWeb(rest) {
  const flags = parseFlags(rest);
  const host = flags['dangerously-expose'] ? '0.0.0.0' : '127.0.0.1';
  if (host === '0.0.0.0') err(c.red('⚠ DANGER: binding 0.0.0.0 exposes moh beyond loopback. Do this only on a trusted, isolated network.'));
  let port = parseInt(flags.port, 10) || 7373;

  const capability = randomBytes(24).toString('base64url');
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
  const store = new RunStore();
  normalizeInterruptedRuns(store);
  const legacyRuns = discoverLegacyRuns(store);

  // In-memory event feed + pending gate decisions. Durable run state remains in RunStore.
  const clients = new Set();
  const pendingDecisions = new Map(); // id -> { kind, resolve, ...validation facts }
  let activeRun = null; // { app, runId, mode }
  let lastRunId = newestRunId(store, legacyRuns);

  function sseData(evt) {
    return `data: ${JSON.stringify(sanitizeRuntimeMetadata(evt))}\n\n`;
  }

  function broadcast(evt) {
    const data = sseData(evt);
    for (const res of clients) res.write(data);
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {}
        return;
      }
      if (e instanceof ApiError) {
        json(res, { ok: false, error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) }, e.status);
      } else {
        json(res, { ok: false, error: 'The web companion could not complete the request.', code: 'internal_error' }, 500);
      }
    }
  });

  function validHost(req) {
    const h = req.headers.host || '';
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || host === '0.0.0.0';
  }

  function hasCapability(req) {
    const cookie = req.headers.cookie || '';
    const m = /(?:^|;\s*)moh_cap=([^;]+)/.exec(cookie);
    return !!m && m[1] === capability;
  }

  function validOrigin(req) {
    const o = req.headers.origin;
    if (!o) return false;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function securityHeaders(extra = {}) {
    return {
      'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      ...extra,
    };
  }

  function json(res, obj, code = 200) {
    res.writeHead(code, securityHeaders({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
    res.end(JSON.stringify(redactWebPayload(obj)));
  }

  function deny(res, code = 'unauthorized', message = 'Capability cookie is missing or invalid.') {
    json(res, { ok: false, error: message, code }, 403);
  }

  function currentSnapshot(requestedRunId = null) {
    const runId = requestedRunId || activeRun?.runId || lastRunId || null;
    if (runId && !isSafeRunId(runId)) throw new ApiError(400, 'invalid_run_id', 'runId is not valid.');
    let state = null;
    let legacy = null;
    if (runId) {
      let storedState;
      try {
        storedState = store.loadState(runId);
      } catch {
        throw new ApiError(400, 'invalid_run_id', 'runId is not valid.');
      }
      if (isNativeMohState(storedState, runId)) state = storedState;
      else legacy = legacyRuns.get(runId) || null;
    }
    const selectedIsActive = !!activeRun && !!runId && activeRun.runId === runId;
    const pendingDecision = selectedIsActive ? [...pendingDecisions.values()].find((pending) => pending.event)?.event || null : null;
    return {
      running: selectedIsActive,
      activeRunId: activeRun?.runId || null,
      runId,
      state: state ? sanitizeState(state) : legacy?.state || null,
      legacy: !!legacy,
      source: legacy ? 'council' : state ? 'moh' : null,
      readOnly: !!legacy,
      quarantined: legacy?.state?.quarantined === true,
      pendingDecision,
    };
  }

  async function bootstrap() {
    const report = await doctor();
    const adapters = await safeAdapterStatuses(report);
    const savedConfig = sanitizeSavedConfig(loadConfig());
    const snapshot = currentSnapshot();
    return {
      doctor: {
        ok: !!report?.ok,
        node: safeDiagnosticString(report?.node),
        platform: safeDiagnosticString(report?.platform),
        git: safeDiagnosticString(report?.git),
        note: 'Readiness probes do not run a model or spend tokens. The refreshed Codex catalog may contact the signed-in service, but performs no inference and returns no credential values or account identifiers.',
      },
      adapters,
      presets: Object.values(Preset),
      seedKinds: ['greenfield', 'local', 'url'],
      exposed: host === '0.0.0.0',
      config: savedConfig,
      savedConfig,
      defaults: savedConfig
        ? { preset: savedConfig.defaultPreset, seats: savedConfig.seats }
        : { preset: Preset.FULL_MIXTURE, seats: [] },
      ...snapshot,
    };
  }

  async function handle(req, res) {
    // DNS-rebinding defense: reject non-canonical Host up front.
    if (!validHost(req)) {
      res.writeHead(421, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      res.end('Misdirected request (invalid Host).');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, securityHeaders({ 'content-type': 'text/html; charset=utf-8', 'set-cookie': `moh_cap=${capability}; HttpOnly; SameSite=Strict; Path=/` }));
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      if (!hasCapability(req)) return deny(res);
      res.writeHead(200, securityHeaders({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }));
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      // A refreshed/reconnected page must be able to recover the active human gate.
      for (const pending of pendingDecisions.values()) if (pending.event) res.write(sseData(pending.event));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      if (!hasCapability(req)) return deny(res);
      json(res, await bootstrap());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!hasCapability(req)) return deny(res);
      json(res, currentSnapshot(url.searchParams.get('runId')));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      if (!hasCapability(req)) return deny(res);
      json(res, { runs: runSummaries(store, activeRun?.runId || null, legacyRuns), activeRunId: activeRun?.runId || null });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!hasCapability(req)) return deny(res);
      const runId = url.searchParams.get('runId');
      if (!runId || !isSafeRunId(runId)) throw new ApiError(404, 'run_not_found', 'Run history was not found.');
      const localRunIds = nativeMohRunIds(store);
      if (!localRunIds.has(runId)) {
        const legacy = legacyRuns.get(runId);
        if (!legacy) throw new ApiError(404, 'run_not_found', 'Run history was not found.');
        // Council events use an incompatible, content-rich schema. Never replay
        // them through the MoH UI: return an explicit empty, read-only history.
        json(res, {
          runId,
          events: [],
          truncated: false,
          integrity: { gaps: [], duplicates: [], torn: 0 },
          legacy: true,
          source: 'council',
          readOnly: true,
          quarantined: legacy.state.quarantined === true,
          note: legacy.state.quarantined
            ? 'Legacy Council activity is unavailable because the state record is quarantined and unparseable.'
            : 'Legacy Council activity is not replayed because its event schema is unattested.',
        });
        return;
      }
      let state;
      try {
        state = store.loadState(runId);
      } catch {
        state = null;
      }
      if (!state) throw new ApiError(404, 'run_not_found', 'Run history was not found.');
      const replay = store.replay(runId);
      const limit = 5_000;
      const events = replay.events.slice(-limit);
      json(res, { runId, events, truncated: replay.events.length > events.length, integrity: { gaps: replay.gaps, duplicates: replay.duplicates, torn: replay.torn } });
      return;
    }

    // --- Mutations: capability + Origin + custom header required ---
    if (req.method === 'POST') {
      if (!hasCapability(req)) return deny(res);
      if (!validOrigin(req)) return deny(res, 'bad_origin', 'Origin must be the canonical loopback web companion origin.');
      if (req.headers['x-moh-csrf'] !== '1') return deny(res, 'missing_csrf_header', 'The X-MOH-CSRF header is required.');
      if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        throw new ApiError(415, 'expected_json', 'Content-Type must be application/json.');
      }
      const body = await readJson(req);

      if (url.pathname === '/api/run') {
        if (activeRun) throw new ApiError(409, 'run_in_progress', `Run ${activeRun.runId || 'starting'} is already in progress.`);
        const request = normalizeRunRequest(body);
        const runId = await startRun(request.config, request.mode, request.saveConfig);
        json(res, { ok: true, mode: request.mode, runId, configSaved: request.saveConfig });
        return;
      }

      if (url.pathname === '/api/decision') {
        const id = requireShortString(body.id, 'id', { max: 128 });
        const pending = pendingDecisions.get(id);
        if (!pending) throw new ApiError(409, 'no_pending_decision', 'That decision is no longer pending. Refresh state and wait for the next gate.');
        const value = validateDecision(pending, body.value);
        pendingDecisions.delete(id);
        pending.resolve(value);
        json(res, { ok: true });
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      json(res, { ok: false, error: 'API route not found.', code: 'not_found' }, 404);
      return;
    }
    res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    res.end('not found');
  }

  async function startRun(config, mode, persistDefaults = false) {
    if (activeRun) throw new ApiError(409, 'run_in_progress', `Run ${activeRun.runId || 'starting'} is already in progress.`);
    const record = { app: null, runId: null, mode };
    activeRun = record; // reserve before readiness probes so concurrent requests conflict
    try {
      if (mode === 'real') await preflightRunConfig(config);
      if (persistDefaults) {
        try {
          saveConfig(defaultsFromRunConfig(config));
        } catch {
          throw new ApiError(500, 'config_save_failed', 'Validated defaults could not be saved; no run was started. Check the moh config directory permissions.');
        }
      }
    } catch (e) {
      if (activeRun === record) activeRun = null;
      throw e;
    }
    const decider = {
      chooseLeader: (candidates) =>
        new Promise((resolve) => {
          const id = 'leader-' + randomBytes(4).toString('hex');
          const event = { kind: 'gate.leader', runId: record.runId, payload: { id, candidates: candidates.map(({ seatId, label, finalText }) => ({ seatId, label, output: finalText })) } };
          pendingDecisions.set(id, { kind: 'leader', resolve, seatIds: candidates.map((candidate) => candidate.seatId), event });
          broadcast(event);
        }),
      confirmResult: (ctx) =>
        new Promise((resolve) => {
          const id = 'result-' + randomBytes(4).toString('hex');
          const event = { kind: 'gate.result', runId: record.runId, payload: { id, verdict: ctx.verdict, approved: ctx.approved, ...resultEvidenceForWeb(ctx) } };
          pendingDecisions.set(id, { kind: 'result', resolve, approved: !!ctx.approved, event });
          broadcast(event);
        }),
    };
    const app = new Application({ store, decider });
    record.app = app;
    app.subscribe(broadcast);
    try {
      const { runId } = await app.createRun(config);
      record.runId = runId;
      lastRunId = runId;
      broadcast({ kind: 'run.id', runId, payload: { runId, mode } });
      void (async () => {
        try {
          const outcome = await app.run(runId);
          broadcast({ kind: 'run.done', runId, payload: outcome });
        } catch (e) {
          broadcast({ kind: 'run.error', runId, payload: { message: e.message } });
        } finally {
          if (activeRun === record) activeRun = null;
          pendingDecisions.clear();
        }
      })();
      return runId;
    } catch (e) {
      if (activeRun === record) activeRun = null;
      pendingDecisions.clear();
      throw new ApiError(400, 'run_create_failed', redact(e.message || 'Run creation failed.'));
    }
  }

  await listenWithFallback(server, port, host, (p) => (port = p));
  out(c.green(`moh web on http://127.0.0.1:${port}`));
  out(
    host === '0.0.0.0'
      ? c.red('EXPOSED on all interfaces · capability cookie required · mutations remain origin-restricted · Ctrl-C to stop')
      : c.dim('Loopback only · per-launch capability cookie · no push · Ctrl-C to stop'),
  );
  process.on('SIGINT', () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    if (activeRun?.app) activeRun.app.cancel();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
  return new Promise(() => {}); // keep alive
}

function normalizeInterruptedRuns(store) {
  for (const runId of store.list()) {
    let state;
    try {
      state = store.loadState(runId);
    } catch {
      continue;
    }
    if (!isNativeMohState(state, runId) || state.status !== 'running') continue;
    const recoveryClaim = claimInterruptedRunRecovery(store, runId);
    if (!recoveryClaim) continue;
    try {
      // Re-read after taking the per-run recovery claim. A concurrent process may
      // have completed normalization before this process won the claim.
      state = store.loadState(runId);
      if (!isNativeMohState(state, runId) || state.status !== 'running' || hasLiveRunLock(store, runId)) continue;
      const message = 'Run was interrupted when the web companion stopped. It was not automatically restarted; use `moh resume <run-id> --retry` for a deliberate new attempt.';
      const recovery = new Application({ store });
      recovery._seedSeq(runId, state);
      state.status = 'failed';
      state.stage = 'failed';
      state.error = message;
      state.limitations = [...(Array.isArray(state.limitations) ? state.limitations : []), message];
      store.saveState(runId, state);
      recovery._emit(runId, { kind: 'notice', stage: 'failed', payload: { level: 'error', code: 'interrupted_by_restart', message } });
      recovery._emit(runId, { kind: 'run.finished', stage: 'failed', payload: { status: 'failed', error: message } });
      store.release(runId);
    } finally {
      try {
        renameSync(recoveryClaim, join(store.runPath(runId), '.lock.released'));
      } catch {
        try {
          unlinkSync(recoveryClaim);
        } catch {}
      }
    }
  }
}

function claimInterruptedRunRecovery(store, runId) {
  const runDir = store.runPath(runId);
  const lock = join(runDir, '.lock');
  for (let attempt = 0; attempt < 16; attempt++) {
    const claims = recoveryClaimFiles(runDir);
    const liveClaim = claims.find((claim) => processIsLive(recoveryClaimPid(claim)));
    if (liveClaim) return null;

    // Claim filenames are unique and never reused. Renaming the exact stale name
    // to our unique live-owner name is therefore an atomic, ABA-safe takeover.
    if (claims.length) {
      const next = recoveryClaimName(runDir);
      try {
        renameSync(claims[0], next);
        return next;
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }

    if (pidFileHasLiveOwner(lock)) return null;
    const next = recoveryClaimName(runDir);
    if (existsSync(lock)) {
      try {
        renameSync(lock, next);
        return next;
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }

    // A native state can be running without a lock after a crash. Publish a
    // fully-written PID file at `.lock` using hard-link create-if-absent, then
    // re-check for a claim that another contender may have published first.
    const owner = join(runDir, `.web-recovery-owner-${process.pid}-${randomBytes(4).toString('hex')}`);
    writeFileSync(owner, String(process.pid), { flag: 'wx', mode: 0o600 });
    let linked = false;
    try {
      linkSync(owner, lock);
      linked = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      try {
        unlinkSync(owner);
      } catch {}
    }
    if (!linked) continue;
    if (recoveryClaimFiles(runDir).length) {
      try {
        if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock);
      } catch {}
      return null;
    }
    try {
      renameSync(lock, next);
      return next;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return null;
}

function recoveryClaimName(runDir) {
  return join(runDir, `.web-recovery-${process.pid}-${randomBytes(8).toString('hex')}.lock`);
}

function recoveryClaimFiles(runDir) {
  try {
    return readdirSync(runDir)
      .filter((name) => /^\.web-recovery-\d{1,10}-[a-f0-9]{16}\.lock$/.test(name))
      .sort()
      .map((name) => join(runDir, name));
  } catch {
    return [];
  }
}

function recoveryClaimPid(file) {
  const match = /^\.web-recovery-(\d{1,10})-[a-f0-9]{16}\.lock$/.exec(basename(file));
  return match ? Number(match[1]) : null;
}

export function hasLiveRunLock(store, runId, probe = process.kill) {
  const lock = join(store.runPath(runId), '.lock');
  return pidFileHasLiveOwner(lock, probe);
}

function pidFileHasLiveOwner(file, probe = process.kill) {
  if (!existsSync(file)) return false;
  let raw;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    return false;
  }
  if (!/^\d{1,10}$/.test(raw)) return false;
  return processIsLive(Number(raw), probe);
}

function processIsLive(pid, probe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    // POSIX uses EPERM when the process exists but cannot be signalled.
    return error?.code === 'EPERM';
  }
}

function isNativeMohState(state, runId) {
  return (
    isPlainObject(state) &&
    state.v === 1 &&
    state.runId === runId &&
    typeof state.status === 'string' &&
    Object.values(Preset).includes(state.preset) &&
    isPlainObject(state.seed) &&
    Array.isArray(state.seats) &&
    Array.isArray(state.limitations)
  );
}

function nativeMohRunIds(store) {
  const ids = new Set();
  for (const runId of store.list()) {
    try {
      if (isNativeMohState(store.loadState(runId), runId)) ids.add(runId);
    } catch {
      // Corrupt local state is not exposed as a trustworthy browser record.
    }
  }
  return ids;
}

function discoverLegacyRuns(store) {
  const storeRunIds = new Set(store.list());
  const legacyRuns = new Map();
  for (const dir of legacyCouncilDirs()) {
    for (const entry of scanLegacyCouncil(dir)) {
      const record = legacyWebRecord(entry?.legacy) || quarantinedLegacyWebRecord(entry);
      if (!record || legacyRuns.has(record.runId)) continue;
      if (storeRunIds.has(record.runId)) {
        let state = null;
        try {
          state = store.loadState(record.runId);
        } catch {}
        if (isNativeMohState(state, record.runId)) continue;
        // If the candidate comes from a distinct legacy directory, even a corrupt
        // local MoH directory retains collision precedence. Only reinterpret the
        // store entry as legacy when the scanner found that exact same run dir.
        const sameRunDir = typeof entry?.path === 'string' && resolve(dirname(entry.path)) === resolve(store.runPath(record.runId));
        if (!sameRunDir) continue;
      }
      legacyRuns.set(record.runId, record);
    }
  }
  return legacyRuns;
}

function legacyWebRecord(legacy) {
  if (!isPlainObject(legacy)) return null;
  const rawRunId = legacy.runId ?? legacy.id ?? legacy.run_id;
  if (!isSafeRunId(rawRunId)) return null;
  const hasSessions = isPlainObject(legacy.sessions) && Object.keys(legacy.sessions).length > 0;
  // The earliest Council snapshots predate session persistence, but Council's
  // schema still had its fixed Claude/Codex actors. Represent those seats as
  // generic, wholly unattested participants rather than dropping the run.
  const migrationInput = hasSessions
    ? legacy
    : { ...legacy, actors: ['claude', 'codex'], sessions: { claude: {}, codex: {} } };
  let migrated;
  try {
    const result = migrateCouncilRun(migrationInput);
    if (!result.ok) return null;
    migrated = result.migrated;
  } catch {
    return null;
  }
  const migratedSeats = Array.isArray(migrated.seats) ? migrated.seats.slice(0, 2) : [];
  if (!migratedSeats.length) return null;
  const seats = migratedSeats.map((seat, index) => {
    const seatId = index === 0 ? 'seat-a' : 'seat-b';
    const adapterId = ['claude-code', 'codex-cli'].includes(seat.adapterId) ? seat.adapterId : 'unknown';
    const label = adapterId === 'claude-code' ? 'Legacy Claude Code seat' : adapterId === 'codex-cli' ? 'Legacy Codex CLI seat' : `Legacy Council seat ${index + 1}`;
    const requestedModel = safeLegacyRequestedModel(seat.provenance?.requestedModel);
    return {
      seatId,
      label,
      adapterId,
      provider: 'unknown',
      requestedModel,
      requestedModelSource: requestedModel ? 'legacy_unattested' : 'unknown',
      configuredModel: null,
      modelPolicy: null,
      authMode: null,
      sandbox: 'unknown',
    };
  });
  const provenanceBySeat = Object.fromEntries(
    seats.map((seat) => [
      seat.seatId,
      {
        v: 1,
        seatId: seat.seatId,
        seatLabel: seat.label,
        adapterId: seat.adapterId,
        harnessId: seat.adapterId === 'unknown' ? 'legacy-council' : seat.adapterId,
        provider: 'unknown',
        requestedModel: seat.requestedModel,
        requestedModelSource: seat.requestedModelSource,
        configuredModel: null,
        reportedModel: null,
        evidenceSource: null,
        state: 'unknown',
        modelClaim: 'unattested',
        authLabel: 'Legacy authorization was not recorded',
        authMode: null,
        sandbox: 'unknown',
        approval: 'unknown',
        network: 'unknown',
        continuity: 'legacy_unattested',
        history: [],
        modelObservations: [],
      },
    ]),
  );
  const createdAt = safeLegacyDate(migrated.createdAt);
  const { status, stage } = legacyTerminalState(legacy);
  const leaderSeatId = seats.some((seat) => seat.seatId === migrated.leaderSeatId) ? migrated.leaderSeatId : null;
  const state = {
    v: 1,
    runId: rawRunId,
    legacy: true,
    source: 'council',
    readOnly: true,
    migratedFrom: 'council',
    status,
    stage,
    preset: null,
    createdAt,
    leaderSeatId,
    seats,
    provenanceBySeat,
    reviewIntegrity: 'unattested',
    verdict: safeLegacyVerdict(migrated.verdict),
    limitations: ['Legacy Council history is read-only. Runtime model identity and review-event integrity were not attested by that schema.'],
    seq: 0,
  };
  return {
    runId: rawRunId,
    state,
    summary: {
      runId: rawRunId,
      status,
      stage,
      preset: null,
      createdAt,
      leaderSeatId,
      active: false,
      legacy: true,
      source: 'council',
      readOnly: true,
      reviewIntegrity: 'unattested',
    },
  };
}

function safeLegacyRequestedModel(value) {
  const model = storedIdentifier(value, 200);
  // Legacy model fields are unattested. Accept only a conservative slug shape;
  // separators used by filesystem paths are intentionally excluded.
  return model && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(model) ? model : null;
}

function quarantinedLegacyWebRecord(entry) {
  let runId = null;
  if (isPlainObject(entry?.legacy)) runId = entry.legacy.runId ?? entry.legacy.id ?? entry.legacy.run_id ?? null;
  if (!isSafeRunId(runId) && typeof entry?.path === 'string') {
    const filename = basename(entry.path);
    if (['run.json', 'state.json', 'council.json'].includes(filename)) runId = basename(dirname(entry.path));
  }
  if (!isSafeRunId(runId)) return null;
  const record = legacyWebRecord({ id: runId, actors: ['claude', 'codex'], sessions: { claude: {}, codex: {} } });
  if (!record) return null;
  record.state.status = 'quarantined';
  record.state.stage = 'legacy';
  record.state.quarantined = true;
  record.state.verdict = 'unknown';
  record.state.limitations = ['Legacy Council history is read-only. This state record could not be parsed or uses an unrecognized schema, so no raw state or events are exposed.'];
  record.summary.status = 'quarantined';
  record.summary.stage = 'legacy';
  record.summary.quarantined = true;
  return record;
}

function safeLegacyDate(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  try {
    return new Date(parsed).toISOString();
  } catch {
    return null;
  }
}

function legacyTerminalState(legacy) {
  const stage = typeof legacy.stage === 'string' ? legacy.stage.trim().toLowerCase() : '';
  if (legacy.error || /^(?:failed|cancelled|canceled)$/.test(stage)) return { status: 'failed', stage: 'failed' };
  if (/^(?:published|finished|complete|completed|done)$/.test(stage)) return { status: 'finished', stage: 'finished' };
  return { status: 'legacy', stage: 'legacy' };
}

function safeLegacyVerdict(value) {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['approve', 'request_changes', 'unknown'].includes(normalized) ? normalized : 'unknown';
}

function runSummaries(store, activeRunId = null, legacyRuns = new Map()) {
  const rows = [];
  const localRunIds = nativeMohRunIds(store);
  for (const runId of localRunIds) {
    try {
      const state = store.loadState(runId);
      if (!state) continue;
      rows.push({
        runId,
        status: state.status || 'unknown',
        stage: state.stage || 'unknown',
        preset: state.preset || null,
        createdAt: state.createdAt || null,
        leaderSeatId: state.leaderSeatId || null,
        active: runId === activeRunId,
        legacy: false,
        source: 'moh',
        readOnly: false,
      });
    } catch {
      // Corrupt entries remain on disk for CLI inspection but are not rendered as
      // trustworthy browser history rows.
    }
  }
  for (const [runId, record] of legacyRuns) {
    // Re-evaluate collisions because a local run may have been created after the
    // legacy index was built at server startup.
    if (!localRunIds.has(runId)) rows.push(record.summary);
  }
  return rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const time = (value) => {
      const parsed = Date.parse(value || '');
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return time(b.createdAt) - time(a.createdAt) || b.runId.localeCompare(a.runId);
  });
}

function newestRunId(store, legacyRuns = new Map()) {
  return runSummaries(store, null, legacyRuns)[0]?.runId || null;
}

function normalizeRunRequest(body) {
  const forbidden = findForbiddenField(body);
  if (forbidden) {
    throw new ApiError(400, 'credential_input_forbidden', `Credential/account field '${forbidden}' is not accepted. Configure the harness or environment outside moh.`);
  }

  const keys = Object.keys(body);
  const mode = body.mode || (keys.length === 0 ? 'demo' : 'real');
  if (mode === 'demo') {
    const extras = keys.filter((key) => key !== 'mode');
    if (extras.length) throw new ApiError(400, 'invalid_demo_request', 'Demo mode accepts only {"mode":"demo"}.');
    return { mode: 'demo', config: demoConfig(), saveConfig: false };
  }
  if (mode !== 'real') throw new ApiError(400, 'invalid_mode', "mode must be 'demo' or 'real'.");

  const wrapped = body.config !== undefined;
  rejectUnknownKeys(
    body,
    wrapped ? new Set(['mode', 'config', 'saveConfig']) : new Set(['mode', 'task', 'seed', 'preset', 'seats', 'saveConfig', 'timeoutMs']),
    'run request',
  );
  if (wrapped && !isPlainObject(body.config)) throw new ApiError(400, 'invalid_config', 'config must be an object.');
  const input = wrapped ? body.config : body;
  if (wrapped) rejectUnknownKeys(input, new Set(['task', 'seed', 'preset', 'seats', 'timeoutMs']), 'config');
  const task = requireTask(input.task);
  const seed = validateSeed(input.seed);
  const preset = validatePreset(input.preset);
  if (!Array.isArray(input.seats) || input.seats.length !== 2) {
    throw new ApiError(400, 'invalid_seats', 'Real runs require exactly two seats.');
  }
  const seats = input.seats.map((seat, index) => validateSeat(seat, index));
  if (seats[0].seatId === seats[1].seatId) throw new ApiError(400, 'duplicate_seat_id', 'Seat IDs must be unique.');

  let timeoutMs;
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 21_600_000) {
      throw new ApiError(400, 'invalid_timeout', 'timeoutMs must be an integer from 1000 to 21600000.');
    }
    timeoutMs = input.timeoutMs;
  }
  if (body.saveConfig !== undefined && typeof body.saveConfig !== 'boolean') {
    throw new ApiError(400, 'invalid_save_config', 'saveConfig must be a boolean.');
  }
  return { mode: 'real', saveConfig: body.saveConfig === true, config: { task, seed, preset, seats, ...(timeoutMs ? { timeoutMs } : {}) } };
}

function validateSeat(value, index) {
  if (!isPlainObject(value)) throw new ApiError(400, 'invalid_seat', `seats[${index}] must be an object.`);
  rejectUnknownKeys(
    value,
    new Set([
      'seatId',
      'label',
      'adapterId',
      'requestedModel',
      'model',
      'configuredModel',
      'requestedModelSource',
      'requestedEffort',
      'effort',
      'provider',
      'profile',
      'modelPolicy',
      'modelCatalog',
      'catalogEvidence',
      'modelCatalogSource',
      'modelCatalogCheckedAt',
      'modelClaim',
      'authMode',
      'authLabel',
      'permissionMode',
      'sandbox',
    ]),
    `seats[${index}]`,
  );
  const seatId = value.seatId === undefined ? (index === 0 ? 'seat-a' : 'seat-b') : requireShortString(value.seatId, `seats[${index}].seatId`, { max: 64 });
  if (!isSafeSegment(seatId)) throw new ApiError(400, 'invalid_seat_id', `seats[${index}].seatId must be a safe path segment.`);
  const adapterId = requireShortString(value.adapterId, `seats[${index}].adapterId`, { max: 100 });
  const adapter = getAdapter(adapterId);
  if (!adapter) throw new ApiError(400, 'unknown_adapter', `Unknown adapter '${adapterId}'. Refresh bootstrap and choose a listed adapter.`);
  const label = value.label === undefined ? (index === 0 ? 'Seat A' : 'Seat B') : requireShortString(value.label, `seats[${index}].label`, { max: 100 });
  rejectServerObservedModelFields(value, index);
  const requestedModel = optionalIdentifier(value.requestedModel ?? value.model, `seats[${index}].requestedModel`, 200);
  const requestedEffort = optionalIdentifier(value.requestedEffort ?? value.effort, `seats[${index}].requestedEffort`, 64);
  // Provider is an adapter identity fact, not a client assertion. Unknown/third-party
  // adapters remain explicitly unknown rather than trusting a submitted label.
  const provider = providerFor(adapterId);
  const profile = optionalIdentifier(value.profile, `seats[${index}].profile`, 128);
  const modelPolicy = normalizeModelPolicy(value.modelPolicy, requestedModel);
  const requestedModelSource = modelPolicy === 'catalog_frontier' ? 'provider_catalog' : modelPolicy === 'pinned' ? 'user' : 'default';
  if (['catalog_frontier', 'pinned'].includes(modelPolicy) && !requestedModel) {
    throw new ApiError(400, 'model_required', `seats[${index}].requestedModel is required for modelPolicy '${modelPolicy}'.`);
  }
  if (modelPolicy === 'harness_default' && requestedModel) {
    throw new ApiError(400, 'model_not_allowed', `seats[${index}].requestedModel must be omitted for modelPolicy 'harness_default'.`);
  }
  const { authMode, authEnvNames } = resolveAuthMode(adapterId, value.authMode, `seats[${index}].authMode`);
  const permissionMode = validatePermissionMode(adapter, value.permissionMode, index);
  const sandbox = validateSandbox(adapter, value.sandbox, index);
  const seat = {
    seatId,
    label,
    adapterId,
    requestedModel,
    configuredModel: null,
    requestedModelSource,
    requestedEffort,
    provider,
    profile,
    modelPolicy,
    modelCatalog: null,
    catalogEvidence: null,
    modelCatalogSource: null,
    modelCatalogCheckedAt: null,
    modelClaim: null,
    authMode,
    authEnvNames,
    authLabel: authMode === 'none' ? 'no auth required' : authMode === 'delegated' ? `${adapter.displayName} login (delegated)` : `${authEnvNames.join(' or ')} reference`,
    permissionMode,
    sandbox,
  };
  if (adapterId === 'fake') {
    seat.adapterConfig = { reportedModel: requestedModel, sessionPrefix: seatId };
  }
  return seat;
}

function validateSeed(seed) {
  if (!isPlainObject(seed)) throw new ApiError(400, 'invalid_seed', 'seed must be an object.');
  const kind = seed.kind;
  if (kind === 'greenfield') {
    rejectUnknownKeys(seed, new Set(['kind']), 'seed');
    return { kind };
  }
  if (kind === 'local') {
    rejectUnknownKeys(seed, new Set(['kind', 'path']), 'seed');
    const path = requireShortString(seed.path, 'seed.path', { max: 4096 });
    if (!isAbsolute(path)) throw new ApiError(400, 'invalid_seed_path', 'seed.path must be absolute.');
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new ApiError(400, 'invalid_seed_path', 'seed.path must name an existing directory.');
    return { kind, path };
  }
  if (kind === 'url') {
    rejectUnknownKeys(seed, new Set(['kind', 'url']), 'seed');
    const url = requireShortString(seed.url, 'seed.url', { max: 4096 });
    try {
      return { kind, url: sanitizeGitUrl(url, { reject: true }) };
    } catch (e) {
      throw new ApiError(400, 'invalid_seed_url', redact(e.message));
    }
  }
  throw new ApiError(400, 'invalid_seed', "seed.kind must be 'greenfield', 'local', or 'url'.");
}

function validatePreset(value) {
  if (!Object.values(Preset).includes(value)) {
    throw new ApiError(400, 'invalid_preset', `preset must be one of: ${Object.values(Preset).join(', ')}.`);
  }
  return value;
}

function requireTask(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'invalid_task', 'task must be a non-empty string.');
  if (value.length > MAX_TASK_CHARS) throw new ApiError(400, 'invalid_task', `task must be at most ${MAX_TASK_CHARS} characters.`);
  if (value.includes('\0') || redact(value) !== value) {
    throw new ApiError(400, 'credential_in_task', 'task appears to contain a credential. Remove it and reference credentials through the harness environment instead.');
  }
  return stripControl(value).trim();
}

function validatePermissionMode(adapter, value, index) {
  if (value == null || value === '') return adapter.id === 'claude-code' ? 'acceptEdits' : null;
  const mode = requireShortString(value, `seats[${index}].permissionMode`, { max: 40 });
  if (adapter.id !== 'claude-code') {
    throw new ApiError(400, 'permission_mode_unsupported', `seats[${index}].permissionMode is supported only by the Claude Code adapter. Omit it for ${adapter.displayName}.`);
  }
  if (adapterCapabilityState(adapter, 'approval_controls') !== 'supported') {
    throw new ApiError(400, 'permission_mode_unsupported', `${adapter.displayName} did not report approval_controls as supported. Omit permissionMode or refresh adapter status.`);
  }
  if (mode === 'bypassPermissions') {
    throw new ApiError(400, 'unsafe_permission_mode', 'bypassPermissions requires an explicit typed confirmation in terminal setup and cannot be enabled through the web API.');
  }
  const allowed = new Set(['acceptEdits', 'auto', 'default', 'dontAsk', 'plan']);
  if (!allowed.has(mode)) throw new ApiError(400, 'invalid_permission_mode', `Unsupported Claude permission mode '${mode}'.`);
  return mode;
}

function validateSandbox(adapter, value, index) {
  if (value == null || value === '') return 'unknown';
  const sandbox = requireShortString(value, `seats[${index}].sandbox`, { max: 64 });
  const allowed = new Set(['unknown', 'read-only', 'workspace-write', 'danger-full-access']);
  if (!allowed.has(sandbox)) throw new ApiError(400, 'invalid_sandbox', `Unsupported sandbox mode '${sandbox}'.`);
  if (sandbox !== 'unknown' && adapterCapabilityState(adapter, 'sandbox_controls') !== 'supported') {
    throw new ApiError(
      400,
      'sandbox_control_unsupported',
      `${adapter.displayName} did not report sandbox_controls as supported. Use sandbox 'unknown' or choose an adapter with verified sandbox controls.`,
    );
  }
  return sandbox;
}

function adapterCapabilityState(adapter, key) {
  try {
    const capabilities = adapter.capabilities();
    return isPlainObject(capabilities) && CAPABILITY_STATES.has(capabilities[key]) ? capabilities[key] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function rejectServerObservedModelFields(value, index) {
  for (const field of SERVER_OBSERVED_MODEL_FIELDS) {
    if (value[field] !== undefined && value[field] !== null) {
      throw new ApiError(
        400,
        'server_observed_field',
        `seats[${index}].${field} is server-observed provenance and cannot be submitted. Omit it; moh records verified catalog or runtime evidence itself.`,
      );
    }
  }
}

function normalizeModelPolicy(value, requestedModel) {
  if (value == null || value === '') return requestedModel ? 'pinned' : 'harness_default';
  if (typeof value !== 'string' || stripControl(value) !== value || redact(value) !== value) {
    throw new ApiError(400, 'invalid_model_policy', "modelPolicy must be one of: harness_default, catalog_frontier, pinned.");
  }
  const policy = MODEL_POLICY_ALIASES.get(value.trim().toLowerCase());
  if (!policy) throw new ApiError(400, 'invalid_model_policy', "modelPolicy must be one of: harness_default, catalog_frontier, pinned.");
  return policy;
}

function resolveAuthMode(adapterId, requested, field = 'authMode') {
  const guidance = guidanceFor(adapterId);
  const aliases = {
    native: 'delegated',
    'native-login': 'delegated',
    environment: 'api_key_env',
    env: 'api_key_env',
    'api-key-env': 'api_key_env',
    'oauth-token-env': 'oauth_token_env',
  };
  const normalized = aliases[requested] || requested || guidance.defaultMode;
  const mode = guidance.modes.find((candidate) => candidate.id === normalized);
  if (!mode) {
    throw new ApiError(400, 'invalid_auth_mode', `${field} must be one of: ${guidance.modes.map((candidate) => candidate.id).join(', ')}.`);
  }
  return { authMode: mode.id, authEnvNames: [...mode.envNames] };
}

function guidanceFor(adapterId) {
  return (
    AUTH_GUIDANCE[adapterId] || {
      defaultMode: 'delegated',
      instructions: 'Configure and authorize this adapter outside the web companion. Credential values are never accepted here.',
      modes: [{ id: 'delegated', label: 'Adapter-managed authentication', envNames: [] }],
    }
  );
}

function providerFor(adapterId) {
  if (adapterId === 'fake') return 'local';
  // A harness name is not inference-route evidence. Profiles and harness config
  // may route Claude Code or Codex elsewhere, so their provider stays unknown
  // until an adapter reports a verified runtime provider observation.
  return 'unknown';
}

export function authModeAvailable(adapterId, readiness, envNames, environment = process.env) {
  if (adapterId === 'fake') return true;
  const operationallyReachable = readiness === 'ready' || readiness === 'needs_login';
  if (!operationallyReachable) return false;
  const names = Array.isArray(envNames) ? envNames : [];
  if (names.length) return names.some((name) => environment[name] !== undefined && environment[name] !== '');
  return readiness === 'ready';
}

async function preflightRunConfig(config) {
  for (const seat of config.seats) {
    const adapter = getAdapter(seat.adapterId);
    if (!adapter) throw new ApiError(400, 'unknown_adapter', `Unknown adapter '${seat.adapterId}'.`);
    let readiness;
    try {
      readiness = await adapter.probeReadiness({
        authMode: seat.authMode,
        authEnvNames: seat.authEnvNames,
        profile: seat.profile,
      });
    } catch {
      throw new ApiError(412, 'adapter_probe_failed', `${adapter.displayName} readiness could not be verified. Run moh doctor and try again.`);
    }
    if (readiness?.readiness !== 'ready') {
      const envHint = seat.authEnvNames?.length
        ? `Set ${seat.authEnvNames.join(' or ')} before launching moh, or choose another authentication mode.`
        : `Complete ${adapter.displayName}'s native login outside moh, then refresh status.`;
      throw new ApiError(412, 'adapter_not_ready', `${adapter.displayName} is ${readiness?.readiness || 'not ready'}. ${envHint}`);
    }
    if (seat.modelPolicy === 'catalog_frontier') await verifyFrontierSelection(adapter, seat);
    else if (seat.requestedEffort && adapter.id === 'codex-cli') await verifyCodexReasoningSelection(adapter, seat);
  }
}

async function verifyFrontierSelection(adapter, seat) {
  if (seat.profile) {
    throw new ApiError(412, 'profile_catalog_unsupported', `${adapter.displayName} does not support profile-scoped model catalog discovery in this installed CLI. Use a pinned model or harness default and verify the runtime model instead.`);
  }
  const catalog = await refreshedCatalog(adapter);
  const model = catalog.models.find((candidate) => candidate.slug === seat.requestedModel);
  if (!model || model.frontier !== true) {
    throw new ApiError(412, 'model_claim_unverified', `Model '${seat.requestedModel}' is not marked latest frontier by the refreshed ${adapter.displayName} catalog. Refresh status or choose a pinned model.`);
  }
  // Replace every client-supplied claim with the exact server-observed catalog row.
  seat.modelCatalog = { models: [model], source: catalog.source, checkedAt: catalog.checkedAt || null };
  seat.catalogEvidence = seat.modelCatalog;
  seat.modelCatalogSource = catalog.source;
  seat.modelCatalogCheckedAt = catalog.checkedAt || null;
  seat.modelClaim = model.description || null;
  seat.requestedModelSource = 'provider_catalog';
  assertRequestedEffortSupported(seat, model, adapter);
}

async function verifyCodexReasoningSelection(adapter, seat) {
  if (seat.profile) {
    throw new ApiError(412, 'profile_effort_unverified', 'This Codex CLI cannot verify reasoning support inside a profile. Leave reasoning at harness default and verify the runtime report.');
  }
  if (!seat.requestedModel) {
    throw new ApiError(412, 'effort_model_required', 'A custom Codex reasoning effort requires an exact pinned or catalog-verified model.');
  }
  const catalog = await refreshedCatalog(adapter);
  const model = catalog.models.find((candidate) => candidate.slug === seat.requestedModel);
  if (!model) {
    throw new ApiError(412, 'effort_model_unverified', `Reasoning support for '${seat.requestedModel}' could not be verified in the refreshed Codex catalog. Leave reasoning at harness default.`);
  }
  assertRequestedEffortSupported(seat, model, adapter);
  seat.modelCatalog = { models: [model], source: catalog.source, checkedAt: catalog.checkedAt || null };
  seat.catalogEvidence = seat.modelCatalog;
  seat.modelCatalogSource = catalog.source;
  seat.modelCatalogCheckedAt = catalog.checkedAt || null;
}

async function refreshedCatalog(adapter) {
  if (typeof adapter.discoverModels !== 'function') {
    throw new ApiError(412, 'model_catalog_unavailable', `${adapter.displayName} does not expose a verifiable current model catalog. Choose a pinned model or the harness default.`);
  }
  let catalog;
  try {
    catalog = sanitizeModelCatalog(await adapter.discoverModels({ refresh: true }), { strict: false });
  } catch {
    catalog = null;
  }
  if (!catalog || !/refreshed/i.test(catalog.source || '')) {
    throw new ApiError(412, 'model_catalog_unavailable', `${adapter.displayName}'s current/account-aware model catalog could not be refreshed. No model or reasoning claim was accepted.`);
  }
  return catalog;
}

function assertRequestedEffortSupported(seat, model, adapter) {
  if (!seat.requestedEffort) return;
  const supported = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  if (!supported.includes(seat.requestedEffort)) {
    throw new ApiError(412, 'reasoning_effort_unsupported', `${adapter.displayName} model '${model.slug}' does not report support for reasoning effort '${seat.requestedEffort}'. Choose one of: ${supported.length ? supported.join(', ') : 'harness default'}.`);
  }
}

async function safeAdapterStatuses(report) {
  const reportById = new Map((Array.isArray(report?.adapters) ? report.adapters : []).map((entry) => [entry.id, entry]));
  return Promise.all(
    listAdapters().map(async (adapter) => {
      const entry = reportById.get(adapter.id) || {};
      let capabilities = safeCapabilities(entry.capabilities);
      if (!capabilities) {
        try {
          capabilities = safeCapabilities(await adapter.capabilities());
        } catch {
          capabilities = null;
        }
      }
      let modelCatalog = sanitizeModelCatalog(entry.modelCatalog, { strict: false });
      if (adapter.id === 'codex-cli' && typeof adapter.discoverModels === 'function') {
        try {
          // The web status refresh asks Codex for the current/account-aware catalog.
          // Its source string explicitly distinguishes this from the offline bundled catalog.
          const refreshed = sanitizeModelCatalog(await adapter.discoverModels({ refresh: true }), { strict: false });
          // An empty/failed refresh is not stronger evidence than doctor's bundled
          // fallback. Retain the explicitly-labelled bundled catalog in that case.
          if (refreshed?.models?.length) modelCatalog = refreshed;
        } catch {
          // Fall back to doctor's explicitly-labelled bundled catalog, if any.
        }
      } else if (!modelCatalog && typeof adapter.discoverModels === 'function' && !['missing', 'blocked', 'unavailable'].includes(entry.readiness)) {
        try {
          modelCatalog = sanitizeModelCatalog(await adapter.discoverModels(), { strict: false });
        } catch {}
      }
      const guidance = guidanceFor(adapter.id);
      const modes = guidance.modes.map((mode) => {
        const available = authModeAvailable(adapter.id, entry.readiness, mode.envNames);
        const operationallyReachable = entry.readiness === 'ready' || entry.readiness === 'needs_login';
        return {
          id: mode.id,
          label: mode.label,
          envNames: [...mode.envNames],
          available,
          readiness:
            adapter.id === 'fake'
              ? 'not_required'
              : available
                ? 'ready'
                : mode.envNames.length && operationallyReachable
                  ? 'needs_login'
                  : entry.readiness || 'probe_failed',
        };
      });
      const auth = {
        status: authStatus(adapter.id, entry.readiness),
        defaultMode: guidance.defaultMode,
        instructions: guidance.instructions,
        modes,
        ...authCommands(adapter.id),
      };
      return {
        id: adapter.id,
        displayName: safeDiagnosticString(entry.displayName || adapter.displayName),
        provider: providerFor(adapter.id),
        trustLevel: safeDiagnosticString(entry.trustLevel || adapter.trustLevel),
        readiness: safeDiagnosticString(entry.readiness || 'probe_failed'),
        version: safeDiagnosticString(entry.version),
        path: safeDiagnosticString(entry.path),
        authLabel: safeAuthLabel(adapter.id, entry.readiness, entry.authLabel),
        detail: safeDiagnosticString(entry.detail),
        capabilities,
        modelCatalog,
        auth,
        authenticationStatus: auth.status,
        authInstructions: {
          defaultMode: guidance.defaultMode,
          instructions: guidance.instructions,
          modes,
        },
      };
    }),
  );
}

function authCommands(adapterId) {
  if (adapterId === 'claude-code') return { loginCommand: 'claude auth login', statusCommand: 'claude auth status --json' };
  if (adapterId === 'codex-cli') return { loginCommand: 'codex login', statusCommand: 'codex login status' };
  return {};
}

function safeAuthLabel(adapterId, readiness, label) {
  if (adapterId === 'fake') return 'No authentication required';
  const clean = safeDiagnosticString(label);
  if (clean && /^(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN) (?:present|missing)$/.test(clean)) return clean;
  if (readiness === 'ready') return `${adapterId === 'claude-code' ? 'Claude Code' : adapterId === 'codex-cli' ? 'Codex CLI' : 'Harness'} login ready`;
  if (readiness === 'needs_login') return 'Login or selected environment reference required';
  return 'Authentication unavailable or unverified';
}

function authStatus(adapterId, readiness) {
  if (adapterId === 'fake') return 'not_required';
  if (readiness === 'ready') return 'ready';
  if (readiness === 'needs_login') return 'needs_login';
  return 'unavailable_or_unverified';
}

function safeCapabilities(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [key, state] of Object.entries(value)) {
    if (/^[a-z][a-z0-9_]{0,80}$/.test(key) && CAPABILITY_STATES.has(state)) out[key] = state;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeModelCatalog(value, { strict = false, field = 'modelCatalog' } = {}) {
  if (value == null) return null;
  const sourceObject = Array.isArray(value) ? { models: value } : value;
  if (!isPlainObject(sourceObject) || !Array.isArray(sourceObject.models)) {
    if (strict) throw new ApiError(400, 'invalid_model_catalog', `${field} must contain a models array.`);
    return null;
  }
  const models = [];
  for (let index = 0; index < sourceObject.models.length && index < 500; index++) {
    const model = sourceObject.models[index];
    if (!isPlainObject(model)) {
      if (strict) throw new ApiError(400, 'invalid_model_catalog', `${field}.models[${index}] must be an object.`);
      continue;
    }
    const slug = catalogString(model.slug ?? model.id ?? model.model, 200);
    if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(slug)) {
      if (strict) throw new ApiError(400, 'invalid_model_catalog', `${field}.models[${index}].slug is required.`);
      continue;
    }
    const item = { slug };
    const displayName = catalogString(model.displayName, 200);
    const description = catalogString(model.description, 1_000);
    const defaultReasoningEffort = catalogString(model.defaultReasoningEffort, 64);
    if (displayName) item.displayName = displayName;
    if (description) item.description = description;
    if (typeof model.frontier === 'boolean') item.frontier = model.frontier;
    if (typeof model.isDefault === 'boolean') item.isDefault = model.isDefault;
    if (defaultReasoningEffort) item.defaultReasoningEffort = defaultReasoningEffort;
    if (Array.isArray(model.supportedReasoningEfforts)) {
      item.supportedReasoningEfforts = model.supportedReasoningEfforts.map((effort) => catalogString(effort, 64)).filter(Boolean).slice(0, 20);
    }
    models.push(item);
  }
  const out = { models };
  const source = catalogString(sourceObject.source, 200);
  const checkedAt = catalogString(sourceObject.checkedAt, 100);
  if (source) out.source = source;
  if (checkedAt) out.checkedAt = checkedAt;
  return out;
}

function catalogString(value, max) {
  if (typeof value !== 'string') return null;
  const string = stripControl(value).trim().slice(0, max);
  if (!string || redact(string) !== string) return null;
  return string;
}

function defaultsFromRunConfig(config) {
  return {
    defaultPreset: config.preset,
    seats: config.seats.map((seat) => {
      const saved = {
        seatId: seat.seatId,
        label: seat.label,
        adapterId: seat.adapterId,
        requestedModel: seat.requestedModel,
        requestedModelSource: seat.requestedModelSource,
        requestedEffort: seat.requestedEffort,
        provider: seat.provider,
        profile: seat.profile,
        modelPolicy: seat.modelPolicy,
        authMode: seat.authMode,
        authEnvNames: seat.authEnvNames,
        permissionMode: seat.permissionMode,
        sandbox: seat.sandbox,
      };
      // Only catalog_frontier can carry pre-run model evidence, and at this point
      // preflight has replaced every submitted value with a refreshed server row.
      if (seat.modelPolicy === 'catalog_frontier' && seat.modelCatalog) {
        saved.modelCatalog = seat.modelCatalog;
        saved.modelCatalogSource = seat.modelCatalogSource;
        saved.modelCatalogCheckedAt = seat.modelCatalogCheckedAt;
        saved.modelClaim = seat.modelClaim;
      }
      return saved;
    }),
  };
}

function sanitizeSavedConfig(config) {
  if (!isPlainObject(config)) return null;
  const seats = [];
  for (const raw of Array.isArray(config.seats) ? config.seats.slice(0, 2) : []) {
    if (!isPlainObject(raw)) continue;
    const adapterId = storedIdentifier(raw.adapterId, 100);
    const adapter = adapterId ? getAdapter(adapterId) : null;
    if (!adapterId || !adapter) continue;
    const seatId = storedIdentifier(raw.seatId, 64);
    if (!seatId || !isSafeSegment(seatId)) continue;
    let auth;
    try {
      const inferredMode = raw.authMode || (Array.isArray(raw.authEnvNames) && raw.authEnvNames.includes('ANTHROPIC_API_KEY') ? 'api-key-env' : undefined);
      auth = resolveAuthMode(adapterId, inferredMode);
    } catch {
      auth = resolveAuthMode(adapterId);
    }
    const storedRequestedModel = storedIdentifier(raw.requestedModel, 200);
    const modelPolicy = safeStoredModelPolicy(raw.modelPolicy, storedRequestedModel);
    const requestedModel = modelPolicy === 'harness_default' ? null : storedRequestedModel;
    const seat = {
      seatId,
      label: storedText(raw.label, 100) || seatId,
      adapterId,
      requestedModel,
      requestedModelSource: modelPolicy === 'catalog_frontier' ? 'provider_catalog' : modelPolicy === 'pinned' ? 'user' : 'default',
      requestedEffort: storedIdentifier(raw.requestedEffort, 64),
      provider: providerFor(adapterId),
      profile: storedIdentifier(raw.profile, 128),
      modelPolicy,
      authMode: auth.authMode,
      authEnvNames: auth.authEnvNames,
      permissionMode: safeStoredPermissionMode(adapter, raw.permissionMode),
      sandbox: safeStoredSandbox(adapter, raw.sandbox),
    };
    seats.push(seat);
  }
  const defaultPreset = Object.values(Preset).includes(config.defaultPreset) ? config.defaultPreset : Preset.FULL_MIXTURE;
  return { v: Number.isInteger(config.v) ? config.v : 1, defaultPreset, seats };
}

function safeStoredModelPolicy(value, requestedModel) {
  try {
    const policy = normalizeModelPolicy(value, requestedModel);
    return ['catalog_frontier', 'pinned'].includes(policy) && !requestedModel ? 'harness_default' : policy;
  } catch {
    return requestedModel ? 'pinned' : 'harness_default';
  }
}

function safeStoredPermissionMode(adapter, value) {
  try {
    return validatePermissionMode(adapter, value, 0);
  } catch {
    return adapter.id === 'claude-code' ? 'acceptEdits' : null;
  }
}

function safeStoredSandbox(adapter, value) {
  try {
    return validateSandbox(adapter, value, 0);
  } catch {
    return 'unknown';
  }
}

function sanitizeState(state) {
  const safe = structuredClone(state);
  delete safe.task;
  if (safe.seed) safe.seed = { kind: safe.seed.kind };
  if (safe.workspaces && typeof safe.workspaces === 'object') {
    for (const workspace of Object.values(safe.workspaces)) if (workspace && typeof workspace === 'object') delete workspace.dir;
  }
  if (safe.result && typeof safe.result === 'object') delete safe.result.dir;
  if (Array.isArray(safe.seats)) {
    for (const seat of safe.seats) {
      delete seat.adapterConfig;
      delete seat.authLabel;
    }
  }
  return redactDeep(stripRuntimeIdentifiers(safe));
}

function stripRuntimeIdentifiers(value) {
  if (Array.isArray(value)) return value.map(stripRuntimeIdentifiers);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const omit = /^(accountId|account_id|userId|user_id|email|sessionId|session_id|threadId|thread_id|harnessPath)$/i;
  for (const [key, item] of Object.entries(value)) {
    if (!omit.test(key)) out[key] = stripRuntimeIdentifiers(item);
  }
  return out;
}

function redactWebPayload(value) {
  const redacted = redactDeep(value);
  // `redactDeep` deliberately treats a generic `auth` key as secret. Bootstrap's
  // auth object is a server-built allowlist of mode ids, env NAMES, and copyable
  // CLI commands, so restore only that known-safe projection after global redaction.
  if (Array.isArray(value?.adapters) && Array.isArray(redacted?.adapters)) {
    for (let index = 0; index < value.adapters.length; index++) {
      if (isPlainObject(value.adapters[index]?.auth)) redacted.adapters[index].auth = redactDeep(value.adapters[index].auth);
    }
  }
  return redactAccountIdentifiers(redacted);
}

function redactAccountIdentifiers(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[account omitted]')
      .replace(/\b((?:account|user|organization|org|tenant|workspace)(?:[\s_-]*id)?|email)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[account omitted]')
      .replace(/\b(?:acct|account)[_-][A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gi, '[account omitted]')
      .replace(/\b(?:org|user|usr|tenant)[_-][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/gi, '[account omitted]');
  }
  if (Array.isArray(value)) return value.map(redactAccountIdentifiers);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactAccountIdentifiers(item);
  return out;
}

function resultEvidenceForWeb(ctx) {
  const changedInput = Array.isArray(ctx.changed) ? ctx.changed : [];
  const changed = changedInput.slice(0, 500).flatMap((item) => {
    if (!isPlainObject(item)) return [];
    const status = catalogString(item.status, 16);
    const path = catalogString(item.path, 2_000);
    return path ? [{ status: status || '?', path }] : [];
  });
  const review = isPlainObject(ctx.review)
    ? {
        summary: catalogString(ctx.review.summary, 4_000) || 'No review summary was reported.',
        testsRun: ctx.review.testsRun === true,
        findings: (Array.isArray(ctx.review.findings) ? ctx.review.findings : []).slice(0, 100).flatMap((finding) => {
          if (!isPlainObject(finding)) return [];
          const message = catalogString(finding.message, 4_000);
          if (!message) return [];
          return [{
            severity: catalogString(finding.severity, 32) || 'info',
            ...(catalogString(finding.path, 2_000) ? { path: catalogString(finding.path, 2_000) } : {}),
            message,
          }];
        }),
        limitations: (Array.isArray(ctx.review.limitations) ? ctx.review.limitations : []).slice(0, 50).map((item) => catalogString(item, 2_000)).filter(Boolean),
      }
    : null;
  return { changed, changedTotal: changedInput.length, changedTruncated: changed.length < changedInput.length, review };
}

function validateDecision(pending, value) {
  if (pending.kind === 'leader') {
    if (typeof value !== 'string' || !pending.seatIds.includes(value)) {
      throw new ApiError(400, 'invalid_leader_decision', `Leader decision must be one of: ${pending.seatIds.join(', ')}.`);
    }
    return value;
  }
  if (!isPlainObject(value) || typeof value.confirm !== 'boolean') {
    throw new ApiError(400, 'invalid_result_decision', 'Result decision must contain a boolean confirm field.');
  }
  if (value.override !== undefined && typeof value.override !== 'boolean') {
    throw new ApiError(400, 'invalid_result_decision', 'Result decision override must be a boolean.');
  }
  return { confirm: value.confirm, override: value.override === true };
}

function findForbiddenField(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findForbiddenField(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  const forbidden = /^(password|passwd|pwd|token|accessToken|refreshToken|idToken|apiKey|api_key|apiSecret|secret|privateKey|credential|credentials|authorization|cookie|cookies|env|environment|authEnvNames|accountId|account_id|userId|user_id|email)$/i;
  for (const [key, item] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (forbidden.test(key)) return here;
    const nested = findForbiddenField(item, here);
    if (nested) return nested;
  }
  return null;
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ApiError(400, 'unknown_field', `${label} contains unsupported field '${unknown[0]}'.`);
}

function optionalIdentifier(value, field, max) {
  if (value == null || value === '') return null;
  const result = requireShortString(value, field, { max });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(result)) {
    throw new ApiError(400, 'invalid_field', `${field} contains unsupported characters.`);
  }
  if (result.includes('@')) throw new ApiError(400, 'account_identifier_forbidden', `${field} must not contain an email or account identifier.`);
  return result;
}

function requireShortString(value, field, { max }) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'invalid_field', `${field} must be a non-empty string.`);
  const result = value.trim();
  if (result.length > max) throw new ApiError(400, 'invalid_field', `${field} must be at most ${max} characters.`);
  if (stripControl(result) !== result || redact(result) !== result) throw new ApiError(400, 'invalid_field', `${field} contains unsafe or credential-shaped content.`);
  return result;
}

function storedIdentifier(value, max) {
  if (typeof value !== 'string') return null;
  const result = stripControl(value).trim().slice(0, max);
  if (!result || redact(result) !== result || result.includes('@') || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(result)) return null;
  return result;
}

function storedText(value, max) {
  if (typeof value !== 'string') return null;
  const result = stripControl(value).trim().slice(0, max);
  return result && redact(result) === result ? result : null;
}

function safeDiagnosticString(value) {
  const clean = storedText(value, 500);
  return clean ? clean.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[account omitted]') : null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function demoConfig() {
  return {
    preset: Preset.FULL_MIXTURE,
    task: 'Implement greet(name) handling empty names, with a short write-up.',
    seed: { kind: 'greenfield' },
    seats: [
      {
        seatId: 'seat-a',
        label: 'Seat A (Alpha)',
        adapterId: 'fake',
        provider: 'local',
        requestedModel: 'alpha-mini',
        requestedModelSource: 'user',
        modelPolicy: 'pinned',
        authMode: 'none',
        authEnvNames: [],
        authLabel: 'No authentication required',
        adapterConfig: { reportedModel: 'alpha-mini-2026', fallbackOnIntegrate: true, fallbackModel: 'alpha-nano-fallback', sessionPrefix: 'alpha' },
      },
      {
        seatId: 'seat-b',
        label: 'Seat B (Beta)',
        adapterId: 'fake',
        provider: 'local',
        requestedModel: null,
        requestedModelSource: 'default',
        modelPolicy: 'harness_default',
        authMode: 'none',
        authEnvNames: [],
        authLabel: 'No authentication required',
        adapterConfig: { reportedModel: null, sessionPrefix: 'beta' },
      },
    ],
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new ApiError(413, 'request_too_large', `JSON body must be at most ${MAX_BODY_BYTES} bytes.`));
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return reject(new ApiError(400, 'invalid_json', 'Request body is not valid JSON.'));
      }
      if (!isPlainObject(value)) return reject(new ApiError(400, 'invalid_json', 'JSON body must be an object.'));
      resolve(value);
    });
    req.on('error', () => reject(new ApiError(400, 'request_read_failed', 'Could not read the request body.')));
  });
}

function listenWithFallback(server, port, host, setPort, attempts = 10) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = (candidate) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries < attempts) {
          tries++;
          tryListen(candidate + 1);
        } else {
          reject(e);
        }
      });
      server.listen(candidate, host, () => {
        setPort(candidate);
        resolve();
      });
    };
    tryListen(port);
  });
}

class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
