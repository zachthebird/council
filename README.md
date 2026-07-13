# Council

One prompt, two frontier coding agents, one peer-reviewed result.

Council runs a single prompt through **Claude** (headless Claude Code) and
**Codex** (headless `codex exec`) independently and in parallel, streaming both
agents' work live into a two-pane GUI. When both finish, the council convenes:

1. **Generate** — both agents build a complete solution in isolated git
   workspaces, exactly as they normally would.
2. **Cross-critique** — each agent receives the counterpart's full code and
   evaluates it relative to its own: strengths to adopt, missteps to avoid,
   honest comparison. Sessions are *resumed*, so each critic still remembers
   why it made its own choices.
3. **Pick leader** — you (the human) read both critiques side by side and
   choose which solution leads.
4. **Leader integrates** — the leader receives both critiques plus the
   counterpart's complete code, works in the genuine strengths, and addresses
   every legitimate weakness found in its own solution.
5. **Final review** — the counterpart reviews the finalized code. The verdict
   is fail-closed: `APPROVE` requires an explicit marker; ambiguity is
   `UNCLEAR`, a failed review is `REVIEW_FAILED` (retryable without touching
   the leader's work), and `REQUEST_CHANGES` can be sent back for revision
   rounds — the human decides when to stop.
6. **Publish** — the winning tree is committed to a `council/<run-id>` branch.
   For local seed repos the branch is also fetched back into your repository.

In its first real outing, the final-review stage caught a secret-leaking
argparse behavior in code both models had individually missed — the
cross-examination is the product.

## Run

```bash
node server.mjs        # http://127.0.0.1:4700
```

Type a prompt and go. **Greenfield by default**; to run the council against an
existing codebase, put a **local path or a git clone URL** in the seed field —
each agent gets its own clone. URL seeds never push anywhere: results stay in
the local run workspace.

Requirements: Node >= 22.12, `claude` CLI on PATH and logged in (`claude`
then `/login`, one time), Codex installed (the app-bundled CLI is found
automatically). No API keys required — both agents use your existing
subscriptions. Everything runs locally.

## Controls and safety rails

- **Cancel** any running stage from the GUI; agent processes are terminated.
- Every agent turn has a hard timeout (`COUNCIL_TURN_TIMEOUT_MS`, default 30
  minutes).
- If one agent fails, the run degrades to a clearly-labeled **UNREVIEWED**
  sole-survivor result instead of dying — the publish gate says so.
- Runs live in `runs/<id>/` (one git workspace per agent + a replayable event
  log) and survive server restarts; runs interrupted mid-turn are marked, not
  resurrected.
- Sandboxing is asymmetric: Codex runs under its `workspace-write` sandbox
  (no network); Claude runs with permission checks skipped inside its
  workspace. Keep prompts trustworthy.

Environment overrides: `COUNCIL_PORT`, `COUNCIL_CLAUDE_BIN`,
`COUNCIL_CODEX_BIN`, `COUNCIL_TURN_TIMEOUT_MS`.

## Testing without burning tokens

`test/fake-claude.mjs` is a deterministic stand-in for the Claude CLI
(`COUNCIL_CLAUDE_BIN=$PWD/test/fake-claude.mjs node server.mjs`), and
`test/drive.mjs "<prompt>" <leader>` drives a full cycle through the API.

## Cost and when to use it

A council run is roughly 4–8× a single agent run (two generations, two
critiques, integration, final review) and takes minutes, not seconds. Spend it
on problems that earn it; skip it for routine edits.

## Roadmap

- **Verify stage**: N blind evaluators that see only the prompt and the final
  code (never the discussion), must execute the tests, and feed a fix loop.
- Diff-based exchange for seed repos (spend the exchange budget on changes,
  not unchanged files).
- Run picker in the GUI; equalized network policy between the two agents.
