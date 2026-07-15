# External-adapter protocol (v1)

Add a harness to Mixture of Harnesses **without editing the orchestrator** by shipping an
executable that speaks this versioned JSONL-over-stdio protocol, plus a manifest.
`EXTERNAL_PROTOCOL_VERSION = 1`.

> **Trust boundary.** Enabling an external adapter runs local third-party code inside your
> environment. It is **off by default** and requires explicit opt-in:
> `MOH_ALLOW_EXTERNAL_ADAPTERS=1` (or `loadExternalAdapter(path, { trust: true })`).

## Manifest (`moh-adapter.json`)

```json
{
  "protocol": 1,
  "id": "example-external",
  "displayName": "Example External Adapter",
  "version": "1.0.0",
  "executable": "./adapter.mjs",
  "argv": [],
  "trustLevel": "third_party",
  "authEnvNames": [],
  "capabilities": {
    "structured_streaming": "supported",
    "runtime_model_observation": "supported",
    "explicit_model_selection": "supported",
    "workspace_isolation": "supported"
  }
}
```

`executable` is resolved relative to the manifest and real-path resolved. `argv` elements
are passed literally (spawned with `shell:false`). `authEnvNames` lists env var **names**
(never values) the adapter may inherit.

## Wire format

moh spawns the executable and writes **one** JSON turn request to **stdin**:

```json
{ "moh": "1", "type": "turn",
  "turn": { "seatId": "seat-a", "role": "generate",
            "prompt": "…", "workspaceDir": "/abs/path",
            "requestedModel": null, "requestedEffort": null } }
```

`role` is one of `generate | critique | integrate | review | revise`. For author roles
(`generate`, `integrate`, `revise`) the adapter writes real files into `workspaceDir`.

The adapter emits **JSONL** on **stdout**, one object per line:

| Line | Meaning |
| --- | --- |
| `{"type":"ready","capabilities":{…}}` | Announce readiness / negotiated capabilities. |
| `{"type":"model","reportedModel":"…","evidenceSource":"…","usage":{…}}` | Runtime-reported model (honest evidence only). |
| `{"type":"text","text":"…"}` | Incremental assistant text. |
| `{"type":"tool","name":"…","summary":"…"}` | A tool/action the harness took. |
| `{"type":"notice","level":"info|warn|error","message":"…"}` | Diagnostic. |
| `{"type":"final","finalText":"…","sessionId":"…"}` | Final output + session/thread id. |

Rules:

- Emit exactly one `final`. Its `finalText` becomes the seat's turn output.
- For **review** roles, put the verdict inside `finalText` using the nonce-bound anchored
  record moh provides in the review prompt (see `src/core/review.mjs`). Do **not** rely on
  a `verdict` field — moh only trusts the anchored record.
- Unknown line `type`s and unknown fields are ignored (forward-compatible).
- moh supervises the process: bounded output/runtime, byte-safe decoding, and
  process-tree cancellation. Exit 0 on success.

## Registering with moh

Register an external adapter through the CLI or the public API, then use it like any
built-in adapter (`moh run --seat-a <id>`):

```bash
# CLI — persists the manifest to config and registers it (opt-in).
moh adapters add ./examples/example-adapter/moh-adapter.json --trust
MOH_ALLOW_EXTERNAL_ADAPTERS=1 moh adapters      # now lists example-external
MOH_ALLOW_EXTERNAL_ADAPTERS=1 moh run --seat-a example-external --seat-b fake --task "..." --yes
```

```js
// Public API (from the package root export).
import { registerExternalAdapter, Application } from 'mixture-of-harnesses';
registerExternalAdapter('/abs/path/moh-adapter.json', { trust: true });
```

Configured adapters listed under `externalAdapters` in `config.json` are loaded at CLI
startup when `MOH_ALLOW_EXTERNAL_ADAPTERS=1` (or `trustExternal: true` in config).

## Conformance

`examples/example-adapter/` is a complete, deterministic reference adapter. The
conformance test (`test/external.test.mjs`) verifies opt-in enforcement, fragmentation-
and unknown-field tolerance, and a real turn that writes into an isolated workspace and
reports a model. Run it with `node --test test/external.test.mjs`.
