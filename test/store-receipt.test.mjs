import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '../src/storage/store.mjs';
import { buildReceipt, verifyReceipt } from '../src/core/receipt.mjs';
import { runsDir } from '../src/storage/paths.mjs';
import { tempStore } from './helpers.mjs';

test('store: atomic snapshot + append-only events + replay', () => {
  tempStore();
  const store = new RunStore();
  store.create('run-x', { preset: 'full-mixture', stage: 'created' });
  store.appendEvent('run-x', { seq: 1, kind: 'a' });
  store.appendEvent('run-x', { seq: 2, kind: 'b' });
  const evts = store.readEvents('run-x');
  assert.deepEqual(evts.map((e) => e.seq), [1, 2]);
  const s = store.loadState('run-x');
  assert.equal(s.preset, 'full-mixture');
});

test('store: unsafe run id rejected (path traversal)', () => {
  const store = new RunStore();
  assert.throws(() => store.runPath('../escape'));
  assert.throws(() => store.runPath('.hidden'));
});

test('store: torn last event line is skipped, not fatal', () => {
  tempStore();
  const store = new RunStore();
  store.create('run-y', { stage: 'created' });
  store.appendEvent('run-y', { seq: 1, kind: 'ok' });
  // Simulate a crash mid-append: a partial JSON line at EOF.
  appendFileSync(join(runsDir(), 'run-y', 'events.jsonl'), '{"seq":2,"kind":"tor');
  const evts = store.readEvents('run-y');
  assert.deepEqual(evts.map((e) => e.seq), [1], 'torn line skipped, good events preserved');
});

test('receipt: deterministic self-digest verifies and detects tampering', () => {
  const base = {
    runId: 'r', preset: 'full-mixture', baseCommit: 'aaa', reviewedTreeOid: 'bbb', resultCommit: 'ccc', resultBranch: 'moh/r',
    changedManifest: [{ status: 'A', path: 'x' }], artifactDigests: { x: 'sha256:1' }, promptWorkflowDescriptor: 'desc',
    seats: [], review: { verdict: 'approve' }, reviewIntegrity: 'attested', decisions: {},
  };
  const r1 = buildReceipt(base);
  const r2 = buildReceipt(base);
  assert.equal(r1.receiptDigest, r2.receiptDigest, 'deterministic');
  assert.ok(verifyReceipt(r1));
  r1.review.verdict = 'reject';
  assert.equal(verifyReceipt(r1), false, 'tampering detected');
});
