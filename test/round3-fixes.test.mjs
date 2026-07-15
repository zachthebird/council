import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Application, autoDecider } from '../src/core/app.mjs';
import { RunStore } from '../src/storage/store.mjs';
import { Preset } from '../src/core/state.mjs';
import { Verdict } from '../src/core/review.mjs';
import { sanitizeGitUrl } from '../src/security/redact.mjs';
import { registerExternalAdapter, getAdapter } from '../src/adapters/registry.mjs';
import { tempStore, demoSeats } from './helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, 'bin', 'moh.mjs');
const manifest = join(root, 'examples', 'example-adapter', 'moh-adapter.json');

function config(over = {}) {
  return { preset: Preset.FULL_MIXTURE, task: 'implement greet', seed: { kind: 'greenfield' }, seats: demoSeats(), ...over };
}

test('FENCING: per-run sequence numbers are monotonic and gapless (not instance-global)', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const a = await app.createRun(config());
  await app.run(a.runId);
  const b = await app.createRun(config());
  await app.run(b.runId);
  for (const id of [a.runId, b.runId]) {
    const { events, gaps, duplicates } = new RunStore().replay(id);
    assert.equal(events[0].seq, 1, `${id} starts at seq 1 (per-run)`);
    assert.deepEqual(gaps, [], `${id} no gaps`);
    assert.deepEqual(duplicates, [], `${id} no duplicates`);
  }
});

test('FENCING: events are dropped after run.finished', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config());
  await app.run(runId);
  const before = new RunStore().readEvents(runId).length;
  // A late straggler callback must be dropped.
  const dropped = app._emit(runId, { kind: 'notice', payload: { level: 'info', message: 'late' } });
  assert.equal(dropped, null, 'post-finish emit returns null (dropped)');
  const after = new RunStore().readEvents(runId).length;
  assert.equal(after, before, 'no event persisted after finish');
});

test('REQUIRED TURN: both critiques failing blocks clean approval', async () => {
  tempStore();
  const seats = demoSeats();
  seats[0].adapterConfig.forceFail = true;
  seats[0].adapterConfig.forceFailRole = 'critique';
  seats[1].adapterConfig.forceFail = true;
  seats[1].adapterConfig.forceFailRole = 'critique';
  const app = new Application({ decider: { async chooseLeader(c) { return c[0].seatId; }, async confirmResult() { return { confirm: true, override: true }; } } });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  assert.notEqual(outcome.verdict, Verdict.APPROVE);
});

test('REQUIRED TURN: failed revision blocks clean approval', async () => {
  tempStore();
  const seats = demoSeats();
  seats[0].adapterConfig.reviewVerdict = 'revise'; // force a revise verdict
  seats[0].adapterConfig.forceFail = true;
  seats[0].adapterConfig.forceFailRole = 'revise';
  const app = new Application({ decider: { async chooseLeader(c) { return c[0].seatId; }, async confirmResult() { return { confirm: true, override: true }; } } });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  assert.notEqual(outcome.verdict, Verdict.APPROVE);
});

test('URL: token-bearing query parameter is rejected/stripped', () => {
  assert.throws(() => sanitizeGitUrl('https://example.com/r.git?token=SECRET', { reject: true }), /credential-bearing query/);
  assert.equal(sanitizeGitUrl('https://example.com/r.git?token=SECRET&ref=main'), 'https://example.com/r.git?ref=main');
  assert.throws(() => sanitizeGitUrl('https://example.com/r.git?access_token=abc', { reject: true }), /credential/);
});

test('EXTERNAL: adapter requires opt-in and registers + runs through registry', async () => {
  tempStore();
  delete process.env.MOH_ALLOW_EXTERNAL_ADAPTERS;
  assert.throws(() => registerExternalAdapter(manifest), /explicitly|disabled/);
  const a = registerExternalAdapter(manifest, { trust: true });
  assert.equal(a.id, 'example-external');
  assert.ok(getAdapter('example-external'), 'registered in the shared registry');

  // Drive a full run using the external adapter for seat A.
  const app = new Application({ decider: autoDecider() });
  const seats = [
    { seatId: 'seat-a', label: 'Ext', adapterId: 'example-external' },
    { seatId: 'seat-b', label: 'Fake', adapterId: 'fake', adapterConfig: { reportedModel: null, sessionPrefix: 'b' } },
  ];
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  assert.ok(['finished', 'not_created', 'declined', 'blocked'].includes(outcome.status));
});

test('EXTERNAL: `moh adapters add` registers via CLI', () => {
  const dir = tempStore();
  const outText = execFileSync(process.execPath, [bin, 'adapters', 'add', manifest, '--trust'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', MOH_CONFIG_DIR: process.env.MOH_CONFIG_DIR } });
  assert.match(outText, /registered external adapter 'example-external'/);
  // Now it appears in `moh adapters` (loaded from config on startup).
  const listed = execFileSync(process.execPath, [bin, 'adapters'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', MOH_ALLOW_EXTERNAL_ADAPTERS: '1', MOH_CONFIG_DIR: process.env.MOH_CONFIG_DIR } });
  assert.match(listed, /example-external/);
});
