// Git workspace + result integrity. Review runs against an IMMUTABLE candidate
// tree (a git tree OID); artifact bytes are read from git objects (symlink-safe,
// never through a redirectable worktree path). The result branch is created from
// the reviewed tree via commit-tree — NOT from a later `git add -A`. Never pushes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, rmSync, cpSync, statSync, realpathSync, readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { sanitizeGitUrl } from '../security/redact.mjs';
import { buildChildEnv } from '../process/env-policy.mjs';

// Fixed dates for deterministic mode so base/result commit OIDs (and thus the
// receipt digest) are byte-stable across identical demo/test runs.
const DETERMINISTIC_DATE = '2000-01-01T00:00:00Z';
const NULL_DEVICE = platform() === 'win32' ? 'NUL' : '/dev/null';

/**
 * Hardened git invocation. All plumbing runs with:
 *  - a MINIMAL environment (base allowlist only) so a repo-defined clean/smudge/
 *    fsmonitor filter can never read an unrelated parent secret;
 *  - GIT_NO_REPLACE_OBJECTS so a harness-planted `refs/replace/*` cannot make one
 *    tree masquerade as another (defeats replacement-ref attestation bypass);
 *  - system/global config disabled and hooks/fsmonitor neutralized so attacker
 *    config cannot execute code or alter object resolution.
 */
function git(cwd, args, { input = null, buffer = false, deterministic = false } = {}, indexFile = null) {
  const env = buildChildEnv({}).env;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE;
  env.GIT_ATTR_NOSYSTEM = '1';
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  if (deterministic) {
    env.GIT_AUTHOR_DATE = DETERMINISTIC_DATE;
    env.GIT_COMMITTER_DATE = DETERMINISTIC_DATE;
    env.GIT_AUTHOR_NAME = 'Mixture of Harnesses';
    env.GIT_AUTHOR_EMAIL = 'moh@localhost';
    env.GIT_COMMITTER_NAME = 'Mixture of Harnesses';
    env.GIT_COMMITTER_EMAIL = 'moh@localhost';
  }
  // Neutralize hooks/fsmonitor at the command level too (belt and suspenders).
  const hardened = ['-c', 'core.hooksPath=' + NULL_DEVICE, '-c', 'core.fsmonitor=false', '--no-replace-objects', ...args];
  const res = execFileSync('git', hardened, {
    cwd,
    input: input ?? undefined,
    maxBuffer: 64 * 1024 * 1024,
    encoding: buffer ? null : 'utf8',
    env,
  });
  return buffer ? res : String(res).trim();
}

/**
 * Assert that `target` resolves to a path INSIDE `root` before any destructive
 * operation. Prevents a crafted seat/run id from escaping the workspaces root.
 */
