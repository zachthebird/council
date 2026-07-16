import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEvent } from '../src/core/events.mjs';
import { RunStore } from '../src/storage/store.mjs';
import { hasLiveRunLock } from '../src/web/server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'bin', 'moh.mjs');
let launchCounter = 0;

function stateFor(runId, { createdAt, status, stage, seq }) {
  return {
    v: 1,
    runId,
    preset: 'quick-compare',
    task: `private task for ${runId}`,
    seed: { kind: 'greenfield' },
    stage,
    seats: [],
    createdAt,
    leaderSeatId: null,
    limitations: [],
    status,
    seq,
  };
}

function append(store, runId, seq, kind, marker, stage = null) {
  store.appendEvent(
    runId,
    makeEvent({
      seq,
      runId,
      stage,
      kind,
      ts: `2026-01-01T00:00:0${seq}.000Z`,
      payload: { marker },
    }),
  );
}

function seedHistory(stateRoot) {
  const store = new RunStore(join(stateRoot, 'runs'));
  const staleRunId = 'run-stale-restart';
  const completedRunId = 'run-completed-future';

  store.create(
    staleRunId,
    stateFor(staleRunId, {
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      stage: 'generate',
      seq: 0,
    }),
  );
  append(store, staleRunId, 1, 'run.started', 'stale-only');
  append(store, staleRunId, 2, 'stage.entered', 'stale-stage', 'generate');
  // Deliberately leave the snapshot one event behind. Recovery must seed from
  // the durable event-log high-water mark, not reuse state.seq.
  store.saveState(
    staleRunId,
    stateFor(staleRunId, {
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      stage: 'generate',
      seq: 1,
    }),
  );
  // Simulate a crashed owner. `RunStore.create()` writes this test process's
  // live PID, which a second web companion must correctly treat as still owned.
  writeFileSync(join(store.runPath(staleRunId), '.lock'), '999999999');

  store.create(
    completedRunId,
    stateFor(completedRunId, {
      // A future date makes the active-first assertion meaningful: ordinary
      // createdAt ordering would otherwise put this row above a live run.
      createdAt: '2099-01-01T00:00:00.000Z',
      status: 'finished',
      stage: 'finished',
      seq: 0,
    }),
  );
  append(store, completedRunId, 1, 'run.started', 'completed-only');
  append(store, completedRunId, 2, 'run.finished', 'completed-finished', 'finished');
  store.saveState(
    completedRunId,
    stateFor(completedRunId, {
      createdAt: '2099-01-01T00:00:00.000Z',
      status: 'finished',
      stage: 'finished',
      seq: 2,
    }),
  );
  store.release(completedRunId);

  return { store, staleRunId, completedRunId };
}

test('live-lock probe treats EPERM as an existing owner', () => {
  const temp = mkdtempSync(join(tmpdir(), 'moh-web-eperm-lock-'));
  const store = new RunStore(join(temp, 'runs'));
  const runId = 'run-eperm-owner';
  store.create(runId, stateFor(runId, { createdAt: '2026-01-01T00:00:00.000Z', status: 'running', stage: 'generate', seq: 0 }));
  writeFileSync(join(store.runPath(runId), '.lock'), '4242');
  const deniedProbe = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  const missingProbe = () => {
    const error = new Error('no such process');
    error.code = 'ESRCH';
    throw error;
  };
  assert.equal(hasLiveRunLock(store, runId, deniedProbe), true);
  assert.equal(hasLiveRunLock(store, runId, missingProbe), false);
});

