import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeParseEvents } from '../src/adapters/fake.mjs';
import { claudeParseEvents, claudeCodeAdapter, claudeAuthEnvNames } from '../src/adapters/claude-code.mjs';
import { codexParseEvents, codexCliAdapter, sanitizeCodexModelCatalog } from '../src/adapters/codex-cli.mjs';
import { listAdapters, getAdapter } from '../src/adapters/registry.mjs';
import { assertAdapterShape } from '../src/adapters/contract.mjs';
import { StringDecoder } from 'node:string_decoder';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/cli/doctor.mjs';

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

function fakeCli(source) {
  const dir = mkdtempSync(join(tmpdir(), 'moh-adapter-cli-'));
  const file = join(dir, 'cli');
  writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    JSON.stringify({ type: 'result', subtype: 'success', result: 'final ✓', session_id: 'abc', usage: { input_tokens: 1 }, modelUsage: { 'claude-x-2026': {}, 'claude-review-2026': {} } }),
  ].join('\n') + '\n';
  const { events, state } = feedFragmented(claudeParseEvents, lines, 4);
  assert.equal(state.sessionId, 'abc');
  assert.equal(state.finalText, 'final ✓');
  const models = events.filter((e) => e.kind === 'model').map((e) => e.payload.reportedModel);
  assert.ok(models.includes('claude-x'));
  assert.ok(!models.includes('claude-x-2026'), 'aggregate modelUsage does not overwrite primary-model evidence');
  assert.ok(!models.includes('claude-review-2026'), 'auxiliary aggregate keys are not treated as chronological fallbacks');
  assert.equal(state.reportedModel, 'claude-x', 'the explicit runtime model remains effective');
});

test('Claude result uses a single modelUsage key only as an unambiguous fallback', () => {
  const line = JSON.stringify({ type: 'result', result: 'done', modelUsage: { 'claude-only-2026': {} } }) + '\n';
  const { events, state } = feedFragmented(claudeParseEvents, line, 5);
  assert.deepEqual(events.filter((event) => event.kind === 'model').map((event) => event.payload.reportedModel), ['claude-only-2026']);
  assert.equal(state.reportedModel, 'claude-only-2026');
});

