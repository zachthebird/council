// Process supervision. ALL harness invocation goes through here.
//  - spawn an executable with an argv array and shell:false (no shell string)
//  - validate the executable path and cwd
//  - bound output size and wall-clock runtime
//  - byte-safe streaming (split UTF-8 preserved via a StringDecoder)
//  - cancel the WHOLE process tree: SIGINT -> bounded wait -> SIGKILL
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { platform } from 'node:os';

export const DEFAULT_LIMITS = Object.freeze({
  maxOutputBytes: 8 * 1024 * 1024,
  maxStderrBytes: 2 * 1024 * 1024,
  maxStdinBytes: 4 * 1024 * 1024,
  // Real repository work can legitimately take well over 30 minutes. This is
  // a hang guard, not a quota; callers can still choose a shorter bound.
  timeoutMs: 90 * 60 * 1000,
  killGraceMs: 4000,
});

function validateExecutable(exe) {
  if (typeof exe !== 'string' || exe.length === 0) throw new Error('executable path required');
  // Must be an absolute, existing, regular file (real-path resolved by adapter).
  if (!isAbsolute(exe)) throw new Error(`executable must be an absolute path: ${exe}`);
  if (!existsSync(exe)) throw new Error(`executable not found: ${exe}`);
  const st = statSync(exe);
  if (!st.isFile()) throw new Error(`executable is not a regular file: ${exe}`);
}

function validateCwd(cwd) {
  if (!cwd) return;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`invalid working directory: ${cwd}`);
}

/**
 * Run a harness turn. Returns a handle with a promise and a cancel() function.
 * onStdout/onStderr receive DECODED strings (byte-safe across chunk boundaries).
 *
 * @param {object} opts
 * @param {string} opts.executable  absolute path
 * @param {string[]} opts.argv      arguments (never a shell string)
 * @param {object} opts.env         child environment (from env-policy)
 * @param {string} opts.cwd
 * @param {string} [opts.stdin]     optional prompt fed via stdin
 * @param {(s:string)=>void} [opts.onStdout]
 * @param {(s:string)=>void} [opts.onStderr]
 * @param {object} [opts.limits]
 */
export function runProcess({ executable, argv = [], env, cwd, stdin = null, onStdout, onStderr, limits = {} }) {
  validateExecutable(executable);
  validateCwd(cwd);
  const lim = { ...DEFAULT_LIMITS, ...limits };

  // Bound the prompt fed on stdin so an over-large prompt cannot exhaust memory or
  // hang the child. Truncation is explicit (recorded on the returned result).
  let stdinTruncated = false;
  if (stdin != null) {
    const buf = Buffer.from(String(stdin), 'utf8');
    if (buf.length > lim.maxStdinBytes) {
      stdin = buf.subarray(0, lim.maxStdinBytes).toString('utf8');
      stdinTruncated = true;
    }
  }

  const child = spawn(executable, argv, {
    cwd,
    env,
    shell: false, // hard requirement: metacharacters stay inert argv data
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so we can signal the whole tree (POSIX).
    detached: platform() !== 'win32',
  });

  const outDec = new StringDecoder('utf8');
  const errDec = new StringDecoder('utf8');
  let outBytes = 0;
  let errBytes = 0;
  let killedForSize = false;
  let cancelled = false;
  let timedOut = false;

  const boundOut = (bytes) => {
    outBytes += bytes;
    if (outBytes > lim.maxOutputBytes && !killedForSize) {
      killedForSize = true;
      kill('SIGKILL');
    }
  };

  child.stdout.on('data', (buf) => {
    boundOut(buf.length);
    const s = outDec.write(buf);
    if (s && onStdout) onStdout(s);
  });
  child.stderr.on('data', (buf) => {
    // stderr is ALSO bounded — a harness cannot exhaust memory via stderr spam.
    errBytes += buf.length;
    if (errBytes > lim.maxStderrBytes && !killedForSize) {
      killedForSize = true;
      kill('SIGKILL');
      return;
    }
    const s = errDec.write(buf);
    if (s && onStderr) onStderr(s);
  });

  function kill(signal) {
    try {
      if (platform() !== 'win32' && child.pid) {
        // Negative pid => whole process group.
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      /* already gone */
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, lim.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    kill('SIGINT');
    const t = setTimeout(() => kill('SIGKILL'), lim.killGraceMs);
    if (typeof t.unref === 'function') t.unref();
  }

  const promise = new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'failed', code: null, signal: null, error: err.message, cancelled, timedOut, killedForSize });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tail = outDec.end();
      if (tail && onStdout) onStdout(tail);
      const etail = errDec.end();
      if (etail && onStderr) onStderr(etail);
      let status;
      if (timedOut) status = 'timeout';
      else if (cancelled) status = 'cancelled';
      else if (killedForSize) status = 'failed';
      else if (code === 0) status = 'ok';
      else status = 'failed';
      resolve({ status, code, signal, cancelled, timedOut, killedForSize, stdinTruncated, outBytes, errBytes });
    });
  });

  if (stdin != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  } else {
    child.stdin.end();
  }

  return { child, promise, cancel, get pid() { return child.pid; } };
}