export function assertInside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  const rel = relative(r, t);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to operate on path outside workspaces root: ${target}`);
  }
  return t;
}

export const RESULT_BRANCH_PREFIX = 'moh';

export function resultBranchName(runId) {
  return `${RESULT_BRANCH_PREFIX}/${runId}`;
}

/**
 * Prepare a seat workspace by seeding from a repo spec.
 * @param {string} destDir
 * @param {object} seed
 * @param {object} [opts] { allowedRoot, deterministic }
 */
export function prepareWorkspace(destDir, seed, opts = {}) {
  // Defense-in-depth: never delete/create outside the workspaces root.
  if (opts.allowedRoot) assertInside(opts.allowedRoot, destDir);
  const det = !!opts.deterministic;
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  if (seed.kind === 'greenfield') {
    git(destDir, ['init', '-q', '-b', 'main']);
    // A base commit so diffs and result branches have a parent.
    writeFileSync(join(destDir, '.gitkeep'), '');
    git(destDir, ['add', '-A']);
    commitEmpty(destDir, 'moh: greenfield base', det);
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
      commitEmpty(destDir, 'moh: import local files', det);
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

function commitEmpty(dir, message, deterministic = false) {
  ensureIdentity(dir);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message], { deterministic });
}

export function baseCommit(dir) {
  try {
    return git(dir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Capture an immutable candidate tree from the current worktree WITHOUT running
 * ANY repository-defined clean/smudge filter. Filters are the vector by which a
 * harness-planted `.git/config` could execute code / exfiltrate env during a
 * naive `git add`. Instead we:
 *   - list candidate paths (honoring .gitignore) with `ls-files` (no filters),
 *   - hash each blob with `hash-object --no-filters` (writes to this repo's DB),
 *   - stage via `update-index --cacheinfo` and `write-tree` (no filters).
 * Symlinks are stored as link-target blobs (mode 120000), never followed.
 * Returns the tree OID (objects live in `dir`'s store for later commit-tree).
 */
export function captureTree(dir) {
  const idx = join(tmpdir(), `moh-index-${process.pid}-${(process.hrtime.bigint() % 1000000n).toString()}`);
  const withIdx = (args, opts = {}) => git(dir, args, opts, idx);
  try {
    // Seed the scratch index from HEAD (no filters), else start empty.
    try {
      withIdx(['read-tree', 'HEAD']);
    } catch {
      withIdx(['read-tree', EMPTY_TREE_OID]);
    }
    // All candidate paths: tracked (from base) + untracked non-ignored.
    const listed = withIdx(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const paths = listed.split('\0').filter(Boolean);
    const seen = new Set();
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      const abs = join(dir, p);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        // Present in index but gone on disk -> deletion.
        withIdx(['update-index', '--force-remove', '--', p]);
        continue;
      }
      if (st.isDirectory()) continue; // gitlink/submodule dirs are out of scope
      let oid;
      let mode;
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        oid = git(dir, ['hash-object', '-w', '--no-filters', '--stdin'], { input: target }, idx);
        mode = '120000';
      } else {
        oid = git(dir, ['hash-object', '-w', '--no-filters', '--', abs], {}, idx);
        mode = st.mode & 0o111 ? '100755' : '100644';
      }
      withIdx(['update-index', '--add', '--cacheinfo', `${mode},${oid},${p}`]);
    }
    return withIdx(['write-tree']);
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

/**
 * Changed paths between base commit and candidate tree. Correctly handles
 * rename (R) and copy (C) records, which in `--name-status -z` are emitted as
 * three fields: STATUS, OLDPATH, NEWPATH. `path` is the current (new) path;
 * `oldPath` is set for renames/copies.
 */
export function changedPaths(dir, baseOid, treeOid) {
  const from = baseOid || EMPTY_TREE_OID;
  // --find-renames so R/C are surfaced explicitly (and parsed correctly below).
  const out = git(dir, ['diff', '--name-status', '--find-renames', '-z', from, treeOid]);
  const parts = out.split('\0').filter((s) => s.length > 0);
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (newPath === undefined) break;
      changes.push({ status, path: newPath, oldPath });
    } else {
      const path = parts[i++];
      if (path === undefined) break;
      changes.push({ status, path });
    }
  }
  return changes;
}

/**
 * Build the review evidence for a candidate tree by reading each changed file's
 * bytes FROM GIT OBJECTS (symlink-safe; never through the mutable worktree).
 * Bounds total bytes and records explicit truncation so approval can be failed if
 * required evidence was unread.
 * @returns {{ text:string, truncated:string[], digests:object }}
 */
export function buildReviewEvidence(dir, baseOid, treeOid, { maxBytes = 512 * 1024, maxFileBytes = 64 * 1024 } = {}) {
  const from = baseOid || EMPTY_TREE_OID;
  const changes = changedPaths(dir, baseOid, treeOid);
  const truncated = [];
  const digests = {};
  const parts = [];
  let total = 0;

  // Read a blob from a given tree/commit; returns {buf} or {missing:true}.
  const read = (treeish, p) => {
    try {
      return { buf: readBlob(dir, treeish, p) };
    } catch {
      return { missing: true };
    }
  };
  const render = (label, buf) => {
    if (buf.length > maxFileBytes || total + buf.length > maxBytes) {
      return { included: false, note: `(content omitted: exceeds review size bound)` };
    }
    total += buf.length;
    const isText = !buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
    return { included: true, note: isText ? '```\n' + buf.toString('utf8') + '\n```' : `(binary, ${buf.length} bytes)` };
  };

  for (const ch of changes) {
    const code = ch.status[0];
    if (code === 'D') {
      // Deletion: include the BASE (previous) content so the reviewer sees exactly
      // what is being removed. If the previous content cannot be read, the deletion
      // is unattestable evidence -> record as truncated.
      const prev = read(from, ch.path);
      if (prev.missing) {
        truncated.push(ch.path);
        parts.push(`### D ${ch.path}\n(previous content unavailable — deletion cannot be attested)`);
        continue;
      }
      digests[ch.path] = null; // absent from candidate tree
      const r = render('D', prev.buf);
      if (!r.included) truncated.push(ch.path);
      parts.push(`### D ${ch.path} (removed)\nPrevious content:\n${r.note}`);
      continue;
    }

    const cur = read(treeOid, ch.path);
    if (cur.missing) {
      truncated.push(ch.path);
      parts.push(`### ${ch.status} ${ch.path}\n(candidate content unavailable — cannot be attested)`);
      continue;
    }
    digests[ch.path] = 'sha256:' + createHash('sha256').update(cur.buf).digest('hex');
    const header = code === 'R' || code === 'C' ? `### ${ch.status} ${ch.oldPath} -> ${ch.path}` : `### ${ch.status} ${ch.path}`;
    const r = render(ch.status, cur.buf);
    if (!r.included) {
      truncated.push(ch.path);
      parts.push(`${header}\n(content omitted: exceeds review size bound; digest ${digests[ch.path]})`);
      continue;
    }
    parts.push(`${header}\n${r.note}`);
  }
  return { text: parts.join('\n\n') || '(no changes)', truncated, digests };
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
export function createResultBranch(dir, { runId, treeOid, baseOid, message, deterministic = false }) {
  ensureIdentity(dir);
  // Verify the tree object still resolves to what was reviewed.
  const resolved = git(dir, ['rev-parse', `${treeOid}^{tree}`]);
  if (resolved !== treeOid) throw new Error(`reviewed tree ${treeOid} no longer matches (${resolved})`);
  const branch = resultBranchName(runId);
  const args = ['commit-tree', treeOid, '-m', message];
  if (baseOid) args.splice(2, 0, '-p', baseOid);
  const commit = git(dir, args, { deterministic });
  git(dir, ['branch', '-f', branch, commit]);
  // Explicitly NO push. This is a local branch only.
  return { branch, commit, tree: treeOid };
}

export { git as _git };
