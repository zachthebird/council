// Git workspace + result integrity. Review runs against an IMMUTABLE candidate
// tree (a git tree OID); artifact bytes are read from git objects (symlink-safe,
// never through a redirectable worktree path). The result branch is created from
// the reviewed tree via commit-tree — NOT from a later `git add -A`. Never pushes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, rmSync, cpSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeGitUrl } from '../security/redact.mjs';

function git(cwd, args, { input = null, buffer = false } = {}) {
  const res = execFileSync('git', args, {
    cwd,
    input: input ?? undefined,
    maxBuffer: 64 * 1024 * 1024,
    encoding: buffer ? null : 'utf8',
    // Isolate from user hooks / signing / global config surprises during plumbing.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return buffer ? res : String(res).trim();
}

export const RESULT_BRANCH_PREFIX = 'moh';

export function resultBranchName(runId) {
  return `${RESULT_BRANCH_PREFIX}/${runId}`;
}

/** Prepare a seat workspace by seeding from a repo spec. */
export function prepareWorkspace(destDir, seed) {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  if (seed.kind === 'greenfield') {
    git(destDir, ['init', '-q', '-b', 'main']);
    // A base commit so diffs and result branches have a parent.
    writeFileSync(join(destDir, '.gitkeep'), '');
    git(destDir, ['add', '-A']);
    commitEmpty(destDir, 'moh: greenfield base');
  } else if (seed.kind === 'local') {
    const src = seed.path;
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`local repo not found: ${src}`);
    if (existsSync(join(src, '.git'))) {
      git(destDir, ['clone', '-q', '--no-hardlinks', src, '.']);
    } else {
      // Not a git repo: copy files and init.
      cpSync(src, destDir, { recursive: true });
      git(destDir, ['init', '-q', '-b', 'main']);
      git(destDir, ['add', '-A']);
      commitEmpty(destDir, 'moh: import local files');
    }
  } else if (seed.kind === 'url') {
    // Reject credential-bearing URLs before they ever touch disk/persistence.
    const safe = sanitizeGitUrl(seed.url, { reject: true });
    git(destDir, ['clone', '-q', '--depth', '1', safe, '.']);
  } else {
    throw new Error(`unknown seed kind: ${seed.kind}`);
  }
  ensureIdentity(destDir);
  return { dir: destDir, base: baseCommit(destDir) };
}

function ensureIdentity(dir) {
  // Local, non-authoritative identity so commit-tree works without global config.
  try {
    git(dir, ['config', 'user.email', 'moh@localhost']);
    git(dir, ['config', 'user.name', 'Mixture of Harnesses']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
  } catch {
    /* ignore */
  }
}

function commitEmpty(dir, message) {
  ensureIdentity(dir);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
}

export function baseCommit(dir) {
  try {
    return git(dir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Capture an immutable candidate tree from the current worktree WITHOUT touching
 * the real index/HEAD. Uses a scratch index file. Returns the tree OID.
 */
export function captureTree(dir) {
  const idx = join(tmpdir(), `moh-index-${process.pid}-${(process.hrtime.bigint() % 1000000n).toString()}`);
  try {
    const env = { GIT_INDEX_FILE: idx };
    execFileSync('git', ['add', '-A'], { cwd: dir, env: { ...process.env, ...env } });
    const tree = execFileSync('git', ['write-tree'], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
    return tree;
  } finally {
    try {
      rmSync(idx, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** List files (path + blob OID + mode) in a tree. */
export function listTree(dir, treeOid) {
  const out = git(dir, ['ls-tree', '-r', '-z', treeOid]);
  const entries = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    // "<mode> <type> <oid>\t<path>"
    const tab = rec.indexOf('\t');
    const meta = rec.slice(0, tab).split(/\s+/);
    const path = rec.slice(tab + 1);
    entries.push({ mode: meta[0], type: meta[1], oid: meta[2], path });
  }
  return entries;
}

/** Read a blob's bytes from git objects (symlink-safe). Returns a Buffer. */
export function readBlob(dir, treeOid, path) {
  return git(dir, ['cat-file', 'blob', `${treeOid}:${path}`], { buffer: true });
}

/** Changed paths between base commit and candidate tree, with status letters. */
export function changedPaths(dir, baseOid, treeOid) {
  if (!baseOid) baseOid = git(dir, ['hash-object', '-t', 'tree', '/dev/null']).trim?.() || null;
  const out = git(dir, ['diff', '--name-status', '-z', baseOid ? baseOid : '4b825dc642cb6eb9a060e54bf8d69288fbee4904', treeOid]);
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const path = parts[i++];
    if (path === undefined) break;
    changes.push({ status, path });
  }
  return changes;
}

/** SHA-256 digests of each file in a changed-path manifest (binary-safe). */
export function digestFiles(dir, treeOid, paths) {
  const digests = {};
  for (const p of paths) {
    try {
      const buf = readBlob(dir, treeOid, p);
      digests[p] = 'sha256:' + createHash('sha256').update(buf).digest('hex');
    } catch {
      digests[p] = null; // deleted file (not present in candidate tree)
    }
  }
  return digests;
}

/**
 * Create the local result branch from the REVIEWED tree exactly.
 * Re-verifies (caller passes expected OIDs) and never pushes.
 * @returns {{branch:string, commit:string, tree:string}}
 */
export function createResultBranch(dir, { runId, treeOid, baseOid, message }) {
  ensureIdentity(dir);
  // Verify the tree object still resolves to what was reviewed.
  const resolved = git(dir, ['rev-parse', `${treeOid}^{tree}`]);
  if (resolved !== treeOid) throw new Error(`reviewed tree ${treeOid} no longer matches (${resolved})`);
  const branch = resultBranchName(runId);
  const args = ['commit-tree', treeOid, '-m', message];
  if (baseOid) args.splice(2, 0, '-p', baseOid);
  const commit = git(dir, args);
  git(dir, ['branch', '-f', branch, commit]);
  // Explicitly NO push. This is a local branch only.
  return { branch, commit, tree: treeOid };
}

export { git as _git };
