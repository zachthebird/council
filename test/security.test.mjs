import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildChildEnv } from '../src/process/env-policy.mjs';
import { redact, redactDeep, sanitizeGitUrl, stripControl } from '../src/security/redact.mjs';
import { DEFAULT_LIMITS, runProcess } from '../src/process/supervisor.mjs';

test('default turn timeout permits thorough repository work while retaining a finite hang guard', () => {
  assert.equal(DEFAULT_LIMITS.timeoutMs, 90 * 60 * 1000);
});

test('gate 16: child env contains only base + intended auth references', () => {
  process.env.SECRET_UNRELATED = 'do-not-forward';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-shouldforward';
  const { env, forwarded } = buildChildEnv({ authEnvNames: ['ANTHROPIC_API_KEY'] });
  assert.equal(env.SECRET_UNRELATED, undefined, 'unrelated var must not be forwarded');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-shouldforward');
  assert.deepEqual(forwarded, ['ANTHROPIC_API_KEY']);
  assert.ok(env.PATH, 'PATH is in the base allowlist');
  delete process.env.SECRET_UNRELATED;
  delete process.env.ANTHROPIC_API_KEY;
});

test('gate 15/redaction: secret-shaped values are stripped', () => {
  assert.match(redact('token sk-ant-abcdefghijklmnopqrstuv'), /sk-ant-\*\*\*/);
  assert.match(redact('Authorization: Bearer abcdef.ghijkl.mnopqr'), /\*\*\*/);
  const deep = redactDeep({ env: { A: '1' }, note: 'api_key=supersecretvalue' });
  assert.equal(deep.env, '[redacted]');
  assert.match(deep.note, /\*\*\*/);
});

test('gate 26: credential-bearing clone URLs rejected/sanitized', () => {
  assert.throws(() => sanitizeGitUrl('https://user:pass@example.com/r.git', { reject: true }));
  assert.equal(sanitizeGitUrl('https://user:pass@example.com/r.git'), 'https://example.com/r.git');
  assert.equal(sanitizeGitUrl('https://example.com/r.git'), 'https://example.com/r.git');
});

test('gate 17: shell metacharacters stay inert argv data (shell:false)', async () => {
  // If a shell interpreted this, the file "pwned" would be created.
  const node = process.execPath;
  const evil = '$(touch pwned); `id`; rm -rf /tmp/nope';
  let captured = '';
  const h = runProcess({
    executable: node,
    argv: ['-e', 'process.stdout.write(process.argv[1])', evil],
    env: buildChildEnv({}).env,
    cwd: process.cwd(),
    onStdout: (s) => (captured += s),
  });
  const res = await h.promise;
  assert.equal(res.status, 'ok');
  assert.equal(captured, evil, 'argument passed literally, not shell-expanded');
});

test('gate 25: terminal control sequences are stripped from harness output', () => {
  const hostile = 'hello\x1b[2J\x1b[1;1H\x1b]0;pwned title\x07\x07world\x1b[31mred\x1b[0m';
  const clean = stripControl(hostile);
  assert.doesNotMatch(clean, /\x1b/);
  assert.doesNotMatch(clean, /\x07/);
  assert.equal(clean, 'helloworldred');
  // Tabs and newlines are preserved.
  assert.equal(stripControl('a\tb\nc'), 'a\tb\nc');
});

test('BOUNDS: stderr is bounded (harness cannot exhaust memory via stderr spam)', async () => {
  const node = process.execPath;
  const h = runProcess({
    executable: node,
    argv: ['-e', 'const b=Buffer.alloc(65536,120);let n=0;const t=setInterval(()=>{process.stderr.write(b);if(++n>200)clearInterval(t);},1);setTimeout(()=>{},5000);'],
    env: buildChildEnv({}).env,
    cwd: process.cwd(),
    limits: { maxStderrBytes: 256 * 1024, killGraceMs: 300 },
  });
  const res = await h.promise;
  assert.equal(res.killedForSize, true, 'process killed once stderr bound exceeded');
});

test('BOUNDS: over-large stdin prompt is truncated, not passed unbounded', async () => {
  const node = process.execPath;
  let captured = '';
  const h = runProcess({
    executable: node,
    argv: ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(String(d.length)));'],
    env: buildChildEnv({}).env,
    cwd: process.cwd(),
    stdin: 'x'.repeat(1_000_000),
    limits: { maxStdinBytes: 1024 },
    onStdout: (s) => (captured += s),
  });
  const res = await h.promise;
  assert.equal(res.stdinTruncated, true);
  assert.ok(Number(captured) <= 1024, 'child received at most the bounded stdin');
});

test('gate 18: cancellation terminates the process (tree) and reports cancelled', async () => {
  const node = process.execPath;
  const h = runProcess({
    executable: node,
    argv: ['-e', 'setInterval(()=>{},1000)'], // hangs forever
    env: buildChildEnv({}).env,
    cwd: process.cwd(),
    limits: { killGraceMs: 300 },
  });
  setTimeout(() => h.cancel(), 100);
  const res = await h.promise;
  assert.equal(res.cancelled, true);
  assert.equal(res.status, 'cancelled');
});
