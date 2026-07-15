// Privacy-safe report export (Markdown + JSON). By DEFAULT excludes repository
// content, prompts, absolute paths, account identifiers, and raw tool inputs.
// Explicit inclusion requires --include-content (with a printed preview warning).
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RunStore } from '../storage/store.mjs';
import { parseFlags } from './args.mjs';
import { redactDeep } from '../security/redact.mjs';
import { effectiveModelLine, identityLine } from '../core/provenance.mjs';
import { out, err, c } from './ui.mjs';

/** Strip absolute paths to basenames; drop prompts and raw content. */
function sanitizeState(state) {
  const s = redactDeep(structuredClone(state));
  delete s.task; // prompt content excluded by default
  if (s.seed && s.seed.path) s.seed = { kind: s.seed.kind, path: '(local path omitted)' };
  if (s.seed && s.seed.url) s.seed = { kind: s.seed.kind, url: '(url omitted)' };
  for (const ws of Object.values(s.workspaces || {})) {
    if (ws.dir) ws.dir = basename(ws.dir);
  }
  // Absolute paths must not leak in a privacy-safe export.
  if (s.result && s.result.dir) s.result.dir = '(workspace path omitted)';
  const scrubProv = (p) => {
    if (p && p.harnessPath) p.harnessPath = basename(p.harnessPath);
  };
  for (const p of Object.values(s.provenanceBySeat || {})) scrubProv(p);
  for (const turns of Object.values(s.turnsBySeat || {})) for (const t of turns || []) scrubProv(t.provenance);
  return s;
}

export async function exportRun(rest) {
  const flags = parseFlags(rest);
  const runId = rest.find((a) => !a.startsWith('-'));
  if (!runId) {
    err('export: run-id required');
    return 2;
  }
  const store = new RunStore();
  const state = store.loadState(runId);
  if (!state) {
    err(`export: run not found: ${runId}`);
    return 1;
  }
  const receipt = store.readReceipt(runId);
  const format = flags.format || 'md';
  const includeContent = !!flags['include-content'];
  if (includeContent) out(c.yellow('WARNING: --include-content will embed repository/prompt content. Preview before sharing.'));

  const safeState = includeContent ? state : sanitizeState(state);

  if (format === 'json') {
    const doc = { runId, state: safeState, receipt: receipt ? redactDeep(receipt) : null, exportedWithContent: includeContent };
    const text = JSON.stringify(doc, null, 2);
    return emit(flags, runId, 'json', text);
  }

  const lines = [];
  lines.push(`# Mixture of Harnesses — Run Report`);
  lines.push('');
  lines.push(`- Run: \`${runId}\``);
  lines.push(`- Preset: ${state.preset}`);
  lines.push(`- Status: ${state.status}`);
  lines.push(`- Leader: ${state.leaderSeatId || '—'}`);
  lines.push(`- Review verdict: ${state.review?.verdict || '—'}  (integrity: ${state.reviewIntegrity})`);
  lines.push('');
  lines.push('## Seats & model provenance');
  for (const seat of state.seats) {
    const prov = state.provenanceBySeat?.[seat.seatId];
    lines.push(`### ${seat.label} (${seat.adapterId})`);
    if (prov) {
      lines.push('- ' + identityLine(prov));
      lines.push('- ' + effectiveModelLine(prov));
      lines.push(`- Requested: ${prov.requestedModel || 'Harness default'} · evidence state: ${prov.state}`);
      if (prov.history?.length) lines.push(`- Model fallback history: ${prov.history.map((h) => `${h.from}→${h.to}`).join(', ')}`);
    } else {
      lines.push('- (no provenance recorded)');
    }
    lines.push('');
  }
  if (receipt) {
    lines.push('## Result receipt');
    lines.push('```json');
    lines.push(JSON.stringify({ git: receipt.git, receiptDigest: receipt.receiptDigest, changed: receipt.changedManifest.length, reviewIntegrity: receipt.reviewIntegrity }, null, 2));
    lines.push('```');
  }
  lines.push('');
  lines.push(`_Exported ${includeContent ? 'WITH' : 'without'} repository/prompt content. Local branch only — never pushed._`);
  return emit(flags, runId, 'md', lines.join('\n'));
}

function emit(flags, runId, ext, text) {
  if (flags.o || flags.out) {
    const file = flags.o || flags.out;
    writeFileSync(file, text);
    out(`wrote ${file}`);
  } else {
    out(text);
  }
  return 0;
}
