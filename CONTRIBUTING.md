# Contributing to Mixture of Harnesses

Thanks for your interest in improving **Mixture of Harnesses** (`moh`). This is
a local-first, zero-runtime-dependency project, and contributions of all sizes
are welcome: bug reports, documentation, adapters, and core improvements.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md). By participating you
agree to uphold it.

## Ground rules

A few non-negotiable principles shape every contribution:

- **No network model calls in tests.** Tests must never call a real model, hit a
  paid API, or require login. Use the fake harnesses and temporary repositories
  provided by the test helpers.
- **No credentials, ever.** The project does not capture, store, or transmit
  credentials, and contributions must not add code that does. Do not commit
  secrets, tokens, or `.env` files.
- **Never push, never open PRs on the user's behalf.** `moh` creates traceable
  **local** git result branches only. It never pushes to a remote and never
  opens a pull request for the user.
- **Zero runtime dependencies.** The published package has no runtime npm
  dependencies. Please do not add any. Development-only tooling is limited and
  should be justified.
- **Keep capability claims honest.** Do not describe features as
  "production-ready", "verified", or "secure" without a concrete qualification.

## Development setup

Requirements: **Node.js >= 22.12**. macOS and Linux are the actively exercised
platforms. (Windows core logic runs in CI, but native harness support is not
claimed.)

```sh
# Clone your fork, then:
npm install        # installs nothing at runtime; there are no runtime deps
npm test           # runs: node --test 'test/*.test.mjs'
npm run check      # syntax / static checks
npm run demo       # deterministic, zero-token local demo
```

- `npm test` runs the Node built-in test runner over `test/*.test.mjs`.
- `npm run check` verifies that source files parse and pass static checks
  without executing any harness.
- `npm run demo` runs the deterministic demo end-to-end using fake harnesses.
  It consumes no tokens and needs no credentials, and is the fastest way to see
  the full flow.

## Writing tests

- All tests must use **fake harnesses** and **temporary repositories**. Never
  invoke a real model, real CLI harness, or anything requiring authentication.
- Prefer deterministic fixtures. Randomness that affects assertions should be
  seeded or removed.
- Add or update tests for any behavior change. New behavior without a test that
  exercises it will generally not be merged.

## Proposing a new harness adapter

Adapters connect an external coding harness (e.g. Claude Code, Codex CLI) to the
generic seat/adapter contract.

1. Read [`docs/ADAPTERS.md`](docs/ADAPTERS.md) for the adapter contract, the
   capability model, and how adapters report runtime model provenance and
   sandbox/approval controls.
2. Read [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the wire protocol, structured
   review schema, and nonce-bound anchored records.
3. Open an **Adapter request** issue (to gauge interest / discuss the harness's
   headless interface) or an **Adapter proposal** issue (if you intend to build
   it), using the provided issue templates.
4. Include a conformance test plan using fake I/O — no real model calls.

## Commit and pull request expectations

- Keep commits focused and write clear messages explaining the *why*.
- Before opening a PR, ensure the following pass locally:
  - `npm run check`
  - `node --test 'test/*.test.mjs'`
- Fill out the pull request template, including the honesty and no-secrets
  checklist items.
- Update relevant docs (including `CHANGELOG.md`) when behavior or interfaces
  change.
- Small, reviewable PRs are strongly preferred over large ones.

## Reporting bugs and requesting features

Use the GitHub issue templates:

- **Bug report** — include redacted `moh doctor` output, steps to reproduce, and
  OS / Node / harness versions.
- **Adapter request** / **Adapter proposal** — for harness support.

## Security

If you believe you have found a security-sensitive issue, please contact the
owner directly at **zachthebird@gmail.com** rather than opening a public issue.

Thank you for helping make `moh` better.
