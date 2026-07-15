import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, captureTree, readBlob, changedPaths, createResultBranch, buildReviewEvidence } from '../src/git/workspace.mjs';

function g(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

test('CRITICAL 1: replacement refs cannot make one tree masquerade as another', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-replace-'));
  const { base } = prepareWorkspace(dir, { kind: 'greenfield' });
  // Benign content R.
  writeFileSync(join(dir, 'file.txt'), 'BENIGN');
  const treeR = captureTree(dir);
  // Malicious content T.
  writeFileSync(join(dir, 'file.txt'), 'MALICIOUS');
  const treeT = captureTree(dir);
  assert.notEqual(treeR, treeT);
  // Attacker maps T -> R via a replacement ref.
  try {
    g(dir, ['replace', treeT, treeR]);
  } catch {
    // If git refuses (type/size), the attack is already impossible; skip.
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  // moh reads T's bytes: must see MALICIOUS (raw T), NOT BENIGN (replacement).
  const seen = readBlob(dir, treeT, 'file.txt').toString('utf8');
  assert.equal(seen, 'MALICIOUS', 'readBlob must ignore replacement refs');
  // And a result branch built from T must record T's real content.
  const res = createResultBranch(dir, { runId: 'rep-test', treeOid: treeT, baseOid: base, message: 'm' });
  const committed = g(dir, ['cat-file', 'blob', `${res.commit}:file.txt`], { GIT_NO_REPLACE_OBJECTS: '1' });
  assert.equal(committed, 'MALICIOUS');
  rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL 2: captureTree does not run repo-defined clean filters (no code exec / env read)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-filter-'));
  prepareWorkspace(dir, { kind: 'greenfield' });
  const marker = join(dir, 'FILTER_RAN');
  // Plant a hostile clean filter in LOCAL config + attributes, as a harness could.
  g(dir, ['config', 'filter.evil.clean', `sh -c 'echo $SECRET_PARENT > ${marker}; cat'`]);
  writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
  writeFileSync(join(dir, 'code.txt'), 'hello');
  // Capture with a parent secret present in OUR environment.
  process.env.SECRET_PARENT = 'topsecret';
  const tree = captureTree(dir);
  delete process.env.SECRET_PARENT;
  assert.ok(!existsSync(marker), 'clean filter must NOT have executed during capture');
  // Content is captured verbatim (filter bypassed).
  assert.equal(readBlob(dir, tree, 'code.txt').toString('utf8'), 'hello');
  rmSync(dir, { recursive: true, force: true });
});

test('rename records parse correctly (status R, old->new)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-rename-'));
  const { base } = prepareWorkspace(dir, { kind: 'greenfield' });
  writeFileSync(join(dir, 'a.txt'), 'x'.repeat(60));
  const t1 = captureTree(dir);
  const r1 = createResultBranch(dir, { runId: 'rn1', treeOid: t1, baseOid: base, message: 'add a' });
  // Rename a.txt -> b.txt (same content triggers rename detection).
  rmSync(join(dir, 'a.txt'));
  writeFileSync(join(dir, 'b.txt'), 'x'.repeat(60));
  const t2 = captureTree(dir);
  const changes = changedPaths(dir, r1.commit, t2);
  const rename = changes.find((c) => c.status[0] === 'R');
  assert.ok(rename, 'rename detected');
  assert.equal(rename.oldPath, 'a.txt');
  assert.equal(rename.path, 'b.txt');
  rmSync(dir, { recursive: true, force: true });
});

test('deletion evidence includes previous content and is not silently attested', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moh-del-'));
  const { base } = prepareWorkspace(dir, { kind: 'greenfield' });
  writeFileSync(join(dir, 'gone.txt'), 'IMPORTANT OLD CODE');
  const t1 = captureTree(dir);
  const r1 = createResultBranch(dir, { runId: 'del1', treeOid: t1, baseOid: base, message: 'add' });
  rmSync(join(dir, 'gone.txt'));
  const t2 = captureTree(dir);
  const ev = buildReviewEvidence(dir, r1.commit, t2);
  assert.match(ev.text, /IMPORTANT OLD CODE/, 'deletion shows previous content');
  assert.match(ev.text, /removed/);
  rmSync(dir, { recursive: true, force: true });
});
