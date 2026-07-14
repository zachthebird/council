# ADR-0001: Atomic file store over a transactional database

- Status: Accepted
- Date: 2026-07-14

## Context

Runs must survive crashes and restarts without overlapping writes, partial state,
duplicate transitions, or replay gaps. New application data must live under
platform-appropriate user state directories, not inside the installed package.
The project also targets zero runtime npm dependencies for a small, auditable,
easy-to-package security surface.

## Decision

Use an **append-only event log (`events.jsonl`) plus an atomically-written state
snapshot (`state.json`)** per run, under `stateDir()/runs/<run-id>`.

- **Atomicity:** snapshots are written to a temp file, `fsync`'d, then `rename`'d
  (atomic on POSIX and NTFS). A reader never sees a half-written snapshot.
- **No overlapping writes:** a per-run `.lock` file marks an active writer; it is
  renamed aside on release. A lock without a snapshot is treated as abandoned.
- **No duplicate transitions / gaps:** every event carries a monotonic `seq`
  assigned by the single application-service writer; readers validate `seq`
  contiguity. A torn final line (crash mid-append) is skipped, not fatal.
- **Inspectable:** records are plain JSON/JSONL a human or `jq` can read.

## Alternatives considered

- **SQLite (better-sqlite3 / node:sqlite):** strong transactional guarantees, but
  adds a native/opt-in dependency, complicates packaging and cross-platform
  installs, and makes records less directly inspectable. `node:sqlite` is still
  experimental. Rejected for P0; may be revisited if concurrency needs grow.

## Consequences

- Zero runtime dependencies; trivial `npm pack` and clean-install.
- Single-writer-per-run is enforced by convention + lock file, which is adequate
  because one `Application` drives one run.
- If we later need concurrent multi-writer access or complex queries, revisit with
  a new ADR.
