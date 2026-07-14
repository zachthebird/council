// Terminal UI. Line-oriented and resilient: works at 80x24, on resize, under
// NO_COLOR, when output is redirected, and restores the terminal cleanly on
// Ctrl-C. It drives the SAME Application core and observes the SAME events as the
// web UI. A full raw-mode pane layout is a polish item; correctness first.
import { Application, autoDecider } from '../core/app.mjs';
import { EventKind } from '../core/events.mjs';
import { Preset } from '../core/state.mjs';
import { identityLine, effectiveModelLine } from '../core/provenance.mjs';
import { doctor } from '../cli/doctor.mjs';
import { ask } from '../cli/prompt.mjs';
import { loadConfig, configExists } from './config.mjs';
import { runSetup } from './setup.mjs';
import { out, heading, kv, c } from '../cli/ui.mjs';

function restoreTerminal() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h'); // show cursor
}

export async function launchTui() {
  process.on('SIGINT', () => {
    restoreTerminal();
    out('\n' + c.dim('Interrupted. Terminal restored. Runs are preserved.'));
    process.exit(130);
  });

  banner();
  if (!configExists()) {
    out(c.yellow('First run: no configuration found.'));
    out('Mixture of Harnesses is local-first: your repositories, harness processes, and');
    out('delegated authorization stay on this machine. moh never pushes, never captures');
    out('credentials, and spends no tokens until you run a real task.\n');
  }

  // Non-interactive fallback: if stdin is not a TTY and nothing is piped for a
  // menu, just print status and exit 0 (safe for smoke tests / CI).
  for (;;) {
    const choice = await menu();
    if (choice === 'q' || choice === 'quit' || choice === null) {
      restoreTerminal();
      out(c.dim('bye.'));
      return 0;
    }
    if (choice === '1') await liveRun(demoLikeConfig());
    else if (choice === '2') await runSetup([]);
    else if (choice === '3') await showDoctor();
    else if (choice === '4') await customRun();
    else out(c.yellow('unknown choice'));
  }
}

function banner() {
  heading('Mixture of Harnesses');
  out(c.dim('One task. Multiple harnesses. Better code.') + '\n');
}

async function menu() {
  out('');
  out(`  ${c.cyan('[1]')} Run the deterministic demo (zero tokens)`);
  out(`  ${c.cyan('[2]')} Setup — configure seats & harnesses`);
  out(`  ${c.cyan('[3]')} Doctor — offline harness diagnostics`);
  out(`  ${c.cyan('[4]')} Run a task now`);
  out(`  ${c.cyan('[q]')} Quit`);
  out(c.dim('  keys: type a number then Enter · Ctrl-C to quit cleanly'));
  const a = (await ask('moh> ')).trim().toLowerCase();
  return a || 'q';
}

async function showDoctor() {
  const r = await doctor();
  heading('Doctor');
  for (const a of r.adapters) kv(a.displayName, `${a.readiness}${a.version ? ' · ' + a.version : ''}`);
  out(r.ok ? c.green('At least one harness is ready.') : c.yellow('No non-fake harness ready — demo still works.'));
}

function demoLikeConfig() {
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

async function customRun() {
  const cfg = configExists() ? loadConfig() : null;
  const task = await ask('Task (one line): ');
  if (!task.trim()) {
    out(c.yellow('no task; cancelled'));
    return;
  }
  const seats = cfg?.seats?.length
    ? cfg.seats
    : demoLikeConfig().seats;
  await liveRun({ preset: Preset.FULL_MIXTURE, task, seed: { kind: 'greenfield' }, seats });
}

async function liveRun(config) {
  const interactive = process.stdin.isTTY;
  const decider = interactive ? tuiDecider() : autoDecider();
  const app = new Application({ decider });
  const seatState = {};
  app.subscribe((e) => render(e, seatState, app));
  const { runId } = await app.createRun(config);
  out(c.dim(`\nrun ${runId} started\n`));
  const outcome = await app.run(runId);
  heading('Result');
  kv('status', outcome.status);
  if (outcome.result) {
    kv('branch', outcome.result.branch);
    kv('commit', outcome.result.commit);
    out(c.dim('  local branch only — never pushed'));
  }
  const state = app.store.loadState(runId);
  heading('Provenance');
  for (const seat of state.seats) {
    const prov = state.provenanceBySeat[seat.seatId];
    if (prov) {
      out('  ' + c.bold(seat.label));
      out('    ' + identityLine(prov));
      out('    ' + c.dim(effectiveModelLine(prov)));
    }
  }
}

function render(e, seatState, app) {
  switch (e.kind) {
    case EventKind.STAGE_ENTERED:
      out(c.magenta(`\n▸ ${e.payload.stage}`));
      break;
    case EventKind.SEAT_TURN_STARTED:
      out(`  ${c.cyan(e.seatId)} ${c.dim('· ' + e.payload.role + ' starting')}`);
      break;
    case EventKind.SEAT_TOOL:
      out(`    ${c.dim('tool')} ${e.payload.name}${e.payload.summary ? ' — ' + e.payload.summary : ''}`);
      break;
    case EventKind.SEAT_MODEL_OBSERVED:
      if (e.provenance?.reportedModel) out(`    ${c.dim('model')} ${e.provenance.reportedModel} ${c.dim('(' + (e.provenance.evidenceSource || 'runtime') + ')')}`);
      break;
    case EventKind.SEAT_MODEL_MISMATCH:
      out(`    ${c.yellow('⚠ model mismatch/fallback')} requested ${e.payload.requested} → reported ${e.payload.reported}`);
      break;
    case EventKind.SEAT_TURN_FINISHED:
      out(`  ${c.green('✓')} ${c.cyan(e.seatId)} done`);
      break;
    case EventKind.SEAT_TURN_FAILED:
      out(`  ${c.red('✗')} ${c.cyan(e.seatId)} ${e.payload.message}`);
      break;
    case EventKind.REVIEW_READY:
      out(`  ${c.dim('review verdict:')} ${e.payload.verdict}`);
      break;
    case EventKind.RESULT_BRANCH_CREATED:
      out(`  ${c.green('★ local result branch:')} ${e.payload.branch}`);
      break;
    default:
      break;
  }
}

function tuiDecider() {
  return {
    async chooseLeader(candidates) {
      out(c.bold('\nChoose the leader:'));
      candidates.forEach((cand, i) => out(`  [${i + 1}] ${cand.label}`));
      const a = await ask(`Leader [1-${candidates.length}] (default 1): `);
      const idx = Math.max(1, Math.min(candidates.length, parseInt(a, 10) || 1)) - 1;
      return candidates[idx].seatId;
    },
    async confirmResult({ verdict, approved }) {
      out(`\nVerdict: ${verdict}${approved ? c.green(' (approved)') : c.yellow(' (not approved)')}`);
      const a = await ask('Create local result branch? [y/N]: ');
      const confirm = /^y/i.test(a.trim());
      let override = false;
      if (confirm && !approved) override = /^y/i.test((await ask('Not approved — override & record as UNREVIEWED/OVERRIDDEN? [y/N]: ')).trim());
      return { confirm, override };
    },
  };
}
