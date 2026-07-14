# Roadmap

This roadmap describes what shipped in the initial public beta (P0) and what has
been intentionally deferred (P1). It is a statement of direction, not a
commitment or a schedule. Priorities may change, and deferred items may never be
built.

Mixture of Harnesses is **local-first** by design: it runs on your machine,
never pushes git branches, and does not capture credentials. Several deferred
items would change that posture and are deliberately gated behind explicit
future work.

## P0 — Shipped in 0.1.0 (public beta)

The core experience is available today:

- Modular, UI-independent orchestration core.
- Generic seats with a documented adapter contract.
- Adapters for Claude Code and Codex CLI, with honest OpenClaw/Hermes states.
- Per-turn model provenance where the harness reports it.
- Structured, schema-validated review with nonce-bound anchored records.
- Exact-tree **local** result branches and deterministic receipts (never
  pushed).
- Terminal UI and a hardened loopback (localhost) web companion.
- Deterministic, zero-token demo.
- Legacy Council migration, packaging, and CI that runs without paid calls or
  login.

See the [CHANGELOG](CHANGELOG.md) for the detailed 0.1.0 entry.

## P1 — Deferred (not in 0.1.0)

The following are explicitly out of scope for the initial beta. They are listed
so expectations are clear; none of these are implemented today.

- **Native desktop application** (Electron / Tauri).
- **Hosted / multi-tenant service.**
- **LAN or internet exposure** of the web companion (currently loopback-only).
- **Real-time multi-user collaboration.**
- **N-way councils** (more than two harnesses per task).
- **Adapter marketplaces** / third-party adapter distribution.
- **Automatic push and pull-request creation.** The project deliberately does
  not push branches or open PRs; changing this is a significant, opt-in future
  direction.
- **Native installers**, Homebrew / WinGet distribution, and auto-update.
- **Centralized credential storage.** The project does not store credentials
  today, and any future credential handling would be a major, carefully-scoped
  effort.
- **Telemetry and billing.**
- **Full signed attestation** of runs and artifacts.

If one of these matters to you, please open or upvote a GitHub issue describing
your use case.
