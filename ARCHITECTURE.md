# Architecture

Mixture of Harnesses has **one orchestration core**. The TUI, web companion, and CLI
automation are thin clients that call the same application service and observe the same
normalized events. The core never imports a UI, DOM, HTTP, or harness-specific module.

```
cli / tui / web  ─────────────┐   (thin clients: same services, same events, same gates)
                              ▼
                    src/core/app.mjs  (Application — the ONE core)
        ┌───────────────┬───────────┴───────────┬────────────────┐
        ▼               ▼                        ▼                ▼
   state machine   events (envelope)      provenance         review (schema)
   src/core/state  src/core/events        src/core/prov…     src/core/review
        │               │                        │                │
        ▼               ▼                        ▼                ▼
   storage (atomic)  adapters (contract+registry)   git (workspace, exact tree)   receipt
   src/storage       src/adapters                   src/git                       src/core/receipt
                         │
                         ▼
                 process supervisor (shell:false, tree-kill, bounds) + env policy
                 src/process
```

Dependency direction: `cli|tui|web → core → adapters → process|git|storage`. `core`
depends only on the adapter **contract** (`src/adapters/contract.mjs`), never on a vendor
adapter — adapters self-register in `src/adapters/registry.mjs`.

## Key modules

- **`core/state.mjs`** — `Stage`, `Preset`, ordered stages, and human **gates**
  (leader selection, result creation). Harness-neutral.
- **`core/events.mjs`** — versioned event envelope: `{v, seq, ts, runId, stage,
  attemptId, turnId, seatId, kind, payload, provenance}`. `seq` is monotonic per run;
  `attemptId` fences late output from a cancelled/timed-out/retried process.
- **`core/app.mjs`** — the `Application` service: creates runs, prepares isolated seat
  workspaces, drives seat turns through adapters, records provenance, enforces gates,
  runs the structured review, and creates the exact-tree result branch + receipt.
- **`core/provenance.mjs`** — per-turn model identity with an explicit evidence `state`
  (`runtime_reported` … `mismatch_or_fallback`). Never collapses requested / configured /
  reported.
- **`core/review.mjs`** — nonce-bound anchored review records; substring verdict parsing
  is impossible.
- **`adapters/`** — versioned contract, registry, `fake`, `claude-code`, `codex-cli`,
  `openclaw`, `hermes`, and the `external` JSONL-over-stdio protocol.
- **`process/`** — the only place a harness is spawned: argv arrays, `shell:false`,
  validated executable/cwd, bounded io/time, byte-safe `StringDecoder`, process-tree
  cancellation.
- **`git/workspace.mjs`** — isolated per-seat workspaces, immutable candidate tree OIDs,
  artifact bytes read from git objects (symlink-safe), and result branches built from the
  reviewed tree via `commit-tree`.
- **`storage/`** — atomic file store (ADR-0001), replay, platform paths, legacy Council
  migration.

## Run lifecycle (Full Mixture)

1. **generate** — both seats work in independent git workspaces.
2. **critique** — each seat critiques the other (skipped for a sole survivor).
3. **leader selection** *(gate)* — human (or auto-decider) picks the leader.
4. **integrate** — leader synthesizes in its workspace.
5. Capture immutable **candidate tree** OID.
6. **review** — structured, schema-validated verdict bound to a fresh nonce.
7. **revise** (≤1) then re-review if the verdict is `revise`.
8. **result gate** *(gate)* — human confirms `Create local result branch`. Non-approved
   verdicts require an explicit override and are recorded `UNREVIEWED`/`OVERRIDDEN`.
9. Re-verify the tree still matches the reviewed tree, then **commit-tree** the reviewed
   tree into `moh/<run-id>` and write the deterministic **receipt**.

## Determinism & recovery

`moh demo` uses a deterministic id factory and fixed timestamps, so run records are
byte-stable. Events are append-only with monotonic `seq`; snapshots are written
atomically (temp + fsync + rename). A crash leaves a replayable log and never a
half-written snapshot; a torn final line is skipped, not fatal.
