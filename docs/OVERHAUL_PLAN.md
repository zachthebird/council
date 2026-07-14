# Mixture of Harnesses — P0 Overhaul Plan

> **Baseline note.** The checked-out HEAD of this repository (`f2cff38 council: empty
> base`) contains **no source files** — it is an empty base commit. Per the working
> rules, the actual HEAD is authoritative, so there is no in-tree Council code to
> refactor. This plan therefore builds the strongest coherent P0 of *Mixture of
> Harnesses* directly, while still implementing **legacy Council migration** against
> synthesized fixtures so that a real user's on-disk `council/` data and
> `council/<run-id>` branches remain readable. If a future HEAD reintroduces the
> monolithic `server.mjs`/`prompts.mjs`, the same module boundaries below apply as a
> refactor target.

## 1. Product

- **Display name:** Mixture of Harnesses
- **Tagline:** One task. Multiple harnesses. Better code.
- **CLI:** `moh` · **npm:** `mixture-of-harnesses` · **env prefix:** `MOH_` · **branch prefix:** `moh/<run-id>`

Terms are used precisely and never collapsed: **Harness** (runtime/CLI), **Provider**
(inference route), **Model** (per-turn requested/reported), **Auth profile** (non-secret
label), **Seat** (one configured participant).

## 2. Module boundaries

The **core must not import** TUI, DOM, HTTP, or harness-specific modules. TUI, web, and
CLI automation all call the same application services and observe the same normalized
events.

```
src/core/       workflow domain, state machine + gates, orchestrator, events,
                provenance, review schema, receipt, ids, application service
src/adapters/   versioned adapter contract, registry, fake, claude-code, codex-cli,
                openclaw, hermes, external (jsonl-over-stdio)
src/process/    process supervision (spawn shell:false, tree-kill), env policy
src/git/        workspace, seed repo, immutable candidate tree, result branch
src/storage/    atomic file store, replay, platform paths, legacy migration
src/prompts/    generation/critique/integration/review/revision construction
src/security/   secret redaction, sanitized auth labels
src/cli/        arg parsing + commands
src/tui/        live terminal UI (plain/JSON fallback)
src/web/        loopback HTTP/SSE API + hardened browser UI
```

Dependency direction: `cli|tui|web -> core -> adapters -> process|git`. `core` depends on
adapter *contract* types only, never on a vendor module — adapters self-register.

## 3. Data model & schemas (all versioned)

- **Event envelope** (`SCHEMA_EVENT`): `v, seq, ts, runId, stage, attemptId, turnId,
  seatId, kind, payload, provenance`. Monotonic `seq`; `attemptId` fences late output.
- **Run state** (`SCHEMA_RUN`): seats (generic IDs), stage, preset, base commit, decisions.
- **Provenance** (`SCHEMA_PROVENANCE`): per-turn model identity with an explicit evidence
  `state` (`runtime_reported` … `mismatch_or_fallback`).
- **Receipt** (`SCHEMA_RECEIPT`): base OID, reviewed tree OID, changed-path manifest,
  SHA-256 artifact digests, prompt/workflow digest, seat provenance, review, decisions.
- **Adapter record** (`SCHEMA_ADAPTER`): id, version, trust level, capabilities.

Storage: **atomic file store** (write temp + `fsync` + `rename`) under
`~/.local/state/moh` (XDG / platform-appropriate). Each run is an append-only
`events.jsonl` + a `state.json` snapshot written atomically. Chosen over SQLite in
**ADR-0001** (see `docs/adr/`) to keep zero runtime dependencies, human-inspectable
records, and trivial packaging; a monotonic `seq` + append-only log + atomic snapshot
prevents overlapping writes, partial state, duplicate transitions, and replay gaps.

## 4. Adapter contract (versioned)

`ADAPTER_CONTRACT_VERSION = 1`. Each adapter exposes: `id, displayName, version,
trustLevel`; `discover()` (real-path resolution), `probeVersion()`, `probeReadiness()`
(**offline**), `capabilities()`, `discoverModels()?`, `prepareInvocation(turn)` →
`{executable, argv, env, stdin?}` (**never a shell string**), `startTurn()`,
`parseEvents(chunk)` (byte-safe UTF-8, tolerant of unknown fields), `finalize()`,
`cancel()` (process-tree), `resume()?`, `diagnostics()` (sanitized). Capabilities are an
explicit enum; unsupported → `unsupported|unknown|experimental|blocked`, never fabricated.

External adapters use a **versioned JSONL-over-stdio** protocol (`docs/PROTOCOL.md`) with
explicit user opt-in — enabling one means trusting local code.

## 5. Model-provenance rules (release-blocking)

- Requested ≠ configured ≠ runtime-reported; each stored separately per seat per turn.
- Evidence source recorded for every claim. Prose/filenames/prompts are never trusted.
- No runtime evidence → display exactly `Effective model: Not reported by harness`.
- Requested vs reported mismatch → prominent event + preserved history.
- Never spend tokens to discover a model. Identity line visible in TUI and web.

## 6. Security changes

- `shell: false`, argv arrays, validated executable + cwd, bounded io/time/concurrency.
- Env policy: allowlist only intended auth references; never pass full parent env.
- Redaction of secret-shaped values from logs/events/exports.
- Web: bind `127.0.0.1`, per-launch capability token, Host/Origin validation, no CORS,
  restrictive CSP, escaped harness/repo content, no secrets in URL/storage/SSE.
- Review: schema-validated verdict; fallback parser requires an exact anchored control
  record; artifact bytes read from Git objects; result branch built from the reviewed
  tree after a re-check of tree/parent/policy/review.

## 7. Migration

Council runs/events/branches remain readable. `COUNCIL_*` env accepted for one release
with a deprecation warning (prefer `MOH_*`). Legacy `sessions.claude/.codex` map to
generic seats; missing model provenance → `unknown`; unattestable review integrity →
`unattested`. Migration is idempotent (tested by repeated application) and never mutates
the original legacy artifacts.

## 8. P0 scope / P1 deferrals

**P0 ships:** rename + legacy compat, UI-independent core, real `moh` CLI + TUI, setup +
doctor + adapters discovery, versioned adapter contract, Claude Code + Codex adapters,
honest OpenClaw/Hermes states, BYO-auth (labels only), per-turn provenance, hardened web
companion, zero-token demo, durable recovery, exact-tree result + receipt, packaging +
docs + CI + community scaffolding.

**P1 deferred:** native desktop, hosted/multi-tenant, LAN/internet exposure, real-time
collaboration, N-way councils, adapter marketplaces, auto push/PR, native installers,
centralized credential storage, telemetry/billing, full signed-attestation infra.

## 9. Implementation order

Characterize → schemas + generic seats + events + migration → Claude/Codex behind the
contract → provenance + env isolation + structured review → fake adapter + demo + setup +
doctor → TUI on the shared core → web parity + hardening → OpenClaw/Hermes + external
protocol → exact-tree receipts + result-branch checks → packaging + CI + docs → run the
full verification matrix and fix failures.
