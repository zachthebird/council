import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExternalAdapter, externalParseEvents } from '../src/adapters/external.mjs';
import { prepareWorkspace } from '../src/git/workspace.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, 'examples', 'example-adapter', 'moh-adapter.json');

test('external adapters require explicit opt-in', () => {
  delete process.env.MOH_ALLOW_EXTERNAL_ADAPTERS;
  assert.throws(() => loadExternalAdapter(manifest), /explicitly/);
});

test('external protocol parser tolerates fragmentation and unknown types', () => {
  const lines = [
    JSON.stringify({ type: 'ready', capabilities: {} }),
    JSON.stringify({ type: 'model', reportedModel: 'm', evidenceSource: 'x' }),
    JSON.stringify({ type: 'future_unknown', a: 1 }),
    'garbage',
    JSON.stringify({ type: 'final', finalText: 'done 世界', sessionId: 's' }),
  ].join('\n') + '\n';
  const state = {};
  const bytes = Buffer.from(lines, 'utf8');
  const events = [];
  // char-safe feeding is the supervisor's job; feed whole here
  for (const e of externalParseEvents(bytes.toString('utf8'), state)) events.push(e);
  assert.equal(state.finalText, 'done 世界');
  assert.ok(events.some((e) => e.kind === 'model'));
});

test('example external adapter runs a real turn through the contract (opt-in)', async () => {
  const adapter = loadExternalAdapter(manifest, { trust: true });
  const dir = mkdtempSync(join(tmpdir(), 'moh-ext-'));
  const ws = join(dir, 'ws');
  prepareWorkspace(ws, { kind: 'greenfield' });
  const events = [];
  const result = await adapter.runTurn(
    { seatId: 'seat-a', seatLabel: 'Seat A', role: 'generate', prompt: 'do a thing', workspaceDir: ws, limits: {} },
    { onEvent: (e) => events.push(e) }
  );
  assert.equal(result.status, 'ok');
  assert.match(result.finalText, /example adapter completed/);
  assert.ok(existsSync(join(ws, 'EXAMPLE_ADAPTER_OUTPUT.md')), 'adapter wrote into the isolated workspace');
  const model = events.find((e) => e.kind === 'model');
  assert.equal(model.payload.reportedModel, 'example-adapter-model-1');
});
