// CLI dispatcher. One core; every command drives the same Application.
import { mkdirSync } from 'node:fs';
import { resolve as resolvePath, basename } from 'node:path';
import { Application, autoDecider } from '../core/app.mjs';
import { RunStore } from '../storage/store.mjs';
import { listAdapters, getAdapter, registerExternalAdapter } from '../adapters/registry.mjs';
import { Readiness } from '../adapters/contract.mjs';
import { Preset } from '../core/state.mjs';
import { identityLine, effectiveModelLine } from '../core/provenance.mjs';
import { runsDir, stateDir, legacyCouncilDirs } from '../storage/paths.mjs';
import { applyLegacyEnvCompat, scanLegacyCouncil, migrateCouncilRun } from '../storage/migrate.mjs';
import { loadConfig, configExists, saveConfig } from '../tui/config.mjs';
import { out, err, heading, kv, table, c } from './ui.mjs';
import { readPromptInput, parseFlags } from './args.mjs';
import { doctor } from './doctor.mjs';
import { exportRun } from './export.mjs';

const VERSION = '0.1.0';

function ensureDirs() {
  mkdirSync(runsDir(), { recursive: true });
}

/**
 * Load third-party adapters listed in config (opt-in). Enabling one means trusting
 * local code; each requires MOH_ALLOW_EXTERNAL_ADAPTERS=1 or config.trustExternal.
 */
function loadConfiguredExternalAdapters() {
  const cfg = configExists() ? loadConfig() : null;
  const manifests = cfg?.externalAdapters || [];
  if (!manifests.length) return;
  const trust = process.env.MOH_ALLOW_EXTERNAL_ADAPTERS === '1' || cfg?.trustExternal === true;
  for (const m of manifests) {
    try {
      registerExternalAdapter(m, { trust });
    } catch (e) {
      err(c.yellow(`[external-adapter] skipped ${m}: ${e.message}`));
    }
  }
}