test('Claude auth modes forward only the selected fixed auth variable', () => {
  assert.deepEqual(claudeAuthEnvNames({}), []);
  assert.deepEqual(claudeAuthEnvNames({ authMode: 'native' }), []);
  assert.deepEqual(claudeAuthEnvNames({ authMode: 'api-key-env' }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(claudeAuthEnvNames({ authMode: 'oauth-token-env' }), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(claudeAuthEnvNames({ authMode: 'native', authEnvNames: ['ANTHROPIC_API_KEY'] }), []);
  assert.deepEqual(claudeAuthEnvNames({ authMode: 'api-key-env', authEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'] }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(claudeAuthEnvNames({ authEnvNames: ['ANTHROPIC_API_KEY'] }), ['ANTHROPIC_API_KEY'], 'legacy fixed-name config still migrates');
  assert.deepEqual(claudeAuthEnvNames({ authEnvNames: ['AWS_SECRET_ACCESS_KEY', 'CUSTOM_AUTH_TOKEN'] }), []);
});

test('Claude readiness uses official JSON status while discarding account identifiers and secrets', async () => {
  const cli = fakeCli(`
const args = process.argv.slice(2).join(' ');
if (args === 'auth status --json') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'private@example.com', organizationId: 'org-private', token: ['sk-ant', '12345678901234567890'].join('-') }));
  process.exit(0);
}
if (args === '--version') process.stdout.write('2.1.999');
`);
  const old = process.env.MOH_CLAUDE_PATH;
  process.env.MOH_CLAUDE_PATH = cli.file;
  try {
    const readiness = await claudeCodeAdapter.probeReadiness();
    assert.equal(readiness.readiness, 'ready');
    assert.match(readiness.authLabel, /native login/i);
    const serialized = JSON.stringify(readiness);
    assert.doesNotMatch(serialized, /private@example|org-private|sk-ant-/);
    const invocation = claudeCodeAdapter.prepareInvocation({ authMode: 'native', authEnvNames: ['AWS_SECRET_ACCESS_KEY'], sandbox: 'read-only' });
    assert.deepEqual(invocation.authEnvNames, []);
    assert.deepEqual(invocation.argv.slice(0, 6), ['--print', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local']);
    assert.equal(claudeCodeAdapter.capabilities().sandbox_controls, 'unknown');
  } finally {
    if (old === undefined) delete process.env.MOH_CLAUDE_PATH;
    else process.env.MOH_CLAUDE_PATH = old;
    cli.cleanup();
  }
});

test('Codex catalog exposes only safe fields and requires an explicit latest-frontier description', () => {
  const models = sanitizeCodexModelCatalog({ models: [
    {
      slug: 'gpt-latest',
      display_name: 'GPT Latest',
      description: 'Latest frontier agentic coding model.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low', description: 'safe' }, { effort: 'high' }],
      account_id: 'acct-private',
      base_instructions: 'do not expose',
      api_key: ['sk', '12345678901234567890'].join('-'),
    },
    { slug: 'gpt-older', display_name: 'GPT Older', description: 'Frontier model for complex coding.', supported_reasoning_levels: ['medium'] },
  ] });
  assert.deepEqual(Object.keys(models[0]), ['slug', 'displayName', 'description', 'frontier', 'defaultReasoningEffort', 'supportedReasoningEfforts']);
  assert.equal(models[0].frontier, true);
  assert.equal(models[1].frontier, false);
  assert.deepEqual(models[0].supportedReasoningEfforts, ['low', 'high']);
  assert.doesNotMatch(JSON.stringify(models), /acct-private|do not expose|sk-/);
});

test('Codex readiness, offline model discovery, and doctor return sanitized official metadata', async () => {
const cli = fakeCli(`
const args = process.argv.slice(2).join(' ');
if (args === '--help') process.stdout.write('Commands: exec debug login\\n-p, --profile <CONFIG_PROFILE>');
else if (args === 'exec --help') process.stdout.write('--json --model --profile --sandbox');
else if (args === 'debug models --help') process.stdout.write('Render the raw model catalog as JSON\\n--bundled');
else if (args === 'login status') process.stdout.write('Logged in using ChatGPT as private@example.com');
else if (args === 'debug models --bundled') process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-safe', display_name: 'GPT Safe', description: 'Latest frontier coding model.', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], account_id: 'acct-private' }] }));
else if (args === 'debug models') process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-refreshed', display_name: 'GPT Refreshed', description: 'Latest frontier coding model.', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] }] }));
else if (args === '--version') process.stdout.write('codex-cli 9.9.9');
`);
  const old = process.env.MOH_CODEX_PATH;
  process.env.MOH_CODEX_PATH = cli.file;
  try {
    const readiness = await codexCliAdapter.probeReadiness();
    assert.equal(readiness.readiness, 'ready');
    assert.doesNotMatch(JSON.stringify(readiness), /private@example/);
    const catalog = await codexCliAdapter.discoverModels();
    assert.equal(catalog.source, 'codex debug models (bundled)');
    assert.ok(!Number.isNaN(Date.parse(catalog.checkedAt)));
    assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ['low', 'medium']);
    assert.doesNotMatch(JSON.stringify(catalog), /acct-private/);
    const refreshed = await codexCliAdapter.discoverModels({ refresh: true });
    assert.equal(refreshed.source, 'codex debug models (refreshed)');
    assert.equal(refreshed.models[0].slug, 'gpt-refreshed');
    await assert.rejects(
      codexCliAdapter.discoverModels({ refresh: true, profile: 'work' }),
      /does not support profile-scoped `debug models`/,
    );

    const report = await doctor();
    const codex = report.adapters.find((adapter) => adapter.id === 'codex-cli');
    assert.equal(codex.path, realpathSync(cli.file));
    assert.equal(codex.capabilities.model_discovery, 'supported');
    assert.equal(codex.modelCatalog.models[0].slug, 'gpt-safe');
    assert.doesNotMatch(JSON.stringify(codex), /private@example|acct-private/);
  } finally {
    if (old === undefined) delete process.env.MOH_CODEX_PATH;
    else process.env.MOH_CODEX_PATH = old;
    cli.cleanup();
  }
});

test('Codex forwards requested effort as one TOML config argv value and rejects unsupported CLIs', async () => {
  const supported = fakeCli(`
const args = process.argv.slice(2).join(' ');
if (args === '--help') process.stdout.write('Commands: exec\\n-p, --profile <CONFIG_PROFILE>');
else if (args === 'exec --help') process.stdout.write('--json -c, --config <key=value>');
`);
const unsupported = fakeCli(`
const args = process.argv.slice(2).join(' ');
if (args === '--help') process.stdout.write('Commands: exec');
else if (args === 'exec --help') process.stdout.write('--json');
`);
  const old = process.env.MOH_CODEX_PATH;
  try {
    process.env.MOH_CODEX_PATH = supported.file;
    const invocation = codexCliAdapter.prepareInvocation({ profile: 'work', requestedEffort: 'xhigh' });
    assert.deepEqual(invocation.argv, [
      '--profile',
      'work',
      'exec',
      '--json',
      '--config',
      'model_reasoning_effort="xhigh"',
    ]);
    assert.ok(Array.isArray(invocation.argv), 'invocation remains executable + argv, never a shell command');

    const quoted = codexCliAdapter.prepareInvocation({ requestedEffort: 'high"; sandbox_mode="danger-full-access' });
    assert.equal(quoted.argv.at(-1), 'model_reasoning_effort="high\\\"; sandbox_mode=\\\"danger-full-access"');
    assert.equal(quoted.argv.filter((arg) => arg === '--config').length, 1);

    process.env.MOH_CODEX_PATH = unsupported.file;
    assert.throws(
      () => codexCliAdapter.prepareInvocation({ requestedEffort: 'high' }),
      /lacks `--config`\/`-c` support; cannot honor requested reasoning effort/,
    );
    assert.doesNotThrow(() => codexCliAdapter.prepareInvocation({}), 'old CLIs remain usable when no effort was requested');
    assert.throws(
      () => codexCliAdapter.prepareInvocation({ profile: 'work' }),
      /lacks global `--profile` support; cannot honor requested profile/,
    );
    assert.throws(
      () => codexCliAdapter.prepareInvocation({ requestedModel: 'gpt-5.6' }),
      /lacks `--model` support; cannot honor requested model/,
    );
    await assert.rejects(
      codexCliAdapter.discoverModels({ refresh: true, profile: 'work' }),
      /does not support profile-scoped `debug models`/,
    );
  } finally {
    if (old === undefined) delete process.env.MOH_CODEX_PATH;
    else process.env.MOH_CODEX_PATH = old;
    supported.cleanup();
    unsupported.cleanup();
  }
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
