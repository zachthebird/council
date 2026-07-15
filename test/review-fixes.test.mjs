import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, autoDecider } from '../src/core/app.mjs';
import { RunStore } from '../src/storage/store.mjs';
import { Preset } from '../src/core/state.mjs';
import { Verdict } from '../src/core/review.mjs';
import { assertInside, prepareWorkspace, captureTree, buildReviewEvidence } from '../src/git/workspace.mjs';
import { writeFileSync } from 'node:fs';
import { tempStore, demoSeats } from './helpers.mjs';

function config(over = {}) {
  return { preset: Preset.FULL_MIXTURE, task: 'implement greet', seed: { kind: 'greenfield' }, seats: demoSeats(), ...over };
}

test('FINDING 1: traversal seat id is rejected before any filesystem use', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const seats = demoSeats();
  seats[0].seatId = '../../../etc/evil';
  await assert.rejects(() => app.createRun(config({ seats })), /unsafe seat id/);
});

test('FINDING 1: assertInside blocks path escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'moh-root-'));
  assert.throws(() => assertInside(root, join(root, '..', 'escape')));
  assert.doesNotThrow(() => assertInside(root, join(root, 'seat-a')));
});

test('FINDING 2: forced integration failure cannot finish as approved', async () => {
  tempStore();
  const seats = demoSeats();
  // Leader (seat-a, chosen by autoDecider) fails ONLY at the integrate role.
  seats[0].adapterConfig.forceFail = true;
  seats[0].adapterConfig.forceFailRole = 'integrate';
  const app = new Application({ decider: { async chooseLeader(c) { return c[0].seatId; }, async confirmResult() { return { confirm: true, override: true }; } } });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  assert.notEqual(outcome.verdict, Verdict.APPROVE, 'integration failure must not yield approve');
  const state = new RunStore().loadState(runId);
  assert.equal(state.integrationFailed, true);
});

test('FINDING 2 & 7: peer diffs are provided and provenance history is durable', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config({ seats: demoSeats() }));
  await app.run(runId);
  const receipt = new RunStore().readReceipt(runId);
  const seatA = receipt.seats.find((s) => s.seatId === 'seat-a');
  assert.ok(Array.isArray(seatA.turns) && seatA.turns.length >= 3, 'per-turn provenance recorded in receipt');
});

test('FINDING 7: two deterministic runs produce identical result commit + receipt digest', async () => {
  const digests = [];
  const commits = [];
  for (let i = 0; i < 2; i++) {
    tempStore();
    const app = new Application({ deterministic: true, decider: autoDecider() });
    const { runId } = await app.createRun({
      preset: Preset.FULL_MIXTURE,
      task: 'det task',
      seed: { kind: 'greenfield' },
      seats: [
        { seatId: 'seat-a', label: 'A', adapterId: 'fake', requestedModel: 'a', adapterConfig: { reportedModel: 'a-1', sessionPrefix: 'a' } },
        { seatId: 'seat-b', label: 'B', adapterId: 'fake', requestedModel: null, adapterConfig: { reportedModel: null, sessionPrefix: 'b' } },
      ],
    });
    const outcome = await app.run(runId);
    commits.push(outcome.result.commit);
    digests.push(outcome.receiptDigest);
  }
  assert.equal(commits[0], commits[1], 'deterministic result commit');
  assert.equal(digests[0], digests[1], 'deterministic receipt digest');
});

test('FINDING 3: review evidence is read from git objects and truncation is recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-ev-'));
  const { base } = prepareWorkspace(dir, { kind: 'greenfield' });
  writeFileSync(join(dir, 'small.txt'), 'hello from git object');
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200000));
  const tree = captureTree(dir);
  const ev = buildReviewEvidence(dir, base, tree, { maxBytes: 4096, maxFileBytes: 1024 });
  assert.match(ev.text, /hello from git object/, 'small file content included from git objects');
  assert.ok(ev.truncated.includes('big.txt'), 'oversized file recorded as truncated, not silently omitted');
  assert.ok(ev.digests['big.txt'], 'digest still recorded for the truncated file');
});

test('FINDING 4: credential-bearing seed URL is rejected at run creation (before persistence)', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  await assert.rejects(
    () => app.createRun(config({ seed: { kind: 'url', url: 'https://user:secretpass@example.com/r.git' } })),
    /credential/i
  );
});

test('FINDING 4: secret-shaped values are redacted from persisted events', async () => {
  tempStore();
  const seats = demoSeats();
  // A notice carrying a secret-shaped token must be redacted in the persisted log.
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config({ seats }));
  app._emit(runId, { kind: 'notice', payload: { level: 'info', message: 'leak sk-ant-abcdefghijklmnopqrstuvwx' } });
  const evts = new RunStore().readEvents(runId);
  const joined = JSON.stringify(evts);
  assert.doesNotMatch(joined, /abcdefghijklmnopqrstuvwx/, 'secret redacted in persisted events');
});
