import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Application, autoDecider } from '../src/core/app.mjs';
import { RunStore } from '../src/storage/store.mjs';
import { Preset } from '../src/core/state.mjs';
import { Verdict } from '../src/core/review.mjs';
import { verifyReceipt } from '../src/core/receipt.mjs';
import { tempStore, demoSeats } from './helpers.mjs';

function config(over = {}) {
  return { preset: Preset.FULL_MIXTURE, task: 'implement greet', seed: { kind: 'greenfield' }, seats: demoSeats(), ...over };
}

test('gate 27: full fake workflow -> result branch with reviewed tree + verified receipt', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const seen = [];
  app.subscribe((e) => seen.push(e.kind));
  const { runId } = await app.createRun(config());
  const outcome = await app.run(runId);
  assert.equal(outcome.status, 'finished');
  assert.equal(outcome.verdict, Verdict.APPROVE);

  const store = new RunStore();
  const state = store.loadState(runId);
  const receipt = store.readReceipt(runId);
  assert.ok(verifyReceipt(receipt), 'receipt self-digest verifies');

  // gate 23: created commit contains the reviewed tree.
  const dir = state.result.dir;
  const branchTree = execFileSync('git', ['rev-parse', `${state.result.branch}^{tree}`], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(branchTree, receipt.git.reviewedTreeOid);

  // events cover the full workflow
  for (const k of ['run.started', 'stage.entered', 'critique.ready', 'leader.selected', 'integration.ready', 'review.ready', 'result.branch.created', 'run.finished']) {
    assert.ok(seen.includes(k), `missing event ${k}`);
  }
});

test('gate 6/replay: persisted events replay in order with monotonic seq (no gaps)', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config());
  await app.run(runId);
  const evts = new RunStore().readEvents(runId);
  assert.ok(evts.length > 5);
  for (let i = 0; i < evts.length; i++) assert.equal(evts[i].seq, i + 1, 'monotonic, gapless seq');
});

test('gate 20: one-seat failure yields a sole-survivor, unmistakably NOT approved', async () => {
  tempStore();
  const seats = demoSeats({ failA: true });
  const app = new Application({ decider: { async chooseLeader(c) { return c[0].seatId; }, async confirmResult() { return { confirm: true, override: true }; } } });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  const state = new RunStore().loadState(runId);
  assert.equal(state.decisions.soleSurvivor, true);
  // Sole survivor result is recorded as UNREVIEWED, never "approve".
  assert.notEqual(outcome.verdict, Verdict.APPROVE);
});

test('gate 22: changing the candidate tree after review blocks branch creation', async () => {
  tempStore();
  const tamper = {
    async chooseLeader(c) { return c[0].seatId; },
    async confirmResult({ leaderDir }) {
      // Mutate the reviewed workspace AFTER review, before confirming.
      writeFileSync(join(leaderDir, 'INJECTED_AFTER_REVIEW.txt'), 'tampered');
      return { confirm: true, override: true };
    },
  };
  const app = new Application({ decider: tamper });
  const { runId } = await app.createRun(config());
  const outcome = await app.run(runId);
  assert.equal(outcome.status, 'blocked');
  assert.match(outcome.reason, /candidate tree changed after review/);
  assert.equal(new RunStore().loadState(runId).result, null, 'no result branch created');
});

test('gate 21 (e2e): a seat that emits no valid review record cannot be approved', async () => {
  tempStore();
  const seats = demoSeats();
  // Make seat-a (leader) emit an INVALID review verdict token -> not parseable to approve.
  seats[0].adapterConfig.reviewVerdict = 'totally-bogus';
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  // autoDecider confirms but does not override -> not created because verdict != approve.
  assert.notEqual(outcome.status, 'finished');
  const state = new RunStore().loadState(runId);
  assert.notEqual(state.review?.verdict, Verdict.APPROVE);
});

test('gate 8: two instances of the same harness occupy separate seats', async () => {
  tempStore();
  const seats = [
    { seatId: 'seat-a', label: 'Fake #1', adapterId: 'fake', requestedModel: 'x', adapterConfig: { reportedModel: 'x-1', sessionPrefix: 'p1' } },
    { seatId: 'seat-b', label: 'Fake #2', adapterId: 'fake', requestedModel: 'y', adapterConfig: { reportedModel: 'y-1', sessionPrefix: 'p2' } },
  ];
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  assert.equal(outcome.status, 'finished');
  const state = new RunStore().loadState(runId);
  assert.notEqual(state.provenanceBySeat['seat-a'].sessionId, state.provenanceBySeat['seat-b'].sessionId);
});

test('gate 7: quick-compare preset runs without assuming Claude/Codex seat ids', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config({ preset: Preset.QUICK_COMPARE }));
  const outcome = await app.run(runId);
  assert.ok(['finished', 'not_created', 'declined', 'blocked'].includes(outcome.status));
});
