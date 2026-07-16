# Troubleshooting

Start with `moh doctor` (offline; spends no tokens). Readiness states map to fixes below.

| Doctor state | Meaning | What to do |
| --- | --- | --- |
| `ready` | Harness found and authorized (delegated) | Nothing — run a task. |
| `needs_login` | Harness installed but not logged in | Run the harness's native login (`claude auth login`, `codex login`), then refresh `moh web`. |
| `missing` | Executable not found | Install the harness and put it on `PATH`, or set `MOH_CLAUDE_PATH` / `MOH_CODEX_PATH`. |
| `experimental` | Found but interface unverified | Usable for inspection; not granted an author role. See `docs/ADAPTERS.md`. |
| `blocked` | Found but cannot be safely driven | Not invocable; awaiting a verified headless interface. |
| `unavailable` | Not installed and no verified interface | Install it and re-run `moh doctor`. |
| `probe_failed` | Discovery/probe threw | Re-run with the harness on `PATH`; check the printed detail (secrets redacted). |

For Claude automation, `needs_login` can also mean that the explicitly selected
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is absent. Set the value in the
environment that launches moh; do not paste it into the browser.

For Codex, `codex login` uses ChatGPT OAuth by default and also supports the CLI's
API-key login. moh only reuses the official CLI session; it does not expose a credential
field or persist the credential itself.

## Common issues

- **`Effective model: Not reported by harness`** — this is expected and honest: the
  harness did not emit runtime model evidence. The *requested* model is shown separately.
- **Model mismatch/fallback warning** — the runtime-reported model differs from the
  requested one (or changed mid-run). moh records the full history; this is informational.
- **No “Latest frontier” badge for Claude** — this Claude CLI does not expose an offline
  account model catalog. Choose an exact model if needed; moh will show the effective
  model only after Claude reports it at runtime.
- **No latest-frontier/custom-reasoning choice with a Codex profile** — the current
  Codex CLI can apply `--profile` to a run but cannot scope `debug models` to that
  profile. Use a pinned model or the profile default and verify structured runtime
  evidence.
- **Claude sandbox shows `unknown`** — Claude's `--permission-mode` controls approvals;
  moh has not verified it as a filesystem or network sandbox.
- **Authorization still says unverified** — run `claude auth status --json` or
  `codex login status` directly. Older CLI releases may not support a structured status
  probe; update the CLI and refresh the browser companion.
- **`candidate tree changed after review` (blocked)** — the workspace was modified between
  review and result creation. Re-run so the reviewed tree matches; moh refuses to create a
  branch from unreviewed content.
- **Port already in use (`moh web`)** — moh automatically tries the next free loopback
  port. Force one with `--port N`.
- **Result not created despite confirming** — the verdict was not `approve`. Confirm and
  choose *override* to create it, which records `UNREVIEWED`/`OVERRIDDEN` (never
  "approved").
- **Interrupted run** — on the next `moh web` start, a run left marked running is
  finalized as `failed` with an interruption notice. Nothing paid is silently repeated.
  Reopen it from run history or use `moh inspect <run-id>`; workspaces are preserved for
  an explicit retry/resume.
- **Codex capabilities show `unknown`** — Codex is not installed on this machine, or its
  installed `--help` did not advertise the flag. moh only claims what it can observe.

## Reset local state

Run records and workspaces live under your user state dir (see `moh doctor` → `state
dir`). Remove that directory to start fresh; it is never inside the installed package.
