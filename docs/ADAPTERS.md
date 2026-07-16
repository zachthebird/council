# Harness adapters

An **adapter** teaches Mixture of Harnesses how to drive one harness. The core depends
only on the versioned contract in `src/adapters/contract.mjs`
(`ADAPTER_CONTRACT_VERSION = 1`); adapters self-register in the registry.

## Terms

- **Harness** — the local agent runtime/CLI (Claude Code, Codex CLI, …).
- **Provider** — the inference route (Anthropic, OpenAI, a local runtime, a router, or
  unknown). Never guessed from a model-looking string.
- **Model** — the requested or runtime-reported model for one turn.
- **Auth profile** — a non-secret label (e.g. `ANTHROPIC_API_KEY present`).
- **Seat** — one independently configured participant.

## Contract

Required members: `id`, `displayName`, `version`, `trustLevel`, `discover()`,
`probeVersion()`, `probeReadiness()` (**offline**), `capabilities()`,
`prepareInvocation(ctx)`, `parseEvents(chunk, state)`, `finalize(state)`. Optional:
`discoverModels()`, `runTurn(ctx, hooks)`, `resume()`, `diagnostics()`, `authorAllowed`.

`prepareInvocation(ctx)` returns `{ executable, argv:string[], env, authEnvNames?,
stdin?, stdinPrompt?, promptFile? }` and **must never build a shell command string**.
Process-based adapters set `runTurn = executeProcessTurn(this, …)` which wires
env-policy → supervisor → streaming `parseEvents` → `finalize`.

`parseEvents` receives **decoded strings** (the supervisor handles byte-safe UTF-8 via a
`StringDecoder`), must tolerate malformed lines and unknown/forward-compatible fields,
and yields normalized events (`text`, `tool`, `model`, `final`, `notice`).

### Capability states

Each capability is `supported | unsupported | unknown | experimental | blocked`.
Unsupported capabilities are **never** fabricated as supported.

### Readiness states

`ready | needs_login | missing | experimental | blocked | probe_failed | unavailable`.

## Capability matrix

Generated from the adapters as installed on the build machine. `?` = unknown/unverified
on this machine. Codex populates from the installed `codex --help` at runtime, so its row
is `?` wherever Codex is not installed.

| Capability | fake | claude-code | codex-cli | openclaw | hermes |
| --- | --- | --- | --- | --- | --- |
| structured_streaming | ✓ | ✓ | ? | ? | ? |
| final_text_only | ✓ | ✓ | ? | ? | ? |
| native_resume | ✓ | ✓ | ? | ? | ? |
| prompt_rehydrated_continuity | ? | ? | ? | ? | ? |
| explicit_model_selection | ✓ | ✓ | ? | ? | ? |
| model_discovery | ? | ? | ✓ | ? | ? |
| provider_selection | ? | ? | ? | ? | ? |
| runtime_model_observation | ✓ | ✓ | ? | ? | ? |
| tool_events | ✓ | ✓ | ? | ? | ? |
| usage_reporting | ✓ | ✓ | ? | ? | ? |
| sandbox_controls | ? | ? | ? | ? | ? |
| approval_controls | ? | ✓ | ? | ? | ? |
| network_policy_controls | ? | ? | ? | ? | ? |
| interactive_auth | ? | ✓ | ✓ | ? | ? |
| workspace_isolation | ✓ | ✓ | ✓ | ? | ? |

Legend: ✓ supported · ✗ unsupported · ? unknown · ~ experimental · ⊘ blocked.

## What model identity is genuinely observable

| Adapter | Runtime-reported model? | Evidence source | Notes |
| --- | --- | --- | --- |
| **fake** | Yes (deterministic) | `fake.init` / `fake.final` | Also models a *not-reported* seat and a mid-run fallback. |
| **claude-code** | Yes | `stream.system.init`, `stream.assistant.message`, `stream.result.model`; a single `modelUsage` key is an unambiguous fallback | Reuses native login by default; environment-based API-key or OAuth-token authorization must be selected explicitly. Credential values are never read or saved. |
| **codex-cli** | Unknown until verified | `codex.jsonl` (best-effort) | `codex debug models` discovers the catalog for the CLI's current native account/client context, but not for a named profile. Runtime JSONL remains the source of effective-model evidence. |
| **openclaw** | Unknown | — | Experimental/Unavailable: no verified headless interface; refuses invocation; not granted an author role. |
| **hermes** | Unknown | — | Blocked/Unavailable: interface unverified; refuses invocation. |

For every seat and turn, moh keeps **requested**, **configured**, and
**runtime-reported** model identity distinct. Requested is the exact selection (or
`Harness default`); configured is an offline CLI/config observation and is not execution
proof; runtime-reported is accepted only from structured harness output and includes its
evidence source. Catalog source and check time are separate provenance fields.

If a harness reports only an alias, moh displays the alias — it never invents a dated
model id. With no runtime evidence, moh displays exactly `Effective model: Not reported
by harness` and shows requested/configured facts separately. Claude's `modelUsage` is an
aggregate map that can include auxiliary models, so multiple keys are never treated as
an ordered fallback history.

## Built-in adapter notes

### Claude Code
Discovery order: `MOH_CLAUDE_PATH` → `PATH` → documented fallbacks (`~/.local/bin`,
Homebrew, `/usr/local/bin`), real-path resolved. Permission mode is a **visible seat
setting** (default `acceptEdits`). `bypassPermissions` requires explicit typed
confirmation in setup and is never selected silently.

Delegated native login is the default and is checked with `claude auth status --json`
when the installed CLI supports it. Run `claude auth login` to authorize that CLI.
`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are forwarded only when their
corresponding authorization mode is explicitly selected. The browser stores only the
mode, variable name, and a sanitized presence label — never the value.

Claude's verified `--permission-mode` controls approval behavior. It is not a verified
filesystem or network sandbox, so `sandbox_controls` remains **unknown** and moh does
not claim that a Claude seat is sandboxed.

### Codex CLI
Discovery order: `MOH_CODEX_PATH` → `CODEX_PATH` → `PATH` → macOS app-bundle fallback.
Only flags observed in the installed `--help` are used (no invented flags). Exposes only a
sanitized readiness state; does not inherit unrelated provider secrets.
Native authorization is checked with `codex login status`; run `codex login` to sign in
with ChatGPT OAuth (the default) or the CLI's API-key flow. moh reuses the resulting CLI
session and never reads or stores the credential.
When available, `codex debug models` supplies the model catalog for the CLI's current
native account/client context. A **Latest frontier** selection is accepted only after a
fresh catalog query confirms that exact model.

If `--profile` is supported, moh can pass a named local Codex profile to the run. The
current CLI does not support `debug models` scoped to that profile, so moh cannot verify
its frontier model or supported reasoning levels in advance. With a profile selected,
use a pinned model or the harness default and treat structured runtime reporting as the
only effective-model evidence.

### OpenClaw / Hermes
Presented honestly as Experimental / Blocked / Unavailable with exact remediation. They
refuse invocation rather than fabricate behavior, do not modify global config, and are not
granted an author role until isolated-workspace authoring is proven.

## Adding your own harness

Prefer the **external-adapter protocol** (no core edits): see
[PROTOCOL.md](PROTOCOL.md) and the working example in `examples/example-adapter/`.
Enabling a third-party adapter means trusting local code and requires explicit opt-in
(`MOH_ALLOW_EXTERNAL_ADAPTERS=1`).
