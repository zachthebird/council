import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeParseEvents } from '../src/adapters/fake.mjs';
import { claudeParseEvents } from '../src/adapters/claude-code.mjs';
import { codexParseEvents } from '../src/adapters/codex-cli.mjs';
import { listAdapters, getAdapter } from '../src/adapters/registry.mjs';
import { assertAdapterShape } from '../src/adapters/contract.mjs';
import { StringDecoder } from 'node:string_decoder';

// gate 11: the real pipeline is supervisor(StringDecoder) -> parser. This models
// fragmented UTF-8 byte chunks flowing through that exact pipeline.
function feedFragmented(parser, text, chunkBytes = 3) {
  const bytes = Buffer.from(text, 'utf8');
  const dec = new StringDecoder('utf8');
  const state = {};
  const events = [];
  for (let i = 0; i < bytes.length; i += chunkBytes) {
    const s = dec.write(bytes.subarray(i, i + chunkBytes)); // byte-safe
    if (s) for (const e of parser(s, state)) events.push(e);
  }
  const tail = dec.end();
  if (tail) for (const e of parser(tail, state)) events.push(e);
  return { events, state };
}

test('gate 11: fake parser handles fragmented multibyte + unknown fields + malformed lines', () => {
  const lines = [
    JSON.stringify({ t: 'init', session: 's1', model: 'm1', futureField: 42 }),
    'this is not json',
    JSON.stringify({ t: 'text', chunk: 'héllo — 世界 🌍', unknown: true }),
    JSON.stringify({ t: 'weird_unknown_type', anything: 1 }),
    JSON.stringify({ t: 'final', text: 'done 世界', session: 's1', model: 'm1' }),
  ].join('\n') + '\n';
  const { events, state } = feedFragmented(fakeParseEvents, lines, 2);
  const text = events.filter((e) => e.kind === 'text').map((e) => e.payload.text).join('');
  assert.match(text, /héllo — 世界 🌍/);
  assert.equal(state.finalText, 'done 世界');
  assert.ok(events.some((e) => e.kind === 'final'));
});

test('gate 11: claude stream-json parser tolerates fragmentation and unknown types', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-x', extra: {} }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial 世界' }], model: 'claude-x' } }),
    JSON.stringify({ type: 'some_future_type', data: 1 }),
    'garbage line',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'final ✓', session_id: 'abc', usage: { input_tokens: 1 }, modelUsage: { 'claude-x-2026': {} } }),
  ].join('\n') + '\n';
  const { events, state } = feedFragmented(claudeParseEvents, lines, 4);
  assert.equal(state.sessionId, 'abc');
  assert.equal(state.finalText, 'final ✓');
  const models = events.filter((e) => e.kind === 'model').map((e) => e.payload.reportedModel);
  assert.ok(models.includes('claude-x'));
  assert.ok(models.includes('claude-x-2026'), 'modelUsage yields a reported model');
});

test('gate 11: codex parser never throws on unknown/garbled shapes', () => {
  const lines = [
    JSON.stringify({ msg: { type: 'agent_message', text: 'hi 世界' }, thread_id: 't1' }),
    'not-json',
    JSON.stringify({ type: 'turn.completed' }),
    JSON.stringify({ random: true }),
  ].join('\n') + '\n';
  const { events, state } = feedFragmented(codexParseEvents, lines, 5);
  assert.equal(state.sessionId, 't1');
  assert.ok(Array.isArray(events));
});

test('gate 9: all builtin adapters satisfy the contract shape', () => {
  for (const a of listAdapters()) {
    assert.doesNotThrow(() => assertAdapterShape(a), `${a.id} shape`);
    assert.ok(a.capabilities(), `${a.id} capabilities`);
  }
});

test('gate 10: OpenClaw/Hermes never fabricate supported capabilities; refuse invocation', () => {
  for (const id of ['openclaw', 'hermes']) {
    const a = getAdapter(id);
    const caps = a.capabilities();
    for (const v of Object.values(caps)) assert.notEqual(v, 'supported', `${id} must not claim supported`);
    assert.throws(() => a.prepareInvocation({}), `${id} refuses to invoke`);
  }
});
