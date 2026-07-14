# Migrating from Council

Mixture of Harnesses is the successor to *Council*. Your existing data stays readable and
your original artifacts are never modified.

## What is preserved

- **Legacy runs** under a Council state directory (`~/.council`, platform app-support, or
  `$COUNCIL_STATE_DIR`) are scanned read-only via `scanLegacyCouncil()` and mapped into
  the generic seat model via `migrateCouncilRun()`.
- **Historical branches** `council/<run-id>` are left in place. New runs create
  `moh/<run-id>`.
- Original legacy files are **never mutated** — migration emits a new, versioned record.

## What changes

- Fixed `sessions.claude` / `sessions.codex` become **generic seats** (`seat-a`,
  `seat-b`) with `legacyActor` preserved and adapters mapped (`claude-code`, `codex-cli`).
- Legacy runs did not record trustworthy per-turn model identity, so model provenance is
  marked **`unknown`** — it is never reconstructed from assumptions.
- Legacy review integrity is marked **`unattested`** because exact tree/verdict binding
  cannot be demonstrated retroactively.

## Environment variables

`COUNCIL_*` variables are honored for **one compatibility release** with a deprecation
warning; prefer `MOH_*`:

| Deprecated | Use instead |
| --- | --- |
| `COUNCIL_STATE_DIR` | `MOH_STATE_DIR` |
| `COUNCIL_CONFIG_DIR` | `MOH_CONFIG_DIR` |
| `COUNCIL_CLAUDE_PATH` | `MOH_CLAUDE_PATH` |
| `COUNCIL_CODEX_PATH` | `MOH_CODEX_PATH` |

## Compatibility shim

The legacy entrypoint `node server.mjs` still works: it prints a deprecation notice and
forwards to `moh web`. It will be removed in a future release.

## Safety

Migration is **idempotent** (re-running produces identical output) and a newer/malformed
schema is **quarantined**, never silently discarded.
