# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-14

Initial public-beta release. This version is a beta: interfaces may change, and
capabilities should be read as described rather than as guarantees.

### Added

- **Product rename** from *Council* to **Mixture of Harnesses** (`moh`,
  npm package `mixture-of-harnesses`), with a migration path for existing
  Council configurations.
- **Modular, UI-independent core** so the orchestration logic runs
  independently of any particular front end (TUI or web companion).
- **Generic seats and a documented adapter contract**, decoupling the core from
  any specific coding harness.
- **Claude Code and Codex CLI adapters** built on the adapter contract.
- **Honest OpenClaw and Hermes states**, surfacing real support status rather
  than overstating readiness.
- **Per-turn model provenance**, recording which model produced each turn where
  the harness reports it.
- **Structured, schema-validated review** with nonce-bound anchored records for
  traceability.
- **Exact-tree local result branches** and **deterministic receipts**, so a run
  produces a reproducible, traceable local git branch. Branches are never
  pushed.
- **Terminal UI (TUI)** for running and observing tasks.
- **Hardened loopback web companion**, bound to localhost.
- **Deterministic, zero-token demo** (`moh demo`) that runs the full flow with
  fake harnesses and no credentials.
- **Legacy Council migration** for prior on-disk state and configuration.
- **Packaging and CI**, including tests that run with no paid calls and no
  login.

[0.1.0]: https://github.com/zachthebird/council/releases/tag/v0.1.0
