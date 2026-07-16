import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProvenance, observeModel, identityLine, effectiveModelLine, modelsCompatible, ProvenanceState, NOT_REPORTED_LINE } from '../src/core/provenance.mjs';
import { Application } from '../src/core/app.mjs';
import { RunStore } from '../src/storage/store.mjs';
import { getAdapter } from '../src/adapters/registry.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function base() {
  return newProvenance({ seatId: 'seat-a', seatLabel: 'Seat A', adapterId: 'fake', harnessId: 'fake', requestedModel: 'alpha' });
}

test('gate 13: no runtime evidence => Not reported by harness', () => {
  const p = newProvenance({ seatId: 's', seatLabel: 'S', adapterId: 'fake', harnessId: 'fake', requestedModel: null });
  assert.equal(p.state, ProvenanceState.NOT_REPORTED);
  assert.equal(effectiveModelLine(p), NOT_REPORTED_LINE);
});

test('gate 12: requested and reported stored separately', () => {
  const { prov } = observeModel(base(), { reportedModel: 'alpha-1', evidenceSource: 'stream.init' });
  assert.equal(prov.requestedModel, 'alpha');
  assert.equal(prov.reportedModel, 'alpha-1');
  assert.equal(prov.state, ProvenanceState.RUNTIME_REPORTED);
});

test('gate 14: mismatch flagged when reported is incompatible with requested', () => {
  const { prov, mismatch } = observeModel(base(), { reportedModel: 'beta-9', evidenceSource: 'stream.init' });
  assert.equal(mismatch, true);
  assert.equal(prov.state, ProvenanceState.MISMATCH_OR_FALLBACK);
});

test('versioned model slugs require exact matches while clear aliases use token matching', () => {
  assert.equal(modelsCompatible('gpt-5.6', 'gpt-5.6'), true);
  assert.equal(modelsCompatible('gpt-5.6', 'gpt-5.6-mini'), false);
  assert.equal(modelsCompatible('sonnet', 'claude-sonnet-4-5-2026'), true);
  assert.equal(modelsCompatible('son', 'claude-sonnet-4-5-2026'), false);
});

test('runtime model evidence is scrubbed before it enters provenance', () => {
  const secret = ['sk-ant', 'abcdefghijklmnopqrstuvwx'].join('-');
  const account = 'private@example.com';
  const accountId = 'acct-private';
  const { prov } = observeModel(base(), {
    reportedModel: `alpha-1 ${account} ${accountId} ${secret}`,
    evidenceSource: `stream.init account_id=${accountId} email=${account}`,
    reportedEffort: `high email=${account}`,
    usage: { input_tokens: 2, account_id: accountId, nested: { email: account, note: secret } },
  });
  const serialized = JSON.stringify(prov);
  assert.doesNotMatch(serialized, /private@example\.com|acct-private|abcdefghijklmnopqrstuvwx/);
  assert.match(prov.reportedModel, /alpha-1/);
  assert.equal(prov.usage.account_id, '[account omitted]');
  assert.equal(prov.usage.nested.email, '[account omitted]');
});

test('all persisted events centrally scrub account identifiers, including stderr-like notices', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-event-scrub-'));
  const store = new RunStore(join(dir, 'runs'));
  const app = new Application({ store, deterministic: true, workspacesRoot: join(dir, 'workspaces') });
  const { runId } = await app.createRun({
    task: 'event scrub test',
    seed: { kind: 'greenfield' },
    seats: [
      { seatId: 'seat-a', label: 'A', adapterId: 'fake' },
      { seatId: 'seat-b', label: 'B', adapterId: 'fake' },
    ],
  });
  app._emit(runId, {
    kind: 'notice',
    payload: { level: 'debug', message: 'email=owner@example.com account_id=acct-runtime-private', account_id: 'acct-runtime-private' },
  });
  const persisted = JSON.stringify(store.readEvents(runId));
  assert.doesNotMatch(persisted, /owner@example\.com|acct-runtime-private/);
  assert.match(persisted, /account omitted/);
  rmSync(dir, { recursive: true, force: true });
});