export async function main(argv) {
  applyLegacyEnvCompat((m) => err(c.yellow(m)));
  loadConfiguredExternalAdapters();
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case 'tui':
      return (await import('../tui/tui.mjs')).launchTui(rest);
    case 'setup':
      return (await import('../tui/setup.mjs')).runSetup(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'adapters':
      return cmdAdapters(rest);
    case 'run':
      return cmdRun(rest);
    case 'demo':
      return cmdDemo(rest);
    case 'web':
      return (await import('../web/server.mjs')).startWeb(rest);
    case 'runs':
      return cmdRuns(rest);
    case 'inspect':
      return cmdInspect(rest);
    case 'resume':
      return cmdResume(rest);
    case 'export':
      return exportRun(rest);
    case 'version':
    case '--version':
    case '-v':
      out(`mixture-of-harnesses ${VERSION}`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      return printHelp();
    default:
      err(`unknown command: ${cmd}`);
      printHelp();
      return 2;
  }
}

function printHelp() {
  out(`${c.bold('Mixture of Harnesses')} — One task. Multiple harnesses. Better code.\n`);
  out(`Usage: ${c.cyan('moh')} [command] [options]\n`);
  out('Commands:');
  const rows = [
    ['(none)', 'Launch the TUI (guided setup on first use)'],
    ['setup', 'Configure two seats, harnesses, and defaults'],
    ['doctor [--json]', 'Offline harness diagnostics (no tokens spent)'],
    ['adapters', 'List harness adapters and capabilities'],
    ['run [opts]', 'Run a task (see options below)'],
    ['demo', 'Deterministic zero-token end-to-end demo'],
    ['web [--port N]', 'Launch the loopback browser companion'],
    ['runs', 'List past runs'],
    ['inspect <run-id>', 'Show a run record and provenance'],
    ['resume <run-id>', 'Resume/retry an interrupted run (safe)'],
    ['export <run-id>', 'Export a privacy-safe report (md/json)'],
    ['version', 'Print version'],
  ];
  for (const [k, v] of rows) out(`  ${c.cyan(k.padEnd(18))} ${v}`);
  out('\nrun options:');
  const ro = [
    ['--preset <full-mixture|quick-compare>', 'Workflow preset (default full-mixture)'],
    ['--task <text> | --task-file <f> | --stdin', 'Task input'],
    ['--seat-a <adapterId> --seat-b <adapterId>', 'Adapter per seat (default fake/fake)'],
    ['--model-a <m> --model-b <m>', 'Requested model per seat'],
    ['--seed <path|url|greenfield>', 'Repository seed (default greenfield)'],
    ['--json', 'Emit line-oriented JSON events (no ANSI)'],
    ['--yes', 'Auto-confirm gates (non-interactive)'],
  ];
  for (const [k, v] of ro) out(`  ${c.dim(k.padEnd(44))} ${v}`);
  out('\nDocs: docs/OVERHAUL_PLAN.md · README.md · SECURITY.md · PRIVACY.md');
  return 0;
}

async function cmdDoctor(rest) {
  const flags = parseFlags(rest);
  const report = await doctor();
  // Doctor is informational diagnostics, not a pass/fail gate — it always exits 0
  // (the fake harness is always ready and the demo works offline). Scripts read the
  // `ok` field / per-adapter `readiness` from --json instead of the exit code.
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  heading('moh doctor — offline diagnostics (no tokens spent)');
  kv('node', report.node);
  kv('git', report.git || 'not found');
  kv('state dir', report.stateDir);
  heading('Harnesses');
  const rows = report.adapters.map((a) => [a.displayName, a.readiness, a.version || '—', a.authLabel || '—']);
  table(rows, ['Harness', 'Readiness', 'Version', 'Auth']);
  for (const a of report.adapters) {
    if (a.detail && a.readiness !== Readiness.READY) out(`  ${c.dim('· ' + a.displayName + ': ' + a.detail)}`);
  }
  out('');
  out(report.ok ? c.green('doctor: OK — at least one harness is ready.') : c.yellow('doctor: no non-fake harness is ready; the demo still works offline.'));
  return 0; // informational: always 0
}

async function cmdAdapters(rest) {
  const flags = parseFlags(rest);
  // `moh adapters add <manifest.json>` registers a third-party adapter (opt-in).
  if (rest[0] === 'add') {
    const manifest = rest.find((a, i) => i > 0 && !a.startsWith('-'));
    if (!manifest) {
      err('adapters add: manifest path required (see docs/PROTOCOL.md and examples/example-adapter/)');
      return 2;
    }
    const abs = resolvePath(manifest);
    const trust = flags.trust || process.env.MOH_ALLOW_EXTERNAL_ADAPTERS === '1';
    try {
      const a = registerExternalAdapter(abs, { trust: !!trust });
      const cfg = configExists() ? loadConfig() : {};
      const list = new Set(cfg.externalAdapters || []);
      list.add(abs);
      saveConfig({ ...cfg, externalAdapters: [...list], trustExternal: cfg.trustExternal === true || !!flags.trust });
      out(c.green(`registered external adapter '${a.id}' (${a.displayName}). Enable per-session with MOH_ALLOW_EXTERNAL_ADAPTERS=1${flags.trust ? ' or trustExternal set in config' : ''}.`));
      out(c.dim('You are trusting local third-party code. Review the adapter before running real tasks.'));
      return 0;
    } catch (e) {
      err(`adapters add: ${e.message}`);
      return 1;
    }
  }
  const data = [];
  for (const a of listAdapters()) {
    const caps = a.capabilities();
    data.push({ id: a.id, displayName: a.displayName, version: a.version, trustLevel: a.trustLevel, capabilities: caps });
  }
  if (flags.json) {
    out(JSON.stringify(data, null, 2));
    return 0;
  }
  heading('Adapters');
  table(
    data.map((a) => [a.id, a.displayName, a.version, a.trustLevel]),
    ['id', 'name', 'version', 'trust']
  );
  return 0;
}

function demoConfig() {
  return {
    preset: Preset.FULL_MIXTURE,
    task: 'Implement a greet(name) utility that handles empty names, with a short write-up.',
    seed: { kind: 'greenfield' },
    seats: [
      {
        seatId: 'seat-a',
        label: 'Seat A (Alpha)',
        adapterId: 'fake',
        requestedModel: 'alpha-mini',
        adapterConfig: { reportedModel: 'alpha-mini-2026', fallbackOnIntegrate: true, fallbackModel: 'alpha-nano-fallback', sessionPrefix: 'alpha' },
      },
      {
        seatId: 'seat-b',
        label: 'Seat B (Beta)',
        adapterId: 'fake',
        requestedModel: null,
        adapterConfig: { reportedModel: null, sessionPrefix: 'beta' }, // not reported by harness
      },
    ],
  };
}

async function cmdDemo(rest) {
  const flags = parseFlags(rest);
  ensureDirs();
  const app = new Application({ deterministic: true, decider: autoDecider() });
  const events = [];
  app.subscribe((e) => {
    events.push(e);
    if (flags.json) out(JSON.stringify(e));
  });
  if (!flags.json) heading('moh demo — deterministic, zero-token full workflow');
  const { runId, state } = await app.createRun(demoConfig());
  const outcome = await app.run(runId);
  if (flags.json) {
    out(JSON.stringify({ runId, outcome }));
    return 0;
  }
  printRunSummary(app.store, runId, state, outcome);
  out('\n' + c.dim(`Full record: ${runsDir()}/${runId}`));
  out(c.green('demo: complete (no credentials, no network, no paid calls).'));
  return 0;
}

function printRunSummary(store, runId, state0, outcome) {
  const state = store.loadState(runId);
  heading(`Run ${runId}`);
  kv('preset', state.preset);
  kv('leader', state.leaderSeatId || '—');
  kv('verdict', outcome.verdict || (state.review && state.review.verdict) || '—');
  heading('Seat provenance');
  for (const seat of state.seats) {
    const prov = state.provenanceBySeat[seat.seatId];
    if (!prov) continue;
    out('  ' + c.bold(seat.label));
    out('    ' + identityLine(prov));
    out('    ' + c.dim(effectiveModelLine(prov)) + c.dim(`  ·  requested: ${prov.requestedModel || 'Harness default'}`));
    if (prov.history.length) out('    ' + c.yellow(`model fallback: ${prov.history.map((h) => `${h.from}→${h.to}`).join(', ')}`));
  }
  if (state.result) {
    heading('Local result');
    kv('branch', state.result.branch);
    kv('commit', state.result.commit);
    kv('tree', state.result.tree);
    const receipt = store.readReceipt(runId);
    if (receipt) {
      kv('receipt', receipt.receiptDigest);
      kv('changed', String(receipt.changedManifest.length) + ' file(s)');
    }
    out('  ' + c.dim(`(local branch only — moh never pushes)`));
  } else {
    heading('Result');
    kv('status', outcome.status + (outcome.reason ? ` — ${outcome.reason}` : ''));
  }
}

async function cmdRun(rest) {
  const flags = parseFlags(rest);
  ensureDirs();
  const task = await readPromptInput(flags);
  if (!task) {
    err('run: no task provided. Use --task, --task-file, or --stdin.');
    return 2;
  }
  const cfg = configExists() ? loadConfig() : null;
  const preset = flags.preset === 'quick-compare' ? Preset.QUICK_COMPARE : cfg?.defaultPreset === 'quick-compare' ? Preset.QUICK_COMPARE : Preset.FULL_MIXTURE;

  // Prefer saved setup config; flags override per-seat adapter/model.
  const base = cfg?.seats?.length === 2 ? structuredClone(cfg.seats) : [
    { seatId: 'seat-a', label: 'Seat A', adapterId: 'fake', adapterConfig: { reportedModel: 'seat-a-model', sessionPrefix: 'a' } },
    { seatId: 'seat-b', label: 'Seat B', adapterId: 'fake', adapterConfig: { reportedModel: null, sessionPrefix: 'b' } },
  ];
  const seatA = { ...base[0], seatId: 'seat-a', label: base[0].label || 'Seat A' };
  const seatB = { ...base[1], seatId: 'seat-b', label: base[1].label || 'Seat B' };
  if (flags['seat-a']) seatA.adapterId = flags['seat-a'];
  if (flags['seat-b']) seatB.adapterId = flags['seat-b'];
  if (flags['model-a']) seatA.requestedModel = flags['model-a'];
  if (flags['model-b']) seatB.requestedModel = flags['model-b'];
  // Only synthesize fake config when a seat is (still) fake and lacks one.
  if (seatA.adapterId === 'fake' && !seatA.adapterConfig) seatA.adapterConfig = { reportedModel: 'seat-a-model', sessionPrefix: 'a' };
  if (seatB.adapterId === 'fake' && !seatB.adapterConfig) seatB.adapterConfig = { reportedModel: null, sessionPrefix: 'b' };
  const seed = parseSeed(flags.seed);
  if (cfg?.seats?.length === 2 && !flags.json) out(c.dim('using seats from saved setup config'));

  // Only --yes auto-confirms gates. --json without --yes is non-interactive but must
  // NOT silently create a result branch: it auto-picks a leader (no side effect) and
  // DECLINES result creation, printing guidance to pass --yes.
  let decider;
  if (flags.yes) decider = autoDecider();
  else if (flags.json) decider = nonConfirmingDecider();
  else decider = interactiveDecider();
  const app = new Application({ decider });
  app.subscribe((e) => {
    if (flags.json) out(JSON.stringify(e));
  });
  const { runId, state } = await app.createRun({ preset, task, seed, seats: [seatA, seatB] });
  if (!flags.json) out(c.dim(`run id: ${runId}`));
  const outcome = await app.run(runId);
  if (flags.json) {
    out(JSON.stringify({ runId, outcome }));
  } else {
    printRunSummary(app.store, runId, state, outcome);
  }
  // Honest exit codes: 0 only when a result was actually created. `blocked`,
  // `not_created`, and `declined` mean integrity checks or a human prevented result
  // creation — automation must see a NON-zero code, not success.
  if (outcome.status === 'finished') return 0;
  if (outcome.status === 'failed') return 1;
  return 3; // declined / not_created / blocked
}

function parseSeed(seed) {
  if (!seed || seed === 'greenfield') return { kind: 'greenfield' };
  if (/^https?:\/\/|^git@/.test(seed)) return { kind: 'url', url: seed };
  return { kind: 'local', path: seed };
}

// Non-interactive automation (--json without --yes): pick a leader (no side effect)
// but never auto-create the result branch. Emits guidance instead.
function nonConfirmingDecider() {
  return {
    async chooseLeader(candidates) {
      return candidates[0].seatId;
    },
    async confirmResult() {
      out(JSON.stringify({ kind: 'gate.result.skipped', payload: { reason: 'non-interactive run without --yes; result branch NOT created. Re-run with --yes to auto-create.' } }));
      return { confirm: false };
    },
  };
}

function interactiveDecider() {
  // Minimal readline-based gate for non-JSON CLI runs.
  return {
    async chooseLeader(candidates) {
      const { ask } = await import('./prompt.mjs');
      out('\nLeader selection:');
      candidates.forEach((cand, i) => out(`  [${i + 1}] ${cand.label}`));
      const a = await ask(`Choose leader [1-${candidates.length}] (default 1): `);
      const idx = Math.max(1, Math.min(candidates.length, parseInt(a, 10) || 1)) - 1;
      return candidates[idx].seatId;
    },
    async confirmResult({ verdict, approved }) {
      const { ask } = await import('./prompt.mjs');
      out(`\nReview verdict: ${verdict}${approved ? c.green(' (approved)') : c.yellow(' (not approved)')}`);
      const a = await ask('Create local result branch? [y/N]: ');
      const confirm = /^y/i.test(a.trim());
      let override = false;
      if (confirm && !approved) {
        const o = await ask('Verdict is not approved. Override and record as UNREVIEWED/OVERRIDDEN? [y/N]: ');
        override = /^y/i.test(o.trim());
      }
      return { confirm, override };
    },
  };
}

/** Scan all legacy Council directories and return migrated run records. */
function scanLegacy() {
  const out = [];
  const seen = new Set();
  const active = resolvePath(stateDir());
  for (const dir of legacyCouncilDirs()) {
    // Never treat moh's OWN active state dir as a legacy source (defense in depth).
    if (resolvePath(dir) === active) continue;
    for (const { path, legacy, error } of scanLegacyCouncil(dir)) {
      if (seen.has(path)) continue;
      seen.add(path);
      // Malformed/unparseable legacy records are QUARANTINED and surfaced, never
      // silently skipped — so a corrupt run is visible rather than vanishing.
      if (!legacy) {
        out.push({ runId: `(quarantined: ${basename(path)})`, quarantined: true, reason: error || 'unparseable legacy record', _path: path });
        continue;
      }
      const res = migrateCouncilRun(legacy, { sourcePath: path });
      out.push(res.ok ? { ...res.migrated, _path: path } : { runId: `(quarantined: ${basename(path)})`, quarantined: true, reason: res.reason, _path: path });
    }
  }
  return out;
}

async function cmdRuns(rest = []) {
  const flags = parseFlags(rest);
  const store = new RunStore();
  const ids = store.list();
  const legacy = scanLegacy();
  if (ids.length === 0 && legacy.length === 0) {
    out('No runs yet. Try `moh demo`.');
    return 0;
  }
  if (flags.json) {
    const rows = ids.map((id) => ({ ...store.loadState(id), source: 'moh' }));
    out(JSON.stringify({ runs: rows, legacy }, null, 2));
    return 0;
  }
  heading('Runs');
  const rows = [];
  for (const id of ids) {
    const s = store.loadState(id);
    rows.push([id, s?.preset || '—', s?.stage || '—', s?.status || '—', s?.leaderSeatId || '—', 'moh']);
  }
  for (const l of legacy) {
    rows.push([l.runId, l.migratedFrom ? 'council' : '—', l.quarantined ? 'quarantined' : 'migrated', l.verdict || '—', l.leaderSeatId || '—', 'legacy']);
  }
  table(rows, ['run-id', 'preset', 'stage/state', 'status/verdict', 'leader', 'source']);
  if (legacy.length) out('\n' + c.dim(`${legacy.length} legacy Council run(s) are readable via \`moh inspect <run-id>\` (originals never modified).`));
  return 0;
}

async function cmdInspect(rest) {
  const runId = rest.find((a) => !a.startsWith('-'));
  const flags = parseFlags(rest);
  if (!runId) {
    err('inspect: run-id required');
    return 2;
  }
  const store = new RunStore();
  const state = store.loadState(runId);
  if (!state) {
    // Fall back to legacy Council runs (read-only, migrated on the fly).
    const legacy = scanLegacy().find((l) => l.runId === runId);
    if (legacy) {
      if (flags.json) {
        out(JSON.stringify(legacy, null, 2));
        return 0;
      }
      heading(`Legacy Council run ${runId}`);
      kv('migrated from', legacy.migratedFrom || 'council');
      kv('legacy branch', legacy.legacyBranch || '—');
      kv('verdict', legacy.verdict || 'unknown');
      kv('review integrity', legacy.reviewIntegrity || 'unattested');
      heading('Seats (mapped to generic ids)');
      for (const s of legacy.seats || []) out(`  ${s.seatId} · ${s.label} · adapter ${s.adapterId} · model ${s.provenance?.requestedModel || 'unknown'} (${s.provenance?.state || 'unknown'})`);
      out('\n' + c.dim('Legacy model provenance is `unknown` (not reconstructed); review integrity `unattested`. Original files unchanged.'));
      return 0;
    }
    err(`inspect: run not found: ${runId}`);
    return 1;
  }
  const receipt = store.readReceipt(runId);
  if (flags.json) {
    out(JSON.stringify({ state, receipt }, null, 2));
    return 0;
  }
  printRunSummary(store, runId, state, { status: state.status, verdict: state.review?.verdict });
  if (receipt) {
    heading('Receipt');
    out(JSON.stringify(receipt.git, null, 2));
  }
  heading('Events (last 10)');
  const evts = store.readEvents(runId).slice(-10);
  for (const e of evts) out(`  ${c.dim(String(e.seq).padStart(3))} ${e.kind}${e.seatId ? ' [' + e.seatId + ']' : ''}`);
  return 0;
}

async function cmdResume(rest) {
  const flags = parseFlags(rest);
  const runId = rest.find((a) => !a.startsWith('-'));
  if (!runId) {
    err('resume: run-id required');
    return 2;
  }
  const store = new RunStore();
  const state = store.loadState(runId);
  if (!state) {
    err(`resume: run not found: ${runId}`);
    return 1;
  }
  if (state.status === 'finished') {
    out(c.dim(`run ${runId} already finished (${state.review?.verdict || 'no verdict'}). Nothing to resume; see \`moh inspect ${runId}\`.`));
    return 0;
  }

  // Safe recovery. moh never silently re-bills a completed paid turn: a deliberate
  // retry starts a FRESH run reconstructed from this run's preserved configuration
  // (seats/task/seed), leaving the interrupted run's record and workspaces intact.
  heading(`Resume ${runId}`);
  kv('status', state.status);
  kv('last stage', state.stage);
  kv('leader', state.leaderSeatId || '—');
  out('\n' + c.yellow('Interrupted run preserved. Workspaces:'));
  for (const [seatId, ws] of Object.entries(state.workspaces || {})) out(`  ${seatId}: ${ws.dir}`);

  const doRetry = flags.retry || flags.yes;
  if (!doRetry) {
    out('\nStart a deliberate retry with:');
    out(c.cyan(`  moh resume ${runId} --retry`));
    out(c.yellow('  Note: a retry starts a NEW run and RE-EXECUTES every turn from scratch'));
    out(c.yellow('  (this WILL re-invoke the harnesses and re-incur their cost). moh does not'));
    out(c.yellow('  yet resume a partially-completed run mid-stage (that is a P1 capability);'));
    out(c.dim('  the original run and its workspaces are preserved either way.'));
    return 0;
  }

  if (!state.task) {
    err('resume --retry: original task text is not available for this run.');
    return 1;
  }
  out('\n' + c.bold('Deliberate retry — starting a NEW run and re-executing all turns (harnesses will be re-invoked)…'));
  const decider = flags.yes ? autoDecider() : interactiveDecider();
  const app = new Application({ decider });
  app.subscribe((e) => {
    if (flags.json) out(JSON.stringify(e));
  });
  let outcome;
  try {
    const { runId: newId, state: newState } = await app.createRun({
      preset: state.preset,
      task: state.task,
      seed: state.seed,
      seats: state.seats,
      timeoutMs: state.timeoutMs,
    });
    out(c.dim(`new run id: ${newId} (original ${runId} preserved)`));
    outcome = await app.run(newId);
    printRunSummary(app.store, newId, newState, outcome);
  } catch (e) {
    err(`resume --retry failed: ${e.message}`);
    return 1;
  }
  // Honest exit codes: non-zero when the run did not finish successfully.
  if (outcome.status === 'finished') return 0;
  if (outcome.status === 'failed') return 1;
  return 2; // declined / not_created / blocked
}
