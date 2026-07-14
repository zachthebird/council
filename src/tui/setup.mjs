// Guided first-run setup. Explains the privacy model, discovers harnesses, and
// configures two seats independently. Non-interactive fallback writes a safe
// default (two fake seats) so CI/smoke tests never hang.
import { listAdapters, getAdapter } from '../adapters/registry.mjs';
import { Readiness } from '../adapters/contract.mjs';
import { doctor } from '../cli/doctor.mjs';
import { ask } from '../cli/prompt.mjs';
import { saveConfig } from './config.mjs';
import { out, heading, kv, c } from '../cli/ui.mjs';

export async function runSetup() {
  heading('Mixture of Harnesses — Setup');
  out('Privacy model: local-first. Repositories, harness processes, and delegated');
  out('authorization stay on this machine. moh stores only non-secret labels (e.g.');
  out('"ANTHROPIC_API_KEY present"), never secret values, and never pushes branches.\n');

  const report = await doctor();
  heading('Discovered harnesses');
  for (const a of report.adapters) {
    kv(a.displayName, `${a.readiness}${a.version ? ' · ' + a.version : ''}`);
    if (a.detail && a.readiness !== Readiness.READY) out('    ' + c.dim(a.detail));
  }

  const ready = report.adapters.filter((a) => a.readiness === Readiness.READY);
  const options = report.adapters.map((a) => a.id);

  // Non-interactive: write a safe default and exit.
  if (!process.stdin.isTTY) {
    const defA = ready.find((a) => a.id !== 'fake')?.id || 'fake';
    const cfg = defaultConfig(defA);
    const file = saveConfig(cfg);
    out('\n' + c.green(`Non-interactive setup wrote defaults to ${file}`));
    return 0;
  }

  heading('Configure two seats');
  out(c.dim('Either seat may use any ready adapter — including two profiles of the same harness.'));
  const seatA = await configureSeat('Seat A', options, ready);
  const seatB = await configureSeat('Seat B', options, ready);

  const cfg = { seats: [seatA, seatB], defaultPreset: 'full-mixture' };
  const file = saveConfig(cfg);
  heading('Saved');
  kv('config', file);
  out(c.green('Setup complete. Run `moh demo` or `moh run --task "..."`.'));
  return 0;
}

async function configureSeat(label, options, ready) {
  out('\n' + c.bold(label));
  out('  adapters: ' + options.join(', '));
  const idAns = (await ask(`  adapter for ${label} (default ${ready.find((a) => a.id !== 'fake')?.id || 'fake'}): `)).trim();
  const adapterId = options.includes(idAns) ? idAns : ready.find((a) => a.id !== 'fake')?.id || 'fake';
  const model = (await ask(`  requested model (blank = harness default): `)).trim() || null;
  const effort = (await ask(`  effort (blank = default): `)).trim() || null;
  const adapter = getAdapter(adapterId);
  let permissionMode = null;
  if (adapterId === 'claude-code') {
    const pm = (await ask('  permission mode [acceptEdits|plan|bypassPermissions] (default acceptEdits): ')).trim() || 'acceptEdits';
    if (pm === 'bypassPermissions') {
      const confirm = (await ask(c.yellow('  ⚠ bypassPermissions disables all permission checks. Type "I understand" to enable: '))).trim();
      permissionMode = confirm === 'I understand' ? 'bypassPermissions' : 'acceptEdits';
      if (permissionMode !== 'bypassPermissions') out(c.dim('  reverted to acceptEdits'));
    } else {
      permissionMode = pm;
    }
  }
  const seat = {
    seatId: label.toLowerCase().replace(/\s+/g, '-'),
    label,
    adapterId,
    requestedModel: model,
    requestedEffort: effort,
    permissionMode,
    authEnvNames: adapterId === 'claude-code' ? ['ANTHROPIC_API_KEY'] : [],
  };
  if (adapterId === 'fake') seat.adapterConfig = { reportedModel: `${label.replace(/\s/g, '')}-model`, sessionPrefix: label[0].toLowerCase() };
  return seat;
}

function defaultConfig(defAdapter) {
  return {
    seats: [
      { seatId: 'seat-a', label: 'Seat A', adapterId: defAdapter, requestedModel: null, authEnvNames: defAdapter === 'claude-code' ? ['ANTHROPIC_API_KEY'] : [], adapterConfig: defAdapter === 'fake' ? { reportedModel: 'seat-a-model', sessionPrefix: 'a' } : undefined },
      { seatId: 'seat-b', label: 'Seat B', adapterId: 'fake', requestedModel: null, adapterConfig: { reportedModel: null, sessionPrefix: 'b' } },
    ],
    defaultPreset: 'full-mixture',
  };
}
