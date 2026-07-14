// Loopback web companion. Same core, same events as the TUI. Security:
//  - binds 127.0.0.1 (0.0.0.0 only via explicit --dangerously-expose with warning)
//  - unguessable per-launch capability, delivered as an HttpOnly SameSite=Strict
//    cookie (never in URL / HTML / localStorage / SSE)
//  - canonical loopback Host validation (DNS-rebinding defense)
//  - Origin validation + custom-header requirement on mutations (CSRF defense)
//  - no permissive CORS, restrictive CSP, locally-bundled assets
//  - harness/repo content HTML-escaped; no secrets in responses/events
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Application } from '../core/app.mjs';
import { Preset } from '../core/state.mjs';
import { redactDeep } from '../security/redact.mjs';
import { parseFlags } from '../cli/args.mjs';
import { out, err, c } from '../cli/ui.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startWeb(rest) {
  const flags = parseFlags(rest);
  const host = flags['dangerously-expose'] ? '0.0.0.0' : '127.0.0.1';
  if (host === '0.0.0.0') err(c.red('⚠ DANGER: binding 0.0.0.0 exposes moh beyond loopback. Do this only on a trusted, isolated network.'));
  let port = parseInt(flags.port, 10) || 7373;

  const capability = randomBytes(24).toString('base64url');
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');

  // In-memory event feed + pending gate decisions.
  const clients = new Set();
  const pendingDecisions = new Map(); // id -> resolve
  let currentApp = null;

  function broadcast(evt) {
    const data = `data: ${JSON.stringify(redactDeep(evt))}\n\n`;
    for (const res of clients) res.write(data);
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });

  function validHost(req) {
    const h = req.headers.host || '';
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || (host === '0.0.0.0');
  }
  function hasCapability(req) {
    const cookie = req.headers.cookie || '';
    const m = /(?:^|;\s*)moh_cap=([^;]+)/.exec(cookie);
    return m && m[1] === capability;
  }
  function validOrigin(req) {
    const o = req.headers.origin;
    if (!o) return false;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function securityHeaders(extra = {}) {
    return {
      'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      ...extra,
    };
  }

  async function handle(req, res) {
    // DNS-rebinding defense: reject non-canonical Host up front.
    if (!validHost(req)) {
      res.writeHead(421, securityHeaders({ 'content-type': 'text/plain' }));
      res.end('Misdirected request (invalid Host).');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, securityHeaders({ 'content-type': 'text/html; charset=utf-8', 'set-cookie': `moh_cap=${capability}; HttpOnly; SameSite=Strict; Path=/` }));
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      if (!hasCapability(req)) return deny(res);
      res.writeHead(200, securityHeaders({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }));
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!hasCapability(req)) return deny(res);
      const runId = url.searchParams.get('runId');
      const state = runId && currentApp ? currentApp.store.loadState(runId) : null;
      json(res, { running: !!currentApp, state: state ? redactDeep(sanitize(state)) : null });
      return;
    }

    // --- Mutations: capability + Origin + custom header required ---
    if (req.method === 'POST') {
      if (!hasCapability(req)) return deny(res);
      if (!validOrigin(req)) return deny(res, 'bad origin');
      if (req.headers['x-moh-csrf'] !== '1') return deny(res, 'missing csrf header');
      if ((req.headers['content-type'] || '').indexOf('application/json') === -1) return deny(res, 'expected json');
      const body = await readJson(req);

      if (url.pathname === '/api/run') {
        startRun();
        json(res, { ok: true });
        return;
      }
      if (url.pathname === '/api/decision') {
        const resolve = pendingDecisions.get(body.id);
        if (resolve) {
          pendingDecisions.delete(body.id);
          resolve(body.value);
          json(res, { ok: true });
        } else {
          json(res, { ok: false, error: 'no pending decision' }, 409);
        }
        return;
      }
    }

    res.writeHead(404, securityHeaders({ 'content-type': 'text/plain' }));
    res.end('not found');
  }

  function startRun() {
    const decider = {
      chooseLeader: (candidates) =>
        new Promise((resolve) => {
          const id = 'leader-' + randomBytes(4).toString('hex');
          pendingDecisions.set(id, (v) => resolve(v || candidates[0].seatId));
          broadcast({ kind: 'gate.leader', payload: { id, candidates } });
        }),
      confirmResult: (ctx) =>
        new Promise((resolve) => {
          const id = 'result-' + randomBytes(4).toString('hex');
          pendingDecisions.set(id, (v) => resolve(v || { confirm: false }));
          broadcast({ kind: 'gate.result', payload: { id, verdict: ctx.verdict, approved: ctx.approved, changed: ctx.changed } });
        }),
    };
    currentApp = new Application({ decider });
    currentApp.subscribe(broadcast);
    (async () => {
      const { runId } = await currentApp.createRun(demoConfig());
      broadcast({ kind: 'run.id', payload: { runId } });
      try {
        const outcome = await currentApp.run(runId);
        broadcast({ kind: 'run.done', payload: outcome });
      } catch (e) {
        broadcast({ kind: 'run.error', payload: { message: e.message } });
      }
    })();
  }

  function deny(res, msg = 'unauthorized') {
    res.writeHead(403, securityHeaders({ 'content-type': 'text/plain' }));
    res.end(msg);
  }
  function json(res, obj, code = 200) {
    res.writeHead(code, securityHeaders({ 'content-type': 'application/json' }));
    res.end(JSON.stringify(obj));
  }

  await listenWithFallback(server, port, host, (p) => (port = p));
  out(c.green(`moh web on http://127.0.0.1:${port}`));
  out(c.dim('Loopback only · per-launch capability cookie · no push · Ctrl-C to stop'));
  process.on('SIGINT', () => {
    for (const res of clients) try { res.end(); } catch {}
    if (currentApp) currentApp.cancel();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
  return new Promise(() => {}); // keep alive
}

function sanitize(state) {
  const s = structuredClone(state);
  delete s.task;
  return s;
}

function demoConfig() {
  return {
    preset: Preset.FULL_MIXTURE,
    task: 'Implement greet(name) handling empty names, with a short write-up.',
    seed: { kind: 'greenfield' },
    seats: [
      { seatId: 'seat-a', label: 'Seat A (Alpha)', adapterId: 'fake', requestedModel: 'alpha-mini', adapterConfig: { reportedModel: 'alpha-mini-2026', fallbackOnIntegrate: true, fallbackModel: 'alpha-nano-fallback', sessionPrefix: 'alpha' } },
      { seatId: 'seat-b', label: 'Seat B (Beta)', adapterId: 'fake', requestedModel: null, adapterConfig: { reportedModel: null, sessionPrefix: 'beta' } },
    ],
  };
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (ch) => {
      size += ch.length;
      if (size > 1024 * 256) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function listenWithFallback(server, port, host, setPort, attempts = 10) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tryListen = (p) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries < attempts) {
          tries++;
          tryListen(p + 1);
        } else {
          reject(e);
        }
      });
      server.listen(p, host, () => {
        setPort(p);
        resolve();
      });
    };
    tryListen(port);
  });
}
