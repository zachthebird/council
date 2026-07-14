# Privacy

Mixture of Harnesses is **local-first**. There is no telemetry, no analytics, no
phone-home, and no account. Everything runs on your machine.

## What stays local

- Your repositories, prompts, harness processes, and delegated authorization never leave
  your machine through moh.
- Run records, events, receipts, and workspaces are written under your platform's user
  state directory (e.g. `~/Library/Application Support/moh` on macOS, `$XDG_STATE_HOME/moh`
  on Linux), **outside** the installed package. Override with `MOH_STATE_DIR`.

## What moh stores

- Non-secret configuration: adapter ids, requested models/effort, permission modes, and
  auth env var **names** (never values).
- Per-run: normalized events, seat provenance, a structured review, and a deterministic
  receipt with git OIDs and SHA-256 artifact digests.

## What moh never stores or prints

- Secret values, API keys, OAuth sessions, cookies, authorization headers, or full
  environments. Secret-shaped strings are redacted from logs, events, errors, and
  diagnostics.
- moh never scrapes consumer app tokens, never copies a harness's credentials, and never
  requests secrets through the web UI.

## Exports are privacy-safe by default

`moh export <run-id>` (Markdown or JSON) **excludes** repository content, prompts,
absolute paths, and raw tool inputs by default, and strips secret-shaped values. Including
content requires an explicit `--include-content` flag, which prints a warning to preview
before sharing.

## Telemetry

Off. There is nothing to turn off — moh has no telemetry to begin with.
