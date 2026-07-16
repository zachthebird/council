// Guided first-run setup. Explains the privacy model, discovers harnesses, and
// configures two seats independently. Non-interactive fallback writes a safe
// default (two fake seats) so CI/smoke tests never hang.
import { getAdapter } from '../adapters/registry.mjs';
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
    const permissionChoices = new Set(['acceptEdits', 'auto', 'default', 'dontAsk', 'plan', 'bypassPermissions']);
    const answer = (await ask('  permission mode [acceptEdits|auto|default|dontAsk|plan|bypassPermissions] (default acceptEdits): ')).trim() || 'acceptEdits';
    const pm = permissionChoices.has(answer) ? answer : 'acceptEdits';
    if (pm !== answer) out(c.dim('  unsupported permission mode; using acceptEdits'));
    if (pm === 'bypassPermissions') {
      const confirm = (await ask(c.yellow('  ⚠ bypassPermissions disables all permission checks. Type "I understand" to enable: '))).trim();
      permissionMode = confirm === 'I understand' ? 'bypassPermissions' : 'acceptEdits';
      if (permissionMode !== 'bypassPermissions') out(c.dim('  reverted to acceptEdits'));
    } else {
      permissionMode = pm;
    }
  }
  let auth = authDefaults(adapterId);
  if (adapterId === 'claude-code') {
    const choice = (await ask('  authentication [native|api-key-env|oauth-token-env] (default native): ')).trim() || 'native';
    auth = authDefaults(adapterId, choice);
    if (auth.authMode === 'native' && choice !== 'native') out(c.dim('  unsupported authentication mode; using native Claude login'));
  }
  const seat = {
    seatId: label.toLowerCase().replace(/\s+/g, '-'),
    label,
    adapterId,
    requestedModel: model,
    requestedEffort: effort,
    permissionMode,
    ...auth,
  };
  if (adapterId === 'fake') seat.adapterConfig = { reportedModel: `${label.replace(/\s/g, '')}-model`, sessionPrefix: label[0].toLowerCase() };
  return seat;
}

function authDefaults(adapterId, requested = null) {
  if (adapterId === 'fake') return { authMode: 'none', authEnvNames: [], authLabel: 'No authentication required' };
  if (adapterId === 'claude-code') {
    if (requested === 'api-key-env') return { authMode: 'api_key_env', authEnvNames: ['ANTHROPIC_API_KEY'], authLabel: 'ANTHROPIC_API_KEY from environment' };
    if (requested === 'oauth-token-env') return { authMode: 'oauth_token_env', authEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'], authLabel: 'CLAUDE_CODE_OAUTH_TOKEN from environment' };
    return { authMode: 'native', authEnvNames: [], authLabel: 'Claude native login (delegated)' };
  }
  return { authMode: 'delegated', authEnvNames: [], authLabel: 'Harness-managed login (delegated)' };
}

export function defaultConfig(defAdapter) {
  return {
    seats: [
      { seatId: 'seat-a', label: 'Seat A', adapterId: defAdapter, requestedModel: null, ...authDefaults(defAdapter), adapterConfig: defAdapter === 'fake' ? { reportedModel: 'seat-a-model', sessionPrefix: 'a' } : undefined },
      { seatId: 'seat-b', label: 'Seat B', adapterId: 'fake', requestedModel: null, ...authDefaults('fake'), adapterConfig: { reportedModel: null, sessionPrefix: 'b' } },
    ],
    defaultPreset: 'full-mixture',
  };
}
