import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, autoDecider } from '../src/core/app.mjs';
import { RunStore } from '../src/storage/store.mjs';
import { Preset } from '../src/core/state.mjs';
import { Verdict } from '../src/core/review.mjs';
import { captureTree, readBlob, listTree, buildReviewEvidence, prepareWorkspace, createResultBranch } from '../src/git/workspace.mjs';
import { redactDeep } from '../src/security/redact.mjs';
import { registerExternalAdapter } from '../src/adapters/registry.mjs';
import { tempStore, demoSeats } from './helpers.mjs';

const config = (over = {}) => ({ preset: Preset.FULL_MIXTURE, task: 't', seed: { kind: 'greenfield' }, seats: demoSeats(), ...over });

test('CAPTURE: intermediate directory symlink cannot exfiltrate external data', () => {
  const secretDir = mkdtempSync(join(tmpdir(), 'moh-secret-'));
  writeFileSync(join(secretDir, 'private.txt'), 'TOP SECRET OUTSIDE DATA');
  const dir = mkdtempSync(join(tmpdir(), 'moh-cap-'));
  const { base } = prepareWorkspace(dir, { kind: 'greenfield' });
  // Track a real directory with a file, commit it.
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'ok.txt'), 'benign');
  const t1 = captureTree(dir);
  createResultBranch(dir, { runId: 'sl1', treeOid: t1, baseOid: base, message: 'add sub' });
  // Replace the tracked dir with a symlink to the external secret dir.
  rmSync(join(dir, 'sub'), { recursive: true, force: true });
  symlinkSync(secretDir, join(dir, 'sub'));
  const t2 = captureTree(dir);
  // The candidate tree must NOT contain the external secret content.
  const entries = listTree(dir, t2).map((e) => e.path);
  const leaked = entries.some((p) => {
    try {
      return readBlob(dir, t2, p).toString('utf8').includes('TOP SECRET OUTSIDE DATA');
    } catch {
      return false;
    }
  });
  assert.equal(leaked, false, 'no external data captured through intermediate symlink');
  rmSync(secretDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('CAPTURE: a FIFO does not hang capture (special files skipped)', { timeout: 15000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-fifo-'));
  prepareWorkspace(dir, { kind: 'greenfield' });
  writeFileSync(join(dir, 'real.txt'), 'ok');
  try {
    execFileSync('mkfifo', [join(dir, 'pipe')]);
  } catch {
    return; // mkfifo unavailable — skip
  }
  const tree = captureTree(dir); // must return, not hang
  const paths = listTree(dir, tree).map((e) => e.path);
  assert.ok(paths.includes('real.txt'));
  assert.ok(!paths.includes('pipe'), 'FIFO excluded from the candidate tree');
  rmSync(dir, { recursive: true, force: true });
});

test('EVIDENCE: binary change is NOT attested (marked truncated)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-bin-'));
  const { base } = prepareWorkspace(dir, { kind: 'greenfield' });
  writeFileSync(join(dir, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
  writeFileSync(join(dir, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x42])); // invalid UTF-8
  const tree = captureTree(dir);
  const ev = buildReviewEvidence(dir, base, tree);
  assert.ok(ev.truncated.includes('data.bin'), 'binary counts as truncated -> unattested');
  assert.ok(ev.truncated.includes('bad.txt'), 'invalid UTF-8 counts as truncated -> unattested');
  rmSync(dir, { recursive: true, force: true });
});

test('CRITIQUE: a SINGLE failed critique blocks clean approval + records a limitation', async () => {
  tempStore();
  const seats = demoSeats();
  seats[1].adapterConfig.forceFail = true;
  seats[1].adapterConfig.forceFailRole = 'critique'; // only ONE critique fails
  const app = new Application({ decider: { async chooseLeader(c) { return c[0].seatId; }, async confirmResult() { return { confirm: true, override: true }; } } });
  const { runId } = await app.createRun(config({ seats }));
  const outcome = await app.run(runId);
  assert.notEqual(outcome.verdict, Verdict.APPROVE);
  const receipt = new RunStore().readReceipt(runId);
  assert.ok(receipt.limitations.some((l) => /critique incomplete/i.test(l)), 'receipt records the critique limitation');
  assert.equal(receipt.reviewIntegrity, 'unattested');
});

test('SEATS: exactly two unique seat ids are required', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  await assert.rejects(() => app.createRun(config({ seats: [demoSeats()[0]] })), /exactly two/);
  const dup = demoSeats();
  dup[1].seatId = 'seat-a';
  await assert.rejects(() => app.createRun(config({ seats: dup })), /duplicate seat id/);
});

test('RECOVERY: re-running a finished run is refused (no repeated turns / second run.finished)', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config());
  await app.run(runId);
  await assert.rejects(() => app.run(runId), /already/);
  // A fresh Application (simulating restart) also refuses and would not reuse seqs.
  const app2 = new Application({ decider: autoDecider() });
  await assert.rejects(() => app2.run(runId), /already/);
});

test('RECOVERY: a restarted Application never reuses a sequence number', async () => {
  tempStore();
  const app = new Application({ decider: autoDecider() });
  const { runId } = await app.createRun(config());
  // Do not finish; emit some events then "restart".
  const store = new RunStore();
  const maxBefore = Math.max(...store.readEvents(runId).map((e) => e.seq));
  const app2 = new Application({ decider: autoDecider() });
  app2._seedSeq(runId, store.loadState(runId));
  const evt = app2._emit(runId, { kind: 'notice', payload: { level: 'info', message: 'after restart' } });
  assert.ok(evt.seq > maxBefore, `new seq ${evt.seq} must exceed prior max ${maxBefore}`);
});

test('PRIVACY: secret-named keys are redacted even with --include-content', () => {
  const doc = { apiKey: 'abc123short', token: 'opaque', password: 'hunter2', nested: { access_token: 'zzz', note: 'fine' } };
  const red = redactDeep(structuredClone(doc));
  assert.equal(red.apiKey, '[redacted]');
  assert.equal(red.token, '[redacted]');
  assert.equal(red.password, '[redacted]');
  assert.equal(red.nested.access_token, '[redacted]');
  assert.equal(red.nested.note, 'fine');
});

test('EXTERNAL: cannot overwrite a built-in id; protocol mismatch rejected', () => {
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'moh-extbad-'));
  // Manifest claiming id "fake" (a built-in) must be refused.
  const collide = join(dir, 'collide.json');
  writeFileSync(collide, JSON.stringify({ protocol: 1, id: 'fake', executable: join(root, 'examples/example-adapter/adapter.mjs') }));
  assert.throws(() => registerExternalAdapter(collide, { trust: true }), /collides with a built-in/);
  // Wrong protocol version must be refused.
  const badProto = join(dir, 'proto.json');
  writeFileSync(badProto, JSON.stringify({ protocol: 999, id: 'ext-proto', executable: join(root, 'examples/example-adapter/adapter.mjs') }));
  assert.throws(() => registerExternalAdapter(badProto, { trust: true }), /unsupported external-adapter protocol/);
  rmSync(dir, { recursive: true, force: true });
});

test('MIGRATION: {schema:2} is quarantined, not migrated', async () => {
  const { migrateCouncilRun } = await import('../src/storage/migrate.mjs');
  const r = migrateCouncilRun({ schema: 2, runId: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.quarantined, true);
});
