// CLI dispatcher. One core; every command drives the same Application.
import { mkdirSync } from 'node:fs';
import { Application, autoDecider } from '../core/app.mjs';
import { RunStore } from '../storage/store.mjs';
import { listAdapters, getAdapter } from '../adapters/registry.mjs';
import { Readiness } from '../adapters/contract.mjs';
import { Preset } from '../core/state.mjs';
import { identityLine, effectiveModelLine } from '../core/provenance.mjs';
import { runsDir, stateDir } from '../storage/paths.mjs';
import { applyLegacyEnvCompat } from '../storage/migrate.mjs';
import { out, err, heading, kv, table, c } from './ui.mjs';
import { readPromptInput, parseFlags } from './args.mjs';
import { doctor } from './doctor.mjs';
import { exportRun } from './export.mjs';

const VERSION = '0.1.0';

function ensureDirs() {
  mkdirSync(runsDir(), { recursive: true });
}

export async function main(argv) {
  applyLegacyEnvCompat((m) => err(c.yellow(m)));
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
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
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
  return 0;
}

async function cmdAdapters(rest) {
  const flags = parseFlags(rest);
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
  const preset = flags.preset === 'quick-compare' ? Preset.QUICK_COMPARE : Preset.FULL_MIXTURE;
  const seatA = { seatId: 'seat-a', label: 'Seat A', adapterId: flags['seat-a'] || 'fake', requestedModel: flags['model-a'] || null };
  const seatB = { seatId: 'seat-b', label: 'Seat B', adapterId: flags['seat-b'] || 'fake', requestedModel: flags['model-b'] || null };
  // Fake seats need a config to report models deterministically; harmless for real ones.
  if (seatA.adapterId === 'fake') seatA.adapterConfig = { reportedModel: 'seat-a-model', sessionPrefix: 'a' };
  if (seatB.adapterId === 'fake') seatB.adapterConfig = { reportedModel: null, sessionPrefix: 'b' };
  const seed = parseSeed(flags.seed);

  const decider = flags.yes || flags.json ? autoDecider() : interactiveDecider();
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
  return outcome.status === 'finished' ? 0 : outcome.status === 'failed' ? 1 : 0;
}

function parseSeed(seed) {
  if (!seed || seed === 'greenfield') return { kind: 'greenfield' };
  if (/^https?:\/\/|^git@/.test(seed)) return { kind: 'url', url: seed };
  return { kind: 'local', path: seed };
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

async function cmdRuns() {
  const store = new RunStore();
  const ids = store.list();
  if (ids.length === 0) {
    out('No runs yet. Try `moh demo`.');
    return 0;
  }
  heading('Runs');
  const rows = [];
  for (const id of ids) {
    const s = store.loadState(id);
    rows.push([id, s?.preset || '—', s?.stage || '—', s?.status || '—', s?.leaderSeatId || '—']);
  }
  table(rows, ['run-id', 'preset', 'stage', 'status', 'leader']);
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
  // Safe recovery: we never silently repeat a paid turn. Report the checkpoint and
  // let the user decide. Full mid-stage resume of a live harness is P1; here we
  // surface preserved workspaces and the last durable stage.
  heading(`Resume ${runId}`);
  kv('status', state.status);
  kv('last stage', state.stage);
  kv('leader', state.leaderSeatId || '—');
  out('\n' + c.yellow('Interrupted runs are preserved. Workspaces:'));
  for (const [seatId, ws] of Object.entries(state.workspaces || {})) out(`  ${seatId}: ${ws.dir}`);
  out('\nRe-run from preserved workspaces with a fresh run, or inspect with `moh inspect ' + runId + '`.');
  out(c.dim('(Live mid-stage resume of a running harness is a P1 capability; moh will not blindly re-bill a completed turn.)'));
  return 0;
}
