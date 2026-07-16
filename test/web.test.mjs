import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempStore } from './helpers.mjs';
import { authModeAvailable } from '../src/web/server.mjs';

const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'moh.mjs');
const testSecret = ['sk-ant', 'web-test-secret-1234567890'].join('-');
const testAccount = 'person@example.test';
let proc, port, base, codexRefreshMarker;

before(async () => {
  const root = tempStore();
  mkdirSync(process.env.MOH_CONFIG_DIR, { recursive: true });
  // Seed an intentionally dirty legacy config. Bootstrap must project only its
  // allowlisted, non-secret defaults and must not echo account identifiers.
  writeFileSync(
    join(process.env.MOH_CONFIG_DIR, 'config.json'),
    JSON.stringify({
      v: 1,
      defaultPreset: 'quick-compare',
      token: testSecret,
      accountId: testAccount,
      seats: [
        {
          seatId: 'seat-a',
          label: 'Saved A',
          adapterId: 'fake',
          authMode: 'none',
          profile: testAccount,
          requestedModel: 'saved-pinned',
          requestedModelSource: 'provider_catalog',
          configuredModel: 'forged-configured',
          modelPolicy: 'pinned',
          modelCatalog: { source: 'client config', checkedAt: '2099-01-01', models: [{ slug: 'saved-pinned', frontier: true }] },
          modelClaim: 'forged latest claim',
          provider: 'Forged Provider',
          permissionMode: 'auto',
          sandbox: 'danger-full-access',
          apiKey: testSecret,
        },
        {
          seatId: 'seat-b',
          label: 'Saved B',
          adapterId: 'codex-cli',
          authMode: 'delegated',
          profile: 'profile-routed',
          requestedModelSource: 'OpenAI catalog',
          configuredModel: 'forged-default',
          modelPolicy: 'harness_default',
          modelClaim: 'OpenAI',
          provider: 'OpenAI',
        },
      ],
    }),
  );

  // Deterministic Codex probe fixture: bundled discovery succeeds, while the
  // current/account-aware refresh is attempted and fails. Bootstrap must retain
  // the explicitly labelled bundled fallback instead of replacing it with empty.
  const fakeCodex = join(root, 'fake-codex.mjs');
  codexRefreshMarker = join(root, 'codex-refresh-attempted');
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const command = args.join(' ');
if (command === '--version') console.log('codex-cli 1.2.3');
else if (command === '--help') console.log('Usage: codex exec');
else if (command === 'exec --help') console.log('--json --model --sandbox --profile');
else if (command === 'debug models --help') console.log('Raw model catalog; --bundled');
else if (command === 'login status') console.log('Logged in');
else if (command === 'debug models --bundled') console.log(JSON.stringify([{ slug: 'bundled-frontier', display_name: 'Bundled Frontier', description: 'Latest frontier model bundled with this CLI.', supported_reasoning_levels: ['low', 'high'] }]));
else if (command === 'debug models') { writeFileSync(${JSON.stringify(codexRefreshMarker)}, 'yes'); process.exitCode = 1; }
else process.exitCode = 1;
`,
  );
  chmodSync(fakeCodex, 0o755);

  port = 7390 + Math.floor(process.pid % 100);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [bin, 'web', '--port', String(port)], {
    env: { ...process.env, NO_COLOR: '1', ANTHROPIC_API_KEY: testSecret, MOH_CODEX_PATH: fakeCodex },
  });
  await new Promise((resolve, reject) => {
    let buf = '';
    const timeout = setTimeout(() => reject(new Error('web did not start')), 8_000);
    proc.stdout.on('data', (data) => {
      buf += data;
      if (buf.includes('moh web on')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on('error', reject);
  });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
});

async function getCookie() {
  const res = await fetch(base + '/', { headers: { host: `127.0.0.1:${port}` } });
  const setCookie = res.headers.get('set-cookie') || '';
  const match = /moh_cap=([^;]+)/.exec(setCookie);
  return match ? `moh_cap=${match[1]}` : '';
}

async function getJson(path, cookie) {
  const res = await fetch(base + path, { headers: cookie ? { cookie } : {} });
  return { res, body: await res.json() };
}

async function postJson(path, cookie, body, extraHeaders = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base, 'x-moh-csrf': '1', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

// undici/fetch forbids overriding Host, so use raw http to send a spoofed Host.
function rawGet(path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

function realConfig() {
  return {
    mode: 'real',
    saveConfig: true,
    task: 'Create a deterministic greeting utility and review it.',
    seed: { kind: 'greenfield' },
    preset: 'quick-compare',
    seats: [
      {
        seatId: 'seat-a',
        label: 'Web A',
        adapterId: 'fake',
        authMode: 'none',
        requestedModel: 'fake-pinned',
        modelPolicy: 'pinned',
      },
      {
        seatId: 'seat-b',
        label: 'Web B',
        adapterId: 'fake',
        authMode: 'none',
        requestedModel: null,
        modelPolicy: 'harness_default',
      },
    ],
  };
}

async function driveRun(cookie, request) {
  const stream = await fetch(base + '/events', { headers: { cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const started = await postJson('/api/run', cookie, request);
  assert.equal(started.res.status, 200, JSON.stringify(started.body));
  assert.equal(typeof started.body.runId, 'string');

  const current = await getJson('/api/state', cookie);
  assert.equal(current.body.running, true);
  assert.equal(current.body.runId, started.body.runId);
  assert.ok(current.body.state, 'GET /api/state without runId returns the active state');

  let buffer = '';
  let completed = false;
  let timedOut = false;
  let leaderHadOutput = false;
  let resultGateHadEvidence = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 12_000);
  while (!completed) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.kind === 'gate.leader') {
        leaderHadOutput = event.payload.candidates.every((candidate) => typeof candidate.output === 'string' && candidate.output.length > 0);
        const decision = await postJson('/api/decision', cookie, { id: event.payload.id, value: event.payload.candidates[0].seatId });
        assert.equal(decision.res.status, 200, JSON.stringify(decision.body));
      } else if (event.kind === 'gate.result') {
        resultGateHadEvidence = Array.isArray(event.payload.changed)
          && event.payload.changed.length > 0
          && Number.isInteger(event.payload.changedTotal)
          && typeof event.payload.review?.summary === 'string'
          && Array.isArray(event.payload.review?.findings);
        const decision = await postJson('/api/decision', cookie, { id: event.payload.id, value: { confirm: false } });
        assert.equal(decision.res.status, 200, JSON.stringify(decision.body));
      } else if (event.kind === 'run.done') {
        completed = true;
      } else if (event.kind === 'run.error') {
        throw new Error(event.payload.message || 'run failed');
      }
    }
  }
  clearTimeout(timeout);
  await reader.cancel().catch(() => {});
  assert.equal(timedOut, false, 'run completed before SSE timeout');
  assert.equal(completed, true, 'run.done was broadcast');
  assert.equal(leaderHadOutput, true, 'leader candidates expose output under the UI field name');
  assert.equal(resultGateHadEvidence, true, 'result gate exposes bounded review and changed-file evidence');

  let final;
  for (let attempt = 0; attempt < 100; attempt++) {
    final = await getJson('/api/state', cookie);
    if (!final.body.running) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(final.body.running, false, 'running state clears after completion');
  assert.equal(final.body.runId, started.body.runId);
  return { started: started.body, state: final.body.state };
}

test('gate 24: invalid Host header is rejected (DNS-rebinding defense)', async () => {
  const status = await rawGet('/', 'evil.attacker.com');
  assert.equal(status, 421);
});

test('serves the app and sets an HttpOnly SameSite cookie (no token in HTML/URL)', async () => {
  const res = await fetch(base + '/');
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const html = await res.text();
  assert.doesNotMatch(html, /moh_cap=/, 'capability must not appear in HTML');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('environment auth modes require an operationally reachable harness', () => {
  const environment = { ANTHROPIC_API_KEY: testSecret };
  assert.equal(authModeAvailable('claude-code', 'missing', ['ANTHROPIC_API_KEY'], environment), false);
  assert.equal(authModeAvailable('claude-code', 'blocked', ['ANTHROPIC_API_KEY'], environment), false);
  assert.equal(authModeAvailable('claude-code', 'experimental', ['ANTHROPIC_API_KEY'], environment), false);
  assert.equal(authModeAvailable('claude-code', 'probe_failed', ['ANTHROPIC_API_KEY'], environment), false);
  assert.equal(authModeAvailable('claude-code', 'needs_login', ['ANTHROPIC_API_KEY'], environment), true);
});

test('bootstrap is capability-protected, redacted, and includes safe adapter setup evidence', async () => {
  const denied = await getJson('/api/bootstrap', '');
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.code, 'unauthorized');

  const cookie = await getCookie();
  const { res, body } = await getJson('/api/bootstrap', cookie);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.adapters));
  assert.equal(body.config.defaultPreset, 'quick-compare');
  assert.equal(body.config.seats.length, 2);
  assert.equal(body.config.seats[0].profile, null, 'account-shaped saved profile is omitted');
  assert.equal(body.config.seats[0].provider, 'local', 'saved provider assertions are replaced by adapter-safe truth');
  assert.equal(body.config.seats[0].modelPolicy, 'pinned');
  assert.equal(body.config.seats[0].requestedModelSource, 'user');
  assert.equal(body.config.seats[0].permissionMode, null, 'unsupported saved permission claims are discarded');
  assert.equal(body.config.seats[0].sandbox, 'unknown', 'unsupported saved sandbox claims are discarded');
  for (const field of ['configuredModel', 'modelClaim', 'modelCatalog', 'modelCatalogSource', 'modelCatalogCheckedAt']) {
    assert.equal(Object.hasOwn(body.config.seats[0], field), false, `saved ${field} is not treated as provenance`);
    assert.equal(Object.hasOwn(body.config.seats[1], field), false, `saved default ${field} is not treated as provenance`);
  }
  assert.equal(body.config.seats[1].profile, 'profile-routed');
  assert.equal(body.config.seats[1].provider, 'unknown', 'a profile-scoped Codex route is not assumed to be OpenAI');
  assert.equal(body.config.seats[1].requestedModelSource, 'default');

  const fake = body.adapters.find((adapter) => adapter.id === 'fake');
  assert.equal(fake.provider, 'local');
  assert.ok(Array.isArray(fake.auth.modes));
  assert.equal(fake.auth.modes[0].id, 'none');
  const claude = body.adapters.find((adapter) => adapter.id === 'claude-code');
  const claudeEnvMode = claude.auth.modes.find((mode) => mode.id === 'api_key_env');
  assert.ok(claudeEnvMode.envNames.includes('ANTHROPIC_API_KEY'));
  assert.equal(
    claudeEnvMode.available,
    ['ready', 'needs_login'].includes(claude.readiness),
    'an env value cannot make a missing/blocked/experimental/probe-failed harness available',
  );
  assert.equal(typeof claude.auth.loginCommand, 'string');

  const codex = body.adapters.find((adapter) => adapter.id === 'codex-cli');
  assert.equal(codex.provider, 'unknown');
  assert.equal(existsSync(codexRefreshMarker), true, 'web bootstrap attempts the current/account-aware catalog refresh');
  assert.match(codex.modelCatalog.source, /bundled/, 'an empty refresh retains the explicitly labelled bundled fallback');
  assert.equal(codex.modelCatalog.models[0].slug, 'bundled-frontier');

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, new RegExp(testSecret));
  assert.doesNotMatch(serialized, new RegExp(testAccount));
  assert.doesNotMatch(serialized, /accountId|apiKey|password/i);
});

test('gate 24: mutation without capability is denied', async () => {
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-moh-csrf': '1' } });
  assert.equal(res.status, 403);
});

test('gate 24: mutation with capability but hostile Origin is denied (CSRF defense)', async () => {
  const cookie = await getCookie();
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'http://evil.example', 'x-moh-csrf': '1' } });
  assert.equal(res.status, 403);
});

test('gate 24: mutation missing the custom CSRF header is denied', async () => {
  const cookie = await getCookie();
  const res = await fetch(base + '/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base } });
  assert.equal(res.status, 403);
});

test('real request validation returns actionable errors and rejects credential inputs', async () => {
  const cookie = await getCookie();
  const invalid = await postJson('/api/run', cookie, { mode: 'real', task: 'x', seed: { kind: 'greenfield' }, preset: 'quick-compare', seats: [] });
  assert.equal(invalid.res.status, 400);
  assert.equal(invalid.body.code, 'invalid_seats');
  assert.match(invalid.body.error, /exactly two seats/i);

  const secretRequest = realConfig();
  secretRequest.seats[0].apiKey = testSecret;
  const rejected = await postJson('/api/run', cookie, secretRequest);
  assert.equal(rejected.res.status, 400);
  assert.equal(rejected.body.code, 'credential_input_forbidden');
  assert.doesNotMatch(JSON.stringify(rejected.body), new RegExp(testSecret));

  const observedOnlyForgeries = [
    ['configuredModel', 'client-configured-model', 0],
    ['requestedModelSource', 'user', 0],
    ['modelClaim', 'Client says pinned means verified.', 0],
    ['modelCatalog', { models: [{ slug: 'fake-pinned', frontier: true }], source: 'client catalog', checkedAt: '2099-01-01' }, 0],
    ['catalogEvidence', { models: [{ slug: 'default-forged', frontier: true }] }, 1],
    ['modelCatalogSource', 'client catalog', 1],
    ['modelCatalogCheckedAt', '2099-01-01', 1],
  ];
  for (const [field, value, seatIndex] of observedOnlyForgeries) {
    const forged = realConfig();
    forged.seats[seatIndex][field] = value;
    const result = await postJson('/api/run', cookie, forged);
    assert.equal(result.res.status, 400, `${field} must be rejected`);
    assert.equal(result.body.code, 'server_observed_field');
    assert.match(result.body.error, new RegExp(field));
    assert.match(result.body.error, /server-observed provenance/i);
  }

  const arbitraryPolicy = realConfig();
  arbitraryPolicy.seats[0].modelPolicy = { mode: 'latest-ultra', verifiedAt: '2099-01-01' };
  const invalidPolicy = await postJson('/api/run', cookie, arbitraryPolicy);
  assert.equal(invalidPolicy.res.status, 400);
  assert.equal(invalidPolicy.body.code, 'invalid_model_policy');
  assert.match(invalidPolicy.body.error, /harness_default, catalog_frontier, pinned/);

  const forgedPermission = realConfig();
  forgedPermission.seats[0].permissionMode = 'auto';
  const unsupportedPermission = await postJson('/api/run', cookie, forgedPermission);
  assert.equal(unsupportedPermission.res.status, 400);
  assert.equal(unsupportedPermission.body.code, 'permission_mode_unsupported');
  assert.match(unsupportedPermission.body.error, /supported only by the Claude Code adapter/i);

  const forgedSandbox = realConfig();
  forgedSandbox.seats[0].sandbox = 'workspace-write';
  const unsupportedSandbox = await postJson('/api/run', cookie, forgedSandbox);
  assert.equal(unsupportedSandbox.res.status, 400);
  assert.equal(unsupportedSandbox.body.code, 'sandbox_control_unsupported');
  assert.match(unsupportedSandbox.body.error, /did not report sandbox_controls as supported/i);

  const profileFrontier = realConfig();
  profileFrontier.seats[0] = {
    seatId: 'seat-a',
    label: 'Profiled Codex',
    adapterId: 'codex-cli',
    authMode: 'delegated',
    profile: 'work',
    requestedModel: 'bundled-frontier',
    modelPolicy: 'catalog_frontier',
    sandbox: 'workspace-write',
  };
  const unsupportedProfileCatalog = await postJson('/api/run', cookie, profileFrontier);
  assert.equal(unsupportedProfileCatalog.res.status, 412);
  assert.equal(unsupportedProfileCatalog.body.code, 'profile_catalog_unsupported');
  assert.match(unsupportedProfileCatalog.body.error, /does not support profile-scoped model catalog/i);

  const unverifiedFrontier = realConfig();
  Object.assign(unverifiedFrontier.seats[0], {
    requestedModel: 'fake-frontier',
    modelPolicy: 'catalog_frontier',
  });
  const unverified = await postJson('/api/run', cookie, unverifiedFrontier);
  assert.equal(unverified.res.status, 412);
  assert.equal(unverified.body.code, 'model_catalog_unavailable');
  assert.match(unverified.body.error, /verifiable current model catalog/i);
});

test('validated real config drives Application, preserves safe model evidence, saves defaults, and clears running state', async () => {
  const cookie = await getCookie();
  const run = await driveRun(cookie, realConfig());
  assert.equal(run.started.mode, 'real');
  assert.equal(run.started.configSaved, true);
  assert.equal(run.state.status, 'declined');
  assert.equal(run.state.seats[0].provider, 'local', 'provider is derived from adapter-safe evidence');
  assert.equal(run.state.seats[0].requestedModelSource, 'user');
  assert.equal(run.state.seats[0].configuredModel, null);
  assert.equal(run.state.seats[0].modelPolicy, 'pinned');
  assert.equal(run.state.seats[0].modelClaim, null);
  assert.equal(run.state.seats[0].modelCatalog, null);
  assert.equal(run.state.seats[1].requestedModelSource, 'default');
  assert.equal(run.state.seats[1].modelClaim, null);
  assert.equal(run.state.seats[1].modelCatalog, null);
  assert.deepEqual(run.state.seats[0].authEnvNames, []);

  const savedOnDisk = JSON.parse(readFileSync(join(process.env.MOH_CONFIG_DIR, 'config.json'), 'utf8'));
  for (const seat of savedOnDisk.seats) {
    for (const field of ['configuredModel', 'modelClaim', 'modelCatalog', 'modelCatalogSource', 'modelCatalogCheckedAt']) {
      assert.equal(Object.hasOwn(seat, field), false, `non-frontier saved defaults omit ${field}`);
    }
  }

  const bootstrap = await getJson('/api/bootstrap', cookie);
  assert.equal(bootstrap.body.config.seats[0].provider, 'local');
  assert.equal(bootstrap.body.config.seats[0].modelPolicy, 'pinned');
  assert.doesNotMatch(JSON.stringify(bootstrap.body.config), /adapterConfig|secret|token/i);
});

test('explicit demo mode starts deterministic fake seats and overlapping runs return conflict', async () => {
  const cookie = await getCookie();
  const demo = await postJson('/api/run', cookie, { mode: 'demo' });
  assert.equal(demo.res.status, 200, JSON.stringify(demo.body));
  assert.equal(demo.body.mode, 'demo');
  assert.equal(typeof demo.body.runId, 'string');

  const current = await getJson('/api/state', cookie);
  assert.equal(current.body.running, true);
  assert.equal(current.body.runId, demo.body.runId);
  assert.deepEqual(current.body.state.seats.map((seat) => seat.adapterId), ['fake', 'fake']);

  let gateState = current;
  for (let attempt = 0; attempt < 100 && !gateState.body.pendingDecision; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    gateState = await getJson('/api/state', cookie);
  }
  assert.equal(gateState.body.pendingDecision.kind, 'gate.leader', 'current state exposes the recoverable active gate');

  const reconnected = await fetch(base + '/events', { headers: { cookie } });
  const reader = reconnected.body.getReader();
  const decoder = new TextDecoder();
  let frame = '';
  const timeout = setTimeout(() => void reader.cancel(), 3_000);
  while (!frame.includes('data: ')) {
    const { value, done } = await reader.read();
    if (done) break;
    frame += decoder.decode(value, { stream: true });
  }
  clearTimeout(timeout);
  await reader.cancel().catch(() => {});
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'SSE reconnect replays the pending gate');
  const replayed = JSON.parse(dataLine.slice(6));
  assert.equal(replayed.kind, 'gate.leader');
  assert.equal(replayed.payload.id, gateState.body.pendingDecision.payload.id);

  const conflict = await postJson('/api/run', cookie, { mode: 'demo' });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.code, 'run_in_progress');
  assert.match(conflict.body.error, /already in progress/i);
});