async function startServer(env) {
  launchCounter += 1;
  const requestedPort = 26_000 + (process.pid % 10_000) + launchCounter * 20;
  const proc = spawn(process.execPath, [bin, 'web', '--port', String(requestedPort)], {
    cwd: root,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`web server did not start\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 8_000);
    const inspect = () => {
      const match = /moh web on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      cleanup();
      resolve(Number(match[1]));
    };
    const failed = (code, signal) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`web server exited before listening (${code ?? signal})\nstdout: ${stdout}\nstderr: ${stderr}`));
    };
    const cleanup = () => {
      proc.stdout.off('data', inspect);
      proc.off('exit', failed);
    };
    proc.stdout.on('data', inspect);
    proc.once('exit', failed);
    inspect();
  });

  const base = `http://127.0.0.1:${port}`;
  const rootResponse = await fetch(base + '/');
  const match = /moh_cap=([^;]+)/.exec(rootResponse.headers.get('set-cookie') || '');
  assert.ok(match, 'server root supplies the capability cookie');
  return { proc, base, cookie: `moh_cap=${match[1]}`, output: () => ({ stdout, stderr }) };
}

async function stopServer(server) {
  if (!server?.proc || server.proc.exitCode !== null) return;
  const exited = new Promise((resolve) => server.proc.once('exit', resolve));
  server.proc.kill('SIGINT');
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000));
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    server.proc.kill('SIGKILL');
    await exited;
  }
}

async function getJson(server, path, { authorized = true } = {}) {
  const res = await fetch(server.base + path, {
    headers: authorized ? { cookie: server.cookie } : {},
  });
  return { res, body: await res.json() };
}

