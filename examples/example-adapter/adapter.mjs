#!/usr/bin/env node
// Example external harness adapter for Mixture of Harnesses.
// Protocol: read ONE JSON turn request on stdin, emit normalized events as JSONL
// on stdout, then exit. This example is deterministic and makes no network calls;
// it exists to demonstrate the contract and pass the conformance test.
// See docs/PROTOCOL.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
let msg;
try {
  msg = JSON.parse(raw.trim().split('\n').pop() || '{}');
} catch {
  emit({ type: 'final', finalText: '', sessionId: null });
  process.exit(0);
}

const turn = msg.turn || {};
// 1) Announce readiness + capabilities.
emit({ type: 'ready', capabilities: { structured_streaming: 'supported', runtime_model_observation: 'supported', explicit_model_selection: 'supported', workspace_isolation: 'supported' } });
// 2) Report the model we are (honestly) running.
emit({ type: 'model', reportedModel: 'example-adapter-model-1', evidenceSource: 'example.ready' });

// 3) Do the work: for author roles, write a real file into the isolated workspace.
if (turn.workspaceDir && (turn.role === 'generate' || turn.role === 'integrate' || turn.role === 'revise')) {
  const p = join(turn.workspaceDir, 'EXAMPLE_ADAPTER_OUTPUT.md');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `# Example adapter\n\nrole: ${turn.role}\nseat: ${turn.seatId}\n`);
  emit({ type: 'tool', name: 'write_file', summary: 'EXAMPLE_ADAPTER_OUTPUT.md' });
}

emit({ type: 'text', text: `example adapter handled role=${turn.role}` });
emit({ type: 'final', finalText: `example adapter completed role=${turn.role}`, sessionId: `example-${turn.seatId || 'seat'}` });