test('repeated identical model observations retain mismatch state but dedupe warnings', () => {
  const first = observeModel(base(), { reportedModel: 'beta-9', evidenceSource: 'stream.init' });
  const second = observeModel(first.prov, { reportedModel: 'beta-9', evidenceSource: 'stream.result.modelUsage' });
  assert.equal(first.mismatch, true);
  assert.equal(second.mismatch, false);
  assert.equal(second.prov.state, ProvenanceState.MISMATCH_OR_FALLBACK);
  assert.equal(second.prov.reportedModel, 'beta-9');
});

test('gate 14: mid-turn fallback records history', () => {
  let p = base();
  ({ prov: p } = observeModel(p, { reportedModel: 'alpha-1', evidenceSource: 'a' }));
  const { prov, mismatch } = observeModel(p, { reportedModel: 'alpha-2', evidenceSource: 'b' });
  assert.equal(mismatch, true);
  assert.equal(prov.history.length, 1);
  assert.deepEqual(prov.history[0], { from: 'alpha-1', to: 'alpha-2', evidenceSource: 'b' });
});

test('identity line never invents a reported model', () => {
  const line = identityLine(base());
  assert.match(line, /requested: alpha/);
  assert.match(line, /reported: not reported by harness/);
});

test('configured and catalog metadata remain distinct from requested and reported evidence', () => {
  const p = newProvenance({
    seatId: 's',
    seatLabel: 'S',
    adapterId: 'codex-cli',
    harnessId: 'codex-cli',
    provider: 'openai',
    profile: 'work',
    requestedModel: null,
    requestedModelSource: 'catalog_default',
    configuredModel: 'gpt-configured',
    modelPolicy: 'latest-frontier',
    modelCatalog: { source: 'codex debug models', checkedAt: '2026-07-14T00:00:00.000Z' },
    modelCatalogSource: 'codex debug models (refreshed)',
    modelCatalogCheckedAt: '2026-07-14T00:00:00.000Z',
    modelClaim: 'latest-frontier',
    authMode: 'native',
    authEnvNames: [],
  });
  assert.equal(p.state, ProvenanceState.CONFIGURED_ONLY);
  assert.equal(p.configuredModel, 'gpt-configured');
  assert.equal(p.requestedModel, null);
  assert.equal(p.profile, 'work');
  assert.equal(p.modelPolicy, 'latest-frontier');
  assert.equal(p.modelCatalog.source, 'codex debug models');
  assert.equal(p.modelCatalogSource, 'codex debug models (refreshed)');
  assert.equal(p.modelClaim, 'latest-frontier');
  assert.equal(p.authMode, 'native');
});