async function postJson(server, path, body) {
  const res = await fetch(server.base + path, {
    method: 'POST',
    headers: {
      cookie: server.cookie,
      'content-type': 'application/json',
      origin: server.base,
      'x-moh-csrf': '1',
    },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

async function waitFor(server, predicate, description) {
  let value;
  for (let attempt = 0; attempt < 200; attempt++) {
    value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const output = server.output();
  throw new Error(`timed out waiting for ${description}\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
}

async function finishDemo(server, runId) {
  const handled = new Set();
  await waitFor(
    server,
    async () => {
      const { res, body } = await getJson(server, `/api/state?runId=${encodeURIComponent(runId)}`);
      assert.equal(res.status, 200);
      if (!body.running) return body.state;
      const decision = body.pendingDecision;
      if (!decision || handled.has(decision.payload?.id)) return null;
      handled.add(decision.payload.id);
      let value;
      if (decision.kind === 'gate.leader') value = decision.payload.candidates[0].seatId;
      else if (decision.kind === 'gate.result') value = { confirm: false };
      else throw new Error(`unexpected pending decision: ${decision.kind}`);
      const decided = await postJson(server, '/api/decision', { id: decision.payload.id, value });
      assert.equal(decided.res.status, 200, JSON.stringify(decided.body));
      return null;
    },
    'demo completion',
  );
}

test('web history APIs isolate runs, sort active-first, and recover interrupted state exactly once', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'moh-web-history-'));
  const stateRoot = join(temp, 'state');
  const configRoot = join(temp, 'config');
  mkdirSync(configRoot, { recursive: true });
  const { store, staleRunId, completedRunId } = seedHistory(stateRoot);
  const env = { MOH_STATE_DIR: stateRoot, MOH_CONFIG_DIR: configRoot };

  let server = await startServer(env);
  t.after(async () => stopServer(server));

  await t.test('history endpoints require the capability and order two durable runs newest-first', async () => {
    for (const path of ['/api/runs', `/api/events?runId=${completedRunId}`]) {
      const denied = await getJson(server, path, { authorized: false });
      assert.equal(denied.res.status, 403);
      assert.equal(denied.body.code, 'unauthorized');
    }

    const listing = await getJson(server, '/api/runs');
    assert.equal(listing.res.status, 200);
    assert.equal(listing.body.activeRunId, null);
    assert.deepEqual(
      listing.body.runs.map((run) => run.runId),
      [completedRunId, staleRunId],
      'without an active run, rows use descending createdAt order',
    );
    assert.deepEqual(
      listing.body.runs.map((run) => run.active),
      [false, false],
    );
    assert.equal(Object.hasOwn(listing.body.runs[0], 'task'), false, 'history summary does not expose task text');
  });

  await t.test('startup converts stale running state to a failed terminal record with contiguous event sequence', async () => {
    const snapshot = await getJson(server, `/api/state?runId=${staleRunId}`);
    assert.equal(snapshot.res.status, 200);
    assert.equal(snapshot.body.running, false);
    assert.equal(snapshot.body.activeRunId, null);
    assert.equal(snapshot.body.runId, staleRunId);
    assert.equal(snapshot.body.state.status, 'failed');
    assert.equal(snapshot.body.state.stage, 'failed');
    assert.match(snapshot.body.state.error, /interrupted when the web companion stopped/i);
    assert.ok(snapshot.body.state.limitations.some((item) => /not automatically restarted/i.test(item)));
    assert.equal(Object.hasOwn(snapshot.body.state, 'task'), false, 'historical state omits private task text');

    const history = await getJson(server, `/api/events?runId=${staleRunId}`);
    assert.equal(history.res.status, 200);
    assert.equal(history.body.runId, staleRunId);
    assert.equal(history.body.truncated, false);
    assert.deepEqual(history.body.integrity, { gaps: [], duplicates: [], torn: 0 });
    assert.deepEqual(
      history.body.events.map((event) => event.seq),
      [1, 2, 3, 4],
      'recovery appends after the event-log high-water mark even when state.seq lags',
    );
    assert.deepEqual(history.body.events.slice(-2).map((event) => event.kind), ['notice', 'run.finished']);
    assert.equal(history.body.events.at(-2).payload.code, 'interrupted_by_restart');
    assert.ok(history.body.events.every((event) => event.runId === staleRunId));
    assert.equal(existsSync(join(store.runPath(staleRunId), '.lock')), false);
    assert.equal(existsSync(join(store.runPath(staleRunId), '.lock.released')), true);
  });

  await t.test('event replay is cross-run isolated and missing runs return a stable 404', async () => {
    const completed = await getJson(server, `/api/events?runId=${completedRunId}`);
    assert.equal(completed.res.status, 200);
    assert.deepEqual(completed.body.integrity, { gaps: [], duplicates: [], torn: 0 });
    assert.deepEqual(completed.body.events.map((event) => event.payload.marker), ['completed-only', 'completed-finished']);
    assert.ok(completed.body.events.every((event) => event.runId === completedRunId));
    assert.ok(completed.body.events.every((event) => event.payload.marker !== 'stale-only'));

    const stale = await getJson(server, `/api/events?runId=${staleRunId}`);
    assert.ok(stale.body.events.every((event) => event.runId === staleRunId));
    assert.ok(stale.body.events.every((event) => event.payload.marker !== 'completed-only'));

    const missing = await getJson(server, '/api/events?runId=run-does-not-exist');
    assert.equal(missing.res.status, 404);
    assert.equal(missing.body.code, 'run_not_found');
  });

  await stopServer(server);
  server = await startServer(env);

  await t.test('normalization is idempotent across a second restart', async () => {
    const snapshot = await getJson(server, `/api/state?runId=${staleRunId}`);
    assert.equal(snapshot.body.state.status, 'failed');
    const history = await getJson(server, `/api/events?runId=${staleRunId}`);
    assert.deepEqual(history.body.events.map((event) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual(history.body.integrity, { gaps: [], duplicates: [], torn: 0 });
    assert.equal(history.body.events.filter((event) => event.kind === 'run.finished').length, 1);
  });

  await t.test('a live run sorts above a future-dated completed run and remains event-isolated', async () => {
    const started = await postJson(server, '/api/run', { mode: 'demo' });
    assert.equal(started.res.status, 200, JSON.stringify(started.body));
    const activeRunId = started.body.runId;

    const listing = await waitFor(
      server,
      async () => {
        const result = await getJson(server, '/api/runs');
        return result.body.activeRunId === activeRunId ? result : null;
      },
      'active run in history',
    );
    assert.equal(listing.body.runs[0].runId, activeRunId);
    assert.equal(listing.body.runs[0].active, true);
    assert.equal(listing.body.runs[1].runId, completedRunId, 'active flag outranks the future createdAt timestamp');
    assert.equal(listing.body.runs.find((run) => run.runId === staleRunId).active, false);

    const activeEvents = await waitFor(
      server,
      async () => {
        const result = await getJson(server, `/api/events?runId=${encodeURIComponent(activeRunId)}`);
        return result.body.events.length ? result : null;
      },
      'active run events',
    );
    assert.ok(activeEvents.body.events.every((event) => event.runId === activeRunId));
    assert.ok(activeEvents.body.events.every((event) => event.payload?.marker !== 'completed-only'));

    const completedDuringRun = await getJson(server, `/api/events?runId=${completedRunId}`);
    assert.ok(completedDuringRun.body.events.every((event) => event.runId === completedRunId));
    assert.ok(completedDuringRun.body.events.every((event) => event.kind !== 'gate.leader'));

    await finishDemo(server, activeRunId);
    const after = await getJson(server, '/api/runs');
    assert.equal(after.body.activeRunId, null);
    assert.equal(after.body.runs.some((run) => run.active), false);
    assert.equal(after.body.runs[0].runId, completedRunId, 'completed rows return to createdAt ordering');
  });
});

test('web startup leaves a running record owned by a live lock PID untouched', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'moh-web-live-lock-'));
  const stateRoot = join(temp, 'state');
  const configRoot = join(temp, 'config');
  mkdirSync(configRoot, { recursive: true });
  const store = new RunStore(join(stateRoot, 'runs'));
  const runId = 'run-owned-by-live-process';
  store.create(
    runId,
    stateFor(runId, {
      createdAt: '2026-02-01T00:00:00.000Z',
      status: 'running',
      stage: 'generate',
      seq: 0,
    }),
  );
  append(store, runId, 1, 'run.started', 'live-owner');
  store.saveState(
    runId,
    stateFor(runId, {
      createdAt: '2026-02-01T00:00:00.000Z',
      status: 'running',
      stage: 'generate',
      seq: 1,
    }),
  );
  // `create()` records this still-live test process. The child web companion
  // must not reinterpret the run as an interrupted one.
  assert.equal(String(process.pid), readFileSync(join(store.runPath(runId), '.lock'), 'utf8'));

  const server = await startServer({ MOH_STATE_DIR: stateRoot, MOH_CONFIG_DIR: configRoot });
  t.after(async () => stopServer(server));

  const snapshot = await getJson(server, `/api/state?runId=${runId}`);
  assert.equal(snapshot.res.status, 200);
  assert.equal(snapshot.body.state.status, 'running');
  assert.equal(snapshot.body.state.stage, 'generate');
  assert.equal(snapshot.body.state.error, undefined);

  const history = await getJson(server, `/api/events?runId=${runId}`);
  assert.deepEqual(history.body.events.map((event) => event.seq), [1]);
  assert.deepEqual(history.body.events.map((event) => event.payload.marker), ['live-owner']);
  assert.deepEqual(history.body.integrity, { gaps: [], duplicates: [], torn: 0 });
  assert.equal(existsSync(join(store.runPath(runId), '.lock')), true);
  assert.equal(existsSync(join(store.runPath(runId), '.lock.released')), false);
});

test('concurrent web startups atomically normalize an interrupted run only once', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'moh-web-concurrent-recovery-'));
  const stateRoot = join(temp, 'state');
  const configRoot = join(temp, 'config');
  mkdirSync(configRoot, { recursive: true });
  const store = new RunStore(join(stateRoot, 'runs'));
  const runId = 'run-concurrent-recovery';
  store.create(
    runId,
    stateFor(runId, {
      createdAt: '2026-02-02T00:00:00.000Z',
      status: 'running',
      stage: 'generate',
      seq: 0,
    }),
  );
  append(store, runId, 1, 'run.started', 'before-recovery');
  store.saveState(
    runId,
    stateFor(runId, {
      createdAt: '2026-02-02T00:00:00.000Z',
      status: 'running',
      stage: 'generate',
      seq: 1,
    }),
  );
  writeFileSync(join(store.runPath(runId), '.lock'), '999999999');
  // Simulate a previous recovery process dying after it acquired the claim.
  // Concurrent starters must retire this dead owner and still recover once.
  writeFileSync(join(store.runPath(runId), '.web-recovery-999999999-deadbeefdeadbeef.lock'), '999999999');

  const env = { MOH_STATE_DIR: stateRoot, MOH_CONFIG_DIR: configRoot };
  const servers = await Promise.all([startServer(env), startServer(env)]);
  t.after(async () => Promise.all(servers.map(stopServer)));

  for (const server of servers) {
    const snapshot = await getJson(server, `/api/state?runId=${runId}`);
    assert.equal(snapshot.body.state.status, 'failed');
    const history = await getJson(server, `/api/events?runId=${runId}`);
    assert.deepEqual(history.body.events.map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(history.body.events.map((event) => event.kind), ['run.started', 'notice', 'run.finished']);
    assert.deepEqual(history.body.integrity, { gaps: [], duplicates: [], torn: 0 });
  }
  assert.deepEqual(readdirSync(store.runPath(runId)).filter((name) => name.startsWith('.web-recovery-')), []);
});

test('overlapping MoH and Council roots never reclassify or mutate legacy state as native', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'moh-web-overlap-'));
  const configRoot = join(root, 'config');
  mkdirSync(configRoot, { recursive: true });
  const legacyRunId = 'legacy-overlap-running';
  const legacyRunDir = join(root, 'runs', legacyRunId);
  mkdirSync(legacyRunDir, { recursive: true });
  const privatePath = 'C:/Users/private/legacy-model-or-path';
  const privatePrompt = 'overlap-only private prompt';
  const legacyState = JSON.stringify({
    id: legacyRunId,
    prompt: privatePrompt,
    status: 'running',
    stage: 'generate',
    sessions: { claude: { model: privatePath }, codex: null },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const legacyEvents = JSON.stringify({ type: 'legacy.output', path: privatePath, content: privatePrompt }) + '\n';
  writeFileSync(join(legacyRunDir, 'state.json'), legacyState);
  writeFileSync(join(legacyRunDir, 'events.jsonl'), legacyEvents);

  const store = new RunStore(join(root, 'runs'));
  const nativeRunId = 'run-native-in-overlap';
  store.create(
    nativeRunId,
    stateFor(nativeRunId, {
      createdAt: '2026-02-01T00:00:00.000Z',
      status: 'finished',
      stage: 'finished',
      seq: 0,
    }),
  );
  store.release(nativeRunId);

  const server = await startServer({ MOH_STATE_DIR: root, MOH_CONFIG_DIR: configRoot, COUNCIL_STATE_DIR: root });
  t.after(async () => stopServer(server));

  const listing = await getJson(server, '/api/runs');
  const legacyRow = listing.body.runs.find((run) => run.runId === legacyRunId);
  const nativeRow = listing.body.runs.find((run) => run.runId === nativeRunId);
  assert.deepEqual({ source: legacyRow.source, legacy: legacyRow.legacy, readOnly: legacyRow.readOnly }, { source: 'council', legacy: true, readOnly: true });
  assert.deepEqual({ source: nativeRow.source, legacy: nativeRow.legacy, readOnly: nativeRow.readOnly }, { source: 'moh', legacy: false, readOnly: false });

  const snapshot = await getJson(server, `/api/state?runId=${legacyRunId}`);
  assert.equal(snapshot.body.source, 'council');
  assert.equal(snapshot.body.readOnly, true);
  assert.equal(snapshot.body.state.seats[0].requestedModel, null, 'path-shaped legacy model text is not exposed');
  assert.equal(snapshot.body.state.provenanceBySeat['seat-a'].requestedModel, null);
  const snapshotText = JSON.stringify(snapshot.body);
  assert.equal(snapshotText.includes(privatePath), false);
  assert.equal(snapshotText.includes(privatePrompt), false);

  const events = await getJson(server, `/api/events?runId=${legacyRunId}`);
  assert.deepEqual(events.body.events, []);
  assert.equal(events.body.source, 'council');
  assert.equal(JSON.stringify(events.body).includes(privatePath), false);
  assert.equal(readFileSync(join(legacyRunDir, 'state.json'), 'utf8'), legacyState);
  assert.equal(readFileSync(join(legacyRunDir, 'events.jsonl'), 'utf8'), legacyEvents);
  assert.equal(existsSync(join(legacyRunDir, '.lock')), false);
  assert.equal(existsSync(join(legacyRunDir, '.lock.released')), false);
});

test('web history merges sanitized, read-only Council runs without replaying legacy artifacts', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'moh-web-legacy-history-'));
  const stateRoot = join(temp, 'state');
  const configRoot = join(temp, 'config');
  const councilRoot = join(temp, 'council');
  mkdirSync(configRoot, { recursive: true });

  const privatePrompt = 'private legacy prompt ' + 'sk-' + 'A'.repeat(24);
  const privatePath = join(temp, 'private', 'legacy-worktree');
  const rawEvent = JSON.stringify({ type: 'legacy.output', path: privatePath, content: privatePrompt }) + '\n';
  function writeLegacy(dirName, id, createdAt) {
    const runDir = join(councilRoot, 'runs', dirName);
    mkdirSync(runDir, { recursive: true });
    const rawState = JSON.stringify(
      {
        id,
        prompt: privatePrompt,
        seedRepo: privatePath,
        stage: 'published',
        leader: 'claude',
        verdict: 'APPROVE',
        sessions: {
          claude: { sessionId: 'legacy-secret-session-a', model: 'legacy-sonnet-request' },
          codex: { sessionId: 'legacy-secret-session-b' },
        },
        critiques: { claude: privatePrompt, codex: privatePath },
        finalReview: privatePrompt,
        published: { path: privatePath },
        createdAt,
      },
      null,
      2,
    );
    writeFileSync(join(runDir, 'state.json'), rawState);
    writeFileSync(join(runDir, 'events.jsonl'), rawEvent);
    return { runDir, rawState };
  }

  const newest = writeLegacy('legacy-newest', 'legacy-newest', '2099-03-01T00:00:00.000Z');
  writeLegacy('legacy-newest-duplicate', 'legacy-newest', '2099-03-01T00:00:00.000Z');
  writeLegacy('legacy-older', 'legacy-older', '2024-03-01T00:00:00.000Z');
  writeLegacy('legacy-collision', 'shared-run-id', '2100-01-01T00:00:00.000Z');
  const sessionlessDir = join(councilRoot, 'runs', 'legacy-sessionless');
  mkdirSync(sessionlessDir, { recursive: true });
  const sessionlessState = JSON.stringify({ id: 'legacy-sessionless', prompt: privatePrompt, stage: 'awaiting_publish', createdAt: '2098-03-01T00:00:00.000Z' });
  writeFileSync(join(sessionlessDir, 'state.json'), sessionlessState);
  const corruptDir = join(councilRoot, 'runs', 'legacy-corrupt');
  mkdirSync(corruptDir, { recursive: true });
  const corruptState = '{"id":"legacy-corrupt","prompt":"' + privatePrompt;
  writeFileSync(join(corruptDir, 'state.json'), corruptState);
  writeFileSync(join(corruptDir, 'events.jsonl'), rawEvent);
  const newerSchemaDir = join(councilRoot, 'runs', 'legacy-newer-schema');
  mkdirSync(newerSchemaDir, { recursive: true });
  const newerSchemaState = JSON.stringify({ id: 'legacy-newer-schema', schema: 2, prompt: privatePrompt, sessions: { claude: null, codex: null } });
  writeFileSync(join(newerSchemaDir, 'state.json'), newerSchemaState);

  const store = new RunStore(join(stateRoot, 'runs'));
  store.create(
    'shared-run-id',
    stateFor('shared-run-id', {
      createdAt: '2025-01-01T00:00:00.000Z',
      status: 'finished',
      stage: 'finished',
      seq: 0,
    }),
  );
  store.release('shared-run-id');

  const server = await startServer({
    MOH_STATE_DIR: stateRoot,
    MOH_CONFIG_DIR: configRoot,
    COUNCIL_STATE_DIR: councilRoot,
  });
  t.after(async () => stopServer(server));

  const listing = await getJson(server, '/api/runs');
  assert.equal(listing.res.status, 200);
  const relevantIds = ['legacy-newest', 'legacy-sessionless', 'shared-run-id', 'legacy-older', 'legacy-corrupt'];
  const relevant = listing.body.runs.filter((run) => relevantIds.includes(run.runId));
  assert.deepEqual(relevant.map((run) => run.runId), ['legacy-newest', 'legacy-sessionless', 'shared-run-id', 'legacy-older', 'legacy-corrupt']);
  assert.equal(listing.body.runs.filter((run) => run.runId === 'legacy-newest').length, 1, 'duplicate legacy ids collapse to one row');
  assert.deepEqual(
    relevant.map((run) => ({ id: run.runId, legacy: run.legacy, source: run.source, readOnly: run.readOnly })),
    [
      { id: 'legacy-newest', legacy: true, source: 'council', readOnly: true },
      { id: 'legacy-sessionless', legacy: true, source: 'council', readOnly: true },
      { id: 'shared-run-id', legacy: false, source: 'moh', readOnly: false },
      { id: 'legacy-older', legacy: true, source: 'council', readOnly: true },
      { id: 'legacy-corrupt', legacy: true, source: 'council', readOnly: true },
    ],
    'the local MoH record wins its id collision',
  );
  assert.ok(relevant.every((run) => !Object.hasOwn(run, 'path') && !Object.hasOwn(run, 'task')));
  assert.equal(relevant.at(-1).status, 'quarantined');
  assert.equal(relevant.at(-1).quarantined, true);

  const collisionState = await getJson(server, '/api/state?runId=shared-run-id');
  assert.equal(collisionState.body.source, 'moh');
  assert.equal(collisionState.body.legacy, false);
  assert.equal(collisionState.body.state.createdAt, '2025-01-01T00:00:00.000Z');
  const collisionEvents = await getJson(server, '/api/events?runId=shared-run-id');
  assert.equal(collisionEvents.res.status, 200);
  assert.deepEqual(collisionEvents.body.events, []);
  assert.equal(Object.hasOwn(collisionEvents.body, 'legacy'), false);

  const snapshot = await getJson(server, '/api/state?runId=legacy-newest');
  assert.equal(snapshot.res.status, 200);
  assert.equal(snapshot.body.legacy, true);
  assert.equal(snapshot.body.source, 'council');
  assert.equal(snapshot.body.readOnly, true);
  assert.equal(snapshot.body.state.reviewIntegrity, 'unattested');
  assert.deepEqual(snapshot.body.state.seats.map((seat) => seat.seatId), ['seat-a', 'seat-b']);
  assert.deepEqual(snapshot.body.state.seats.map((seat) => seat.adapterId), ['claude-code', 'codex-cli']);
  for (const provenance of Object.values(snapshot.body.state.provenanceBySeat)) {
    assert.equal(provenance.state, 'unknown');
    assert.equal(provenance.reportedModel, null);
    assert.equal(provenance.modelClaim, 'unattested');
    assert.equal(Object.hasOwn(provenance, 'sessionId'), false);
  }
  const snapshotText = JSON.stringify(snapshot.body);
  for (const forbidden of [privatePrompt, privatePath, 'legacy-secret-session-a', 'legacy-secret-session-b']) {
    assert.equal(snapshotText.includes(forbidden), false, `snapshot omits ${forbidden}`);
  }

  const events = await getJson(server, '/api/events?runId=legacy-newest');
  assert.equal(events.res.status, 200);
  assert.deepEqual(events.body.events, []);
  assert.deepEqual(events.body.integrity, { gaps: [], duplicates: [], torn: 0 });
  assert.equal(events.body.legacy, true);
  assert.equal(events.body.source, 'council');
  assert.equal(events.body.readOnly, true);
  assert.match(events.body.note, /not replayed/i);
  const eventsText = JSON.stringify(events.body);
  assert.equal(eventsText.includes(privatePath), false);
  assert.equal(eventsText.includes(privatePrompt), false);

  const sessionless = await getJson(server, '/api/state?runId=legacy-sessionless');
  assert.deepEqual(sessionless.body.state.seats.map((seat) => seat.adapterId), ['claude-code', 'codex-cli']);
  assert.ok(Object.values(sessionless.body.state.provenanceBySeat).every((provenance) => provenance.state === 'unknown' && provenance.reportedModel === null));
  assert.equal(JSON.stringify(sessionless.body).includes(privatePrompt), false);

  const quarantined = await getJson(server, '/api/state?runId=legacy-corrupt');
  assert.equal(quarantined.body.quarantined, true);
  assert.equal(quarantined.body.state.status, 'quarantined');
  assert.equal(quarantined.body.state.readOnly, true);
  assert.deepEqual(quarantined.body.state.seats.map((seat) => seat.adapterId), ['claude-code', 'codex-cli']);
  const quarantinedText = JSON.stringify(quarantined.body);
  assert.equal(quarantinedText.includes(privatePrompt), false);
  assert.equal(quarantinedText.includes(corruptDir), false);
  const quarantinedEvents = await getJson(server, '/api/events?runId=legacy-corrupt');
  assert.deepEqual(quarantinedEvents.body.events, []);
  assert.equal(quarantinedEvents.body.quarantined, true);
  assert.match(quarantinedEvents.body.note, /quarantined and unparseable/i);
  assert.equal(JSON.stringify(quarantinedEvents.body).includes(privatePath), false);
  const newerSchema = await getJson(server, '/api/state?runId=legacy-newer-schema');
  assert.equal(newerSchema.body.quarantined, true);
  assert.equal(newerSchema.body.state.status, 'quarantined');
  assert.equal(JSON.stringify(newerSchema.body).includes(privatePrompt), false);

  const started = await postJson(server, '/api/run', { mode: 'demo' });
  assert.equal(started.res.status, 200, JSON.stringify(started.body));
  const activeRunId = started.body.runId;
  const activeListing = await waitFor(
    server,
    async () => {
      const result = await getJson(server, '/api/runs');
      return result.body.activeRunId === activeRunId ? result : null;
    },
    'active MoH run above legacy history',
  );
  assert.equal(activeListing.body.runs[0].runId, activeRunId);
  assert.equal(activeListing.body.runs[0].source, 'moh');
  assert.equal(activeListing.body.runs[0].active, true);
  await finishDemo(server, activeRunId);

  assert.equal(readFileSync(join(newest.runDir, 'state.json'), 'utf8'), newest.rawState, 'legacy state remains byte-for-byte unchanged');
  assert.equal(readFileSync(join(newest.runDir, 'events.jsonl'), 'utf8'), rawEvent, 'legacy events remain byte-for-byte unchanged');
  assert.equal(readFileSync(join(sessionlessDir, 'state.json'), 'utf8'), sessionlessState, 'sessionless legacy state remains unchanged');
  assert.equal(readFileSync(join(corruptDir, 'state.json'), 'utf8'), corruptState, 'quarantined legacy state remains unchanged');
  assert.equal(readFileSync(join(corruptDir, 'events.jsonl'), 'utf8'), rawEvent, 'quarantined legacy events remain unchanged');
  assert.equal(readFileSync(join(newerSchemaDir, 'state.json'), 'utf8'), newerSchemaState, 'newer-schema legacy state remains unchanged');
});
