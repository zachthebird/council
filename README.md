# Council

One prompt, two frontier coding agents, one peer-reviewed result.

Council runs a single prompt through **Claude** (headless Claude Code) and
**Codex** (headless `codex exec`) independently and in parallel, streaming both
agents' work live into a two-pane GUI. When both finish, the council stages
begin:

1. **Generate** — both agents build a complete solution in isolated git
   workspaces, exactly as they normally would.
2. **Cross-critique** — each agent receives the counterpart's full code and
   evaluates it relative to its own: strengths to adopt, missteps to avoid,
   honest comparison. Sessions are *resumed*, so each critic still remembers
   why it made its own choices.
3. **Pick leader** — you (the human) read both critiques and choose which
   solution leads.
4. **Leader integrates** — the leader works in the counterpart's strengths and
   addresses every weakness found in its own solution.
5. **Final review** — the counterpart reviews the finalized code and answers
   `APPROVE` or `REQUEST_CHANGES`. You can send it back for revision rounds.
6. **Publish** — the winning tree is committed to a `council/<run-id>` branch.

## Run

```bash
node server.mjs        # http://127.0.0.1:4700
```

Requirements: Node >= 22.12, `claude` CLI on PATH (logged in), Codex installed
(the app-bundled CLI is found automatically; override with
`COUNCIL_CODEX_BIN`). No API keys and no GitHub — everything is local.

Environment overrides: `COUNCIL_PORT`, `COUNCIL_CLAUDE_BIN`,
`COUNCIL_CODEX_BIN`.

## Notes

- Each run lives in `runs/<id>/` with one git workspace per agent plus an
  `events.jsonl` replay log; refreshing the GUI reattaches to the latest run.
- Greenfield by default; pass a **seed repo** path in the GUI to run the
  council against an existing repository (each agent gets its own clone).
- Sandboxing is asymmetric in v0: Codex runs under its `workspace-write`
  sandbox; Claude runs with permission checks skipped inside its workspace.
  Keep prompts trustworthy.
- Cost: a council run is roughly 4–8× a single agent run (two generations,
  two critiques, integration, final review). Use it on problems that earn it.
