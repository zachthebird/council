# Migrating from Council

Mixture of Harnesses is the successor to *Council*. Your existing data stays readable and
your original artifacts are never modified.

## What is preserved

- **Legacy runs** under a Council state directory (`~/.council`, platform app-support,
  `$COUNCIL_STATE_DIR`, or the installed package/checkout root) are scanned read-only via
  `scanLegacyCouncil()` and mapped into the generic seat model via
  `migrateCouncilRun()`. Readable legacy records appear in `moh web` history as
  explicitly read-only and unattested; incompatible legacy activity events are not
  replayed through the new event renderer.
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

Council stored repository-local history in `<council-root>/runs`. The package/checkout
root is therefore included as a read-only legacy source so an in-place upgrade can still
find those runs. The scanner also checks `$COUNCIL_STATE_DIR` and the platform legacy
locations. It never writes new moh state into any of them.

Compatibility behavior for legacy environment variables is intentionally narrow:

| Legacy variable | Compatibility behavior |
| --- | --- |
| `COUNCIL_STATE_DIR` | Scanned read-only for Council runs. Use `MOH_STATE_DIR` for new moh state. |
| `COUNCIL_CONFIG_DIR` | Not used for new writes. Use `MOH_CONFIG_DIR`. |
| `COUNCIL_CLAUDE_PATH` | Honored for one compatibility release with a warning; prefer `MOH_CLAUDE_PATH`. |
| `COUNCIL_CODEX_PATH` | Honored for one compatibility release with a warning; prefer `MOH_CODEX_PATH`. |

## Compatibility shim

The legacy entrypoint `node server.mjs` still works: it prints a deprecation notice and
forwards to `moh web`. It will be removed in a future release.

## Safety

Migration is **idempotent** (re-running produces identical output) and a newer/malformed
schema is **quarantined**, never silently discarded.
