# Mixture of Harnesses

**One task. Multiple harnesses. Better code.**

Mixture of Harnesses (`moh`) is a **local-first** app that gives one software task to
two independently configured coding **harnesses** (Claude Code, Codex CLI, …), lets you
watch them work, has them **critique each other**, **synthesizes** the strongest result,
**reviews** it against a strict schema, and creates a **traceable local Git result
branch** — with honest, per-turn model provenance. It never pushes, never captures
credentials, and spends **zero tokens** until you run a real task.

> Formerly *Council*. Existing Council runs and `council/<run-id>` branches remain
> readable; see [docs/MIGRATION.md](docs/MIGRATION.md).

## Why

- **Local-first & private** — repos, harness processes, and delegated auth stay on your
  machine. No telemetry, no push, no credential vault.
- **Truthful model identity** — *requested*, *configured*, and *runtime-reported* models
  are distinct facts. If a harness doesn't report its model, moh says exactly
  `Effective model: Not reported by harness` instead of guessing.
- **Harness-neutral core** — seats are generic; vendor names never appear in the state
  machine. Two profiles of the *same* harness can occupy both seats.
- **Safe by default** — `shell:false` argv spawning, minimal child environments,
  schema-validated reviews that repository text cannot forge, and exact-tree result
  branches with a deterministic receipt.

## Quickstart

```bash
# 1. Install (zero runtime dependencies)
npm install

# 2. Try the deterministic, zero-token demo (no accounts, no network)
node bin/moh.mjs demo

# 3. Check which harnesses are ready (offline; spends no tokens)
node bin/moh.mjs doctor

# 4. See all commands
node bin/moh.mjs --help
```

Installed globally (`npm install -g mixture-of-harnesses`) the same commands are just
`moh demo`, `moh doctor`, `moh --help`.

The demo runs the full workflow — generate → cross-critique → leader choice →
integrate → structured review → local result branch — with a deterministic **fake
harness**, and prints per-seat provenance (including one seat that reports its model and
one that honestly does not).

### Use your own Claude and Codex accounts

The browser companion delegates authorization to the official local CLIs. There are no
password, OAuth-token, or API-key inputs in the browser. Sign in once from your terminal,
then choose **Refresh status** in `moh web`:

```bash
claude auth login
claude auth status --json

codex login
codex login status
```

Claude uses its native login by default. For automation, you can instead select either
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; moh checks and forwards only the
selected variable to Claude Code. The value stays in the process environment and is
never entered in the browser or saved by moh.

Codex reuses the official CLI session: `codex login` uses ChatGPT OAuth by default and
can also store an API-key login. If the installed CLI supports `--profile`, a seat may
select a named profile from your local Codex configuration; moh passes the profile name
to the CLI without reading its credentials.

Every run keeps these model facts separate:

- **Requested** — the exact model selected for the seat, or the explicit choice to use
  the harness default.
- **Configured** — the model reported by an offline CLI/config probe, when the harness
  exposes one. This does not prove what ran.
- **Runtime-reported** — the model identity emitted by the harness during the turn,
  stored with its evidence source. This is the effective-model evidence.

Catalog verification is recorded separately from all three. Only an entry returned by a
fresh local CLI catalog is eligible for **Latest frontier**. The current Codex CLI cannot
return a profile-scoped catalog, so moh disables latest-frontier and custom-reasoning
claims when a Codex profile is selected. Use a pinned model or the profile's default and
verify the runtime report. If a harness exposes no usable catalog or runtime model,
moh says so instead of guessing.

### Run history and interrupted work

`moh web` reads run state and events from durable local storage. Its run-history picker
can reopen earlier runs, and a browser refresh can reconstruct the selected run without
starting another harness turn. Existing repository-local Council runs also appear as
clearly labeled, read-only history; their model and review evidence remains unattested
rather than being reconstructed. When the web server starts, any run left marked as
running is finalized as **failed — interrupted**; moh never silently repeats paid work.
The run record and workspaces remain available for inspection and an explicit retry or
resume.

## Commands

| Command | Purpose |
| --- | --- |
| `moh` | Launch the TUI (guided setup on first use) |
| `moh setup` | Configure two seats, harnesses, and defaults |
| `moh doctor [--json]` | Offline harness diagnostics (no tokens spent) |
| `moh adapters` | List adapters and capabilities |
| `moh run [opts]` | Run a task (`--task`, `--task-file`, `--stdin`, `--json`, `--yes`) |
| `moh demo` | Deterministic zero-token end-to-end demo |
| `moh web [--port N]` | Loopback browser companion |
| `moh runs` | List past runs |
| `moh inspect <run-id>` | Show a run record + provenance |
| `moh resume <run-id>` | Safely inspect/retry an interrupted run |
| `moh export <run-id>` | Privacy-safe report (`--format md|json`) |

### Two workflow presets

- **Full Mixture** — generate, cross-critique, leader integration, final review,
  revision, local result.
- **Quick Compare** — two independent solutions, human selection, review, local result
  (fewer harness invocations).

## Harnesses

`moh doctor` reports each harness as **Ready / Needs login / Missing / Experimental /
Blocked / Unavailable**. Built-in adapters: **Claude Code** and **Codex CLI** (production
adapters), plus honest **OpenClaw** and **Hermes** states. See
[docs/ADAPTERS.md](docs/ADAPTERS.md) for the capability matrix and
[docs/PROTOCOL.md](docs/PROTOCOL.md) to add your own harness without editing the core.

## Security & privacy

moh binds the web UI to `127.0.0.1` with a per-launch capability cookie, validates
Host/Origin, forbids permissive CORS, and never puts secrets in URLs, storage, HTML, or
events. It stores only **non-secret auth labels** (e.g. `ANTHROPIC_API_KEY present`),
never secret values. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm run check              # syntax-check all sources (zero-dep "lint")
node --test 'test/*.test.mjs'   # unit + integration + security + web tests
npm run demo               # end-to-end smoke
```

All tests use the fake harness and temporary repos — **CI never calls a real model or
requires credentials.** See [CONTRIBUTING.md](CONTRIBUTING.md) and
[ARCHITECTURE.md](ARCHITECTURE.md).

## Platform support

macOS and Linux are the supported platforms. The portable core is exercised on Windows
in CI, but native harness support (process-tree cancellation, paths, the CLIs) is not
claimed there yet.

## License

[MIT](LICENSE) © 2026 Zach Bird.