test('Application persists and passes seat model, profile, catalog, and auth metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-prov-app-'));
  const store = new RunStore(join(dir, 'runs'));
  const app = new Application({ store, deterministic: true, workspacesRoot: join(dir, 'workspaces') });
  const modelCatalog = { source: 'codex debug models', checkedAt: '2026-07-14T00:00:00.000Z' };
  const { runId, state } = await app.createRun({
    task: 'metadata test',
    seed: { kind: 'greenfield' },
    seats: [
      {
        seatId: 'seat-a',
        label: 'A',
        adapterId: 'fake',
        provider: 'openai',
        profile: 'work',
        requestedModel: 'gpt-requested',
        requestedModelSource: 'user',
        configuredModel: 'gpt-configured',
        modelPolicy: 'pinned',
        modelCatalog,
        modelCatalogSource: 'codex debug models (refreshed)',
        modelCatalogCheckedAt: '2026-07-14T00:00:00.000Z',
        modelClaim: 'pinned',
        authMode: 'oauth-token-env',
        authEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
      },
      { seatId: 'seat-b', label: 'B', adapterId: 'fake' },
    ],
  });
  const persisted = store.loadState(runId).seats[0];
  assert.equal(persisted.provider, 'openai');
  assert.equal(persisted.profile, 'work');
  assert.equal(persisted.configuredModel, 'gpt-configured');
  assert.equal(persisted.requestedModelSource, 'user');
  assert.deepEqual(persisted.modelCatalog, modelCatalog);
  assert.equal(persisted.modelCatalogSource, 'codex debug models (refreshed)');
  assert.equal(persisted.modelCatalogCheckedAt, '2026-07-14T00:00:00.000Z');
  assert.equal(persisted.modelClaim, 'pinned');
  assert.equal(persisted.authMode, 'oauth-token-env');
  assert.deepEqual(persisted.authEnvNames, ['CLAUDE_CODE_OAUTH_TOKEN']);

  const adapter = getAdapter('fake');
  const original = adapter.runTurn;
  let captured;
  adapter.runTurn = async (ctx) => {
    captured = ctx;
    return { status: 'ok', finalText: 'done', sessionId: 'session' };
  };
  try {
    await app._seatTurn(state, state.seats[0], 'generate', { prompt: 'test', workspaceDir: dir });
    for (const key of ['provider', 'profile', 'configuredModel', 'requestedModelSource', 'modelPolicy', 'modelCatalog', 'modelCatalogSource', 'modelCatalogCheckedAt', 'modelClaim', 'authMode', 'authEnvNames']) {
      assert.deepEqual(captured[key], state.seats[0][key], `${key} forwarded`);
    }
    const prov = state.provenanceBySeat['seat-a'];
    assert.equal(prov.configuredModel, 'gpt-configured');
    assert.equal(prov.requestedModel, 'gpt-requested');
    assert.equal(prov.authMode, 'oauth-token-env');
  } finally {
    adapter.runTurn = original;
    store.release(runId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Application emits and persists only scrubbed runtime model provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-prov-scrub-'));
  const store = new RunStore(join(dir, 'runs'));
  const app = new Application({ store, deterministic: true, workspacesRoot: join(dir, 'workspaces') });
  const { runId, state } = await app.createRun({
    task: 'runtime provenance scrub test',
    seed: { kind: 'greenfield' },
    seats: [
      { seatId: 'seat-a', label: 'A', adapterId: 'fake', requestedModel: 'alpha' },
      { seatId: 'seat-b', label: 'B', adapterId: 'fake' },
    ],
  });
  const adapter = getAdapter('fake');
  const original = adapter.runTurn;
  const account = 'owner@example.com';
  const accountId = 'acct-runtime-private';
  const secret = ['sk-ant', 'zyxwvutsrqponmlkjihgfedc'].join('-');
  const rawModel = `alpha-1 ${account} ${accountId} ${secret}`;
  adapter.runTurn = async (_ctx, hooks) => {
    hooks.onEvent({
      kind: 'model',
      payload: {
        reportedModel: rawModel,
        evidenceSource: `stream.init account_id=${accountId}`,
        usage: { output_tokens: 1, account_id: accountId, email: account },
      },
    });
    return { status: 'ok', finalText: 'done', sessionId: null, reportedModel: rawModel };
  };
  try {
    await app._seatTurn(state, state.seats[0], 'generate', { prompt: 'test', workspaceDir: dir });
    store.saveState(runId, state);
    const persisted = JSON.stringify({ state: store.loadState(runId), events: store.readEvents(runId) });
    assert.doesNotMatch(persisted, /owner@example\.com|acct-runtime-private|zyxwvutsrqponmlkjihgfedc/);
    assert.match(state.provenanceBySeat['seat-a'].reportedModel, /alpha-1/);
    assert.equal(state.provenanceBySeat['seat-a'].usage.account_id, '[account omitted]');
  } finally {
    adapter.runTurn = original;
    store.release(runId);
    rmSync(dir, { recursive: true, force: true });
  }
});
