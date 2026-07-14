# Troubleshooting

Start with `moh doctor` (offline; spends no tokens). Readiness states map to fixes below.

| Doctor state | Meaning | What to do |
| --- | --- | --- |
| `ready` | Harness found and authorized (delegated) | Nothing — run a task. |
| `needs_login` | Harness installed but not logged in | Run the harness's native login (`claude`, `codex login`), or set the documented API key env var. |
| `missing` | Executable not found | Install the harness and put it on `PATH`, or set `MOH_CLAUDE_PATH` / `MOH_CODEX_PATH`. |
| `experimental` | Found but interface unverified | Usable for inspection; not granted an author role. See `docs/ADAPTERS.md`. |
| `blocked` | Found but cannot be safely driven | Not invocable; awaiting a verified headless interface. |
| `unavailable` | Not installed and no verified interface | Install it and re-run `moh doctor`. |
| `probe_failed` | Discovery/probe threw | Re-run with the harness on `PATH`; check the printed detail (secrets redacted). |

## Common issues

- **`Effective model: Not reported by harness`** — this is expected and honest: the
  harness did not emit runtime model evidence. The *requested* model is shown separately.
- **Model mismatch/fallback warning** — the runtime-reported model differs from the
  requested one (or changed mid-run). moh records the full history; this is informational.
- **`candidate tree changed after review` (blocked)** — the workspace was modified between
  review and result creation. Re-run so the reviewed tree matches; moh refuses to create a
  branch from unreviewed content.
- **Port already in use (`moh web`)** — moh automatically tries the next free loopback
  port. Force one with `--port N`.
- **Result not created despite confirming** — the verdict was not `approve`. Confirm and
  choose *override* to create it, which records `UNREVIEWED`/`OVERRIDDEN` (never
  "approved").
- **Interrupted run** — nothing paid is silently repeated. Use `moh inspect <run-id>` and
  `moh resume <run-id>`; workspaces are preserved.
- **Codex capabilities show `unknown`** — Codex is not installed on this machine, or its
  installed `--help` did not advertise the flag. moh only claims what it can observe.

## Reset local state

Run records and workspaces live under your user state dir (see `moh doctor` → `state
dir`). Remove that directory to start fresh; it is never inside the installed package.
