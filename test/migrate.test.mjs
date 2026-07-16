import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateCouncilRun } from '../src/storage/migrate.mjs';
import { scanLegacyCouncil } from '../src/storage/migrate.mjs';
import { legacyCouncilDirs } from '../src/storage/paths.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const legacy = {
  runId: 'legacy-42',
  task: 'do a thing',
  actors: ['claude', 'codex'],
  sessions: { claude: { sessionId: 'c1', model: 'sonnet' }, codex: { session_id: 'x1' } },
  leader: 'claude',
  verdict: 'approve',
};

test('gate 6: legacy Council run maps fixed actors to generic seats', () => {
  const { ok, migrated } = migrateCouncilRun(legacy, { sourcePath: '/x' });
  assert.equal(ok, true);
  assert.equal(migrated.seats[0].seatId, 'seat-a');
  assert.equal(migrated.seats[0].legacyActor, 'claude');
  assert.equal(migrated.seats[0].adapterId, 'claude-code');
  assert.equal(migrated.seats[1].adapterId, 'codex-cli');
  assert.equal(migrated.leaderSeatId, 'seat-a');
  assert.equal(migrated.legacyBranch, 'council/legacy-42');
});

test('legacy model provenance marked unknown, never reconstructed', () => {
  const { migrated } = migrateCouncilRun(legacy);
  assert.equal(migrated.seats[0].provenance.state, 'unknown');
  assert.equal(migrated.seats[0].provenance.reportedModel, null);
  assert.equal(migrated.reviewIntegrity, 'unattested');
});

test('migration is idempotent (repeated application is stable)', () => {
  const a = migrateCouncilRun(legacy).migrated;
  const b = migrateCouncilRun(legacy).migrated;
  assert.deepEqual(a, b);
});

test('newer/malformed schema is quarantined, never silently discarded', () => {
  const r1 = migrateCouncilRun({ schema: 99999, runId: 'z' });
  assert.equal(r1.ok, false);
  assert.equal(r1.quarantined, true);
  assert.ok(r1.original);
  const r2 = migrateCouncilRun(null);
  assert.equal(r2.ok, false);
});

test('default legacy discovery includes the package root used by repo-local Council runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'moh-legacy-root-'));
  const runDir = join(root, 'runs', 'legacy-local');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(legacy));
  try {
    assert.ok(legacyCouncilDirs({ packageRoot: root }).includes(resolve(root)));
    const found = scanLegacyCouncil(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].legacy.runId, 'legacy-42');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
