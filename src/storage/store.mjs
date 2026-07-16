// Atomic, append-only run store. ADR-0001 chose atomic files over SQLite for
// zero-dependency, human-inspectable, packaging-trivial storage. Guarantees:
//  - no overlapping writes (single-writer lock file per run)
//  - no partial state (temp file + fsync + rename)
//  - no duplicate transitions / replay gaps (monotonic seq, append-only log)
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, openSync, closeSync, fsyncSync, readdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir } from './paths.mjs';
import { isSafeRunId } from '../core/ids.mjs';

export const SCHEMA_RUN = 1;

/** True if a process id is currently running (POSIX: EPERM means alive-but-ours-not). */
function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export class RunStore {
  #dir;
  constructor(baseDir = runsDir()) {
    this.#dir = baseDir;
  }

  runPath(runId) {
    if (!isSafeRunId(runId)) throw new Error(`unsafe run id: ${runId}`);
    return join(this.#dir, runId);
  }

  create(runId, initialState) {
    const dir = this.runPath(runId);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, '.lock');
    if (existsSync(lock)) {
      // Stale-lock tolerance: a lock without a live snapshot is abandoned.
      const stale = !existsSync(join(dir, 'state.json'));
      if (!stale) throw new Error(`run ${runId} is locked (already in progress)`);
    }
    atomicWrite(lock, String(process.pid));
    const state = { v: SCHEMA_RUN, ...initialState, seq: 0 };
    this.saveState(runId, state);
    // Truncate/initialize event log.
    atomicWrite(join(dir, 'events.jsonl'), '');
    return state;
  }

  saveState(runId, state) {
    atomicWrite(join(this.runPath(runId), 'state.json'), JSON.stringify(state, null, 2));
  }

  loadState(runId) {
    const f = join(this.runPath(runId), 'state.json');
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8'));
  }

  appendEvent(runId, evt) {
    // Append-only; a monotonic seq is assigned by the caller (application service).
    appendFileSync(join(this.runPath(runId), 'events.jsonl'), JSON.stringify(evt) + '\n');
  }

  /** Replay every persisted event in order — the basis for durable recovery. */
  readEvents(runId) {
    const f = join(this.runPath(runId), 'events.jsonl');
    if (!existsSync(f)) return [];
    const out = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // A torn last line (crash mid-append) is skipped, not fatal.
      }
    }
    return out;
  }

  /**
   * Replay with integrity validation. Returns { events, gaps, duplicates, torn }.
   * `gaps` lists missing sequence numbers, `duplicates` repeated ones, `torn` counts
   * unparParseable trailing lines — so recovery can detect an incomplete/corrupt log
   * instead of assuming contiguity.
   */
  replay(runId) {
    const f = join(this.runPath(runId), 'events.jsonl');
    if (!existsSync(f)) return { events: [], gaps: [], duplicates: [], torn: 0 };
    const events = [];
    let torn = 0;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        torn += 1;
      }
    }
    const gaps = [];
    const duplicates = [];
    const seen = new Set();
    let expected = 1;
    for (const e of events) {
      const s = e.seq;
      if (typeof s === 'number') {
        if (seen.has(s)) duplicates.push(s);
        seen.add(s);
      }
    }
    if (seen.size) {
      const max = Math.max(...seen);
      for (expected = 1; expected <= max; expected++) if (!seen.has(expected)) gaps.push(expected);
    }
    return { events, gaps, duplicates, torn };
  }

  writeReceipt(runId, receipt) {
    atomicWrite(join(this.runPath(runId), 'receipt.json'), JSON.stringify(receipt, null, 2));
  }

  readReceipt(runId) {
    const f = join(this.runPath(runId), 'receipt.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  }

  release(runId) {
    const lock = join(this.runPath(runId), '.lock');
    try {
      if (existsSync(lock)) renameSync(lock, `${lock}.released`);
    } catch {
      /* best effort */
    }
  }

  /**
   * Acquire the exclusive single-writer DRIVE lock before orchestrating a run.
   * A fresh run has no `.driving` file, so the atomic O_EXCL create succeeds.
   * Refuses when another LIVE process already drives the run (concurrent writers
   * would produce duplicate sequences and a second run.finished), and refuses a
   * DEAD-owner lock too — that marks an interrupted drive, which must be
   * restarted with a fresh id rather than silently re-driven from GENERATE
   * (which repeats already-paid turns). The stuck lock is harmless: `resume
   * --retry` mints a new run id and never touches it.
   */
  acquireDriveLock(runId) {
    const path = join(this.runPath(runId), '.driving');
    try {
      const fd = openSync(path, 'wx'); // O_CREAT | O_EXCL — atomic claim
      try {
        writeFileSync(fd, String(process.pid));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let holder = '';
    try {
      holder = readFileSync(path, 'utf8').trim();
    } catch {
      /* holder vanished mid-read; treat as contended below */
    }
    const pid = Number(holder);
    if (pid === process.pid) return; // re-entrant within the same process
    if (processIsLive(pid)) {
      throw new Error(`run ${runId} is already being driven by process ${pid}`);
    }
    throw new Error(`run ${runId} was interrupted; start a fresh attempt with \`moh resume ${runId} --retry\``);
  }

  releaseDriveLock(runId) {
    try {
      unlinkSync(join(this.runPath(runId), '.driving'));
    } catch {
      /* best effort */
    }
  }

  list() {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSafeRunId(d.name))
      .map((d) => d.name);
  }
}
