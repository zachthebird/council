---
name: Adapter proposal
about: Propose to contribute an adapter for a new harness
title: "Adapter proposal: <harness name>"
labels: adapter, proposal
assignees: ""
---

Thanks for offering to build an adapter! Before starting, please read
[`docs/ADAPTERS.md`](../../docs/ADAPTERS.md) and
[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md).

## Harness

- Name:
- Install / docs links:

## Capabilities this adapter will support

Check all that this adapter will implement, and add notes on partial support:

- [ ] Structured streaming (incremental structured output)
- [ ] Native resume (continue a prior session)
- [ ] Explicit model selection (caller can choose the model)
- [ ] Runtime model observation (adapter reports the model that actually ran)
- [ ] Sandbox controls (restrict file/network/command access)
- [ ] Approval controls (gate actions behind approval)
- [ ] Other (describe):

Notes on partial or best-effort capabilities:

<!-- e.g. "model selection works, but the harness does not confirm the model." -->

## Trust level

<!--
How much do you trust this harness's isolation and its self-reported metadata?
Describe what the adapter can and cannot guarantee (e.g. whether sandbox claims
are enforced by the harness or merely requested).
-->

## Conformance test plan

<!--
Describe how you will test the adapter using fake I/O only.
Tests must NOT make real model calls or require credentials.
-->

- Fake-harness fixtures for:
  - [ ] Normal completion
  - [ ] Structured review output (schema-valid)
  - [ ] Error / non-zero exit handling
  - [ ] Model provenance reporting (or explicit "unknown")
- Temp-repo based end-to-end test: yes / no
- Other cases:

## Additional context

<!-- Anything else reviewers should know. -->
