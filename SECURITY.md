# Security

Mixture of Harnesses is local-first and safe by default. This document describes the
security boundaries and how to report issues.

## Reporting

Email **zachthebird@gmail.com** with details and a reproduction. Please do not open a
public issue for undisclosed vulnerabilities. We aim to acknowledge within a few days.

## Process & injection

- Harnesses are spawned with an **argv array and `shell:false`** — shell metacharacters
  are inert data, never interpreted (test: `gate 17`).
- Executable paths must be absolute, existing, regular files (real-path resolved); working
  directories are validated.
- **stdout, stderr, stdin (prompt), event size, and wall-clock runtime are all
  bounded** — a harness cannot exhaust memory via stdout/stderr spam or an oversized
  prompt; truncation is explicit. Streaming output is decoded byte-safely so split UTF-8
  is preserved.
- Cancellation terminates the **whole process tree**: `SIGINT` → bounded grace →
  `SIGKILL` (test: `gate 18`). `cancelled` is persisted separately from `failed`.
- Late output from a timed-out/cancelled/retried attempt is **fenced** by `attemptId` and
  cannot advance the workflow.

## Environment & credentials

- Children receive a **minimal environment**: a base allowlist plus only the auth env var
  **names** a seat explicitly declares. The full parent environment is never forwarded
  (test: `gate 16`).
- moh stores only **non-secret labels** (e.g. `ANTHROPIC_API_KEY present`,
  `Claude subscription/login (delegated)`), never secret values.
- Secrets are never placed in argv or URLs, and secret-shaped values are redacted from
  logs, events, errors, exports, and diagnostics (tests: `gate 15`, redaction).
- `moh doctor` is **offline** and non-token-consuming by default; any live probe is a
  separate, explicit action.

## Review & Git integrity

- Verdicts come only from a **schema-validated, nonce-bound anchored control record**.
  Repository text containing `APPROVE`, JSON, or delimiters cannot forge a verdict
  (tests: `gate 21`). Empty/ambiguous/malformed output can never become `approved`.
- Review reads artifact bytes from **git objects** (`git cat-file`), which is symlink-safe
  and independent of a potentially redirected worktree path. Deletions include the
  previous (base) content; renames/copies are parsed correctly (old→new).
- **All git plumbing is hardened**: it runs with a minimal environment (no parent
  secrets reach any repo-defined clean/smudge/fsmonitor filter), with
  `GIT_NO_REPLACE_OBJECTS`/`--no-replace-objects` so a planted `refs/replace/*` cannot
  make one tree masquerade as another, and with system/global config + hooks disabled.
  Candidate-tree capture uses `hash-object --no-filters` + `update-index` so a
  harness-planted clean filter never executes (tests: `test/git-integrity.test.mjs`).
- The result branch is built from the **reviewed tree** via `commit-tree`. Before
  creation, moh re-verifies the current tree still equals the reviewed tree; any change
  blocks creation (test: `gate 22`). moh **never pushes**.
- A human override of a missing/failed review requires explicit confirmation and is
  recorded as `UNREVIEWED`/`OVERRIDDEN` — never displayed as approved.
- Credential-bearing clone URLs are rejected/sanitized before persistence — both
  `user:pass@host` userinfo **and** token-bearing query parameters (`?token=`,
  `?access_token=`, `?api_key=`, …) (tests: `gate 26`, round-3 URL test).

## Web companion

- Binds `127.0.0.1` only. `0.0.0.0` requires an explicit `--dangerously-expose` flag with
  a printed warning.
- Per-launch **capability** delivered as an `HttpOnly; SameSite=Strict` cookie — never in
  URLs, HTML, `localStorage`, or SSE events.
- **DNS-rebinding** defense: non-canonical `Host` headers are rejected (test: `gate 24`).
- **CSRF** defense: mutations require the capability cookie, a canonical loopback
  `Origin`, a JSON content type, and a custom `X-MOH-CSRF` header. No permissive CORS.
- Restrictive CSP (`default-src 'none'`), locally bundled assets, and HTML-escaped
  harness/repository content (test: harness output cannot inject markup).

## What moh is NOT (P0)

Not a credential vault, not a hosted/multi-tenant service, not exposed to LAN/internet by
default, and it never auto-pushes or opens pull requests. See [ROADMAP.md](ROADMAP.md).
