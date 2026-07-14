// Shared execution path for PROCESS-based adapters. Wires prepareInvocation ->
// env policy -> supervisor -> streaming parseEvents -> finalize into the uniform
// runTurn(ctx, hooks) the orchestrator expects. Never builds a shell string.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from '../process/supervisor.mjs';
import { buildChildEnv } from '../process/env-policy.mjs';

/**
 * @param {object} adapter  must implement prepareInvocation, parseEvents, finalize
 * @param {object} ctx
 * @param {object} hooks    { onEvent(normEvent) }
 */
export async function executeProcessTurn(adapter, ctx, hooks) {
  const prep = adapter.prepareInvocation(ctx);
  if (!prep || !prep.executable || !Array.isArray(prep.argv)) {
    throw new Error(`${adapter.id}: prepareInvocation must return {executable, argv[]}`);
  }

  // Env: base allowlist + explicitly named auth vars only.
  const { env } = buildChildEnv({ authEnvNames: prep.authEnvNames || [], extra: prep.env || {} });

  // Prefer a protected temp prompt file over exposing large prompts in argv.
  let promptDir = null;
  let argv = prep.argv;
  let stdin = prep.stdin ?? null;
  if (prep.promptFile && ctx.prompt) {
    promptDir = mkdtempSync(join(tmpdir(), 'moh-prompt-'));
    const file = join(promptDir, 'prompt.txt');
    writeFileSync(file, ctx.prompt, { mode: 0o600 });
    argv = argv.map((a) => (a === '__MOH_PROMPT_FILE__' ? file : a));
  } else if (prep.stdinPrompt && ctx.prompt != null) {
    stdin = ctx.prompt;
  }

  const state = { buf: '', bufBytes: Buffer.alloc(0) };
  const parseState = {};
  const handle = runProcess({
    executable: prep.executable,
    argv,
    env,
    cwd: ctx.workspaceDir,
    stdin,
    limits: ctx.limits,
    onStdout(s) {
      try {
        const evts = adapter.parseEvents(s, parseState) || [];
        for (const ev of evts) hooks?.onEvent?.(ev);
      } catch (e) {
        hooks?.onEvent?.({ kind: 'notice', payload: { level: 'warn', message: `parse error: ${e.message}` } });
      }
    },
    onStderr(s) {
      hooks?.onEvent?.({ kind: 'notice', payload: { level: 'debug', message: s.slice(0, 500) } });
    },
  });

  // Wire cancellation from the orchestrator's abort signal to the process tree.
  if (ctx.signal) {
    if (ctx.signal.aborted) handle.cancel();
    else ctx.signal.addEventListener('abort', () => handle.cancel(), { once: true });
  }

  const result = await handle.promise;
  let fin = {};
  try {
    fin = adapter.finalize(parseState) || {};
  } catch (e) {
    fin = { finalText: '', error: e.message };
  }
  if (promptDir) {
    try {
      rmSync(promptDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  let status = result.status;
  if (status === 'ok' && !fin.finalText) status = 'failed'; // no final response is a failure class
  return {
    status,
    finalText: fin.finalText || '',
    sessionId: fin.sessionId || null,
    reportedModel: fin.reportedModel || parseState.reportedModel || null,
    usage: fin.usage || parseState.usage || null,
    raw: result,
  };
}
