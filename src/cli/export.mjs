// Privacy-safe report export (Markdown + JSON). By DEFAULT excludes repository
// content, prompts, absolute paths, account identifiers, and raw tool inputs.
// Explicit inclusion requires --include-content (with a printed preview warning).
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RunStore } from '../storage/store.mjs';
import { parseFlags } from './args.mjs';
import { redactDeep, stripControl, scrubUserPaths } from '../security/redact.mjs';
import { effectiveModelLine, identityLine } from '../core/provenance.mjs';
import { out, err, c } from './ui.mjs';

/** Scrub absolute harness paths from a receipt (default privacy-safe export). */
function sanitizeReceipt(receipt) {
  const r = redactDeep(structuredClone(receipt));
  for (const s of r.seats || []) {
    if (s.provenance?.harnessPath) s.provenance.harnessPath = basename(s.provenance.harnessPath);
  }
  // Final pass: collapse any remaining home-dir path in an unenumerated field.
  return scrubUserPaths(r);
}
/** Neutralize control chars / markdown-breaking content in a rendered value. */
function md(v) {
  return stripControl(String(v ?? '')).replace(/[\r\n]+/g, ' ');
}

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
  // Final pass: collapse any home-dir path that survived in an unenumerated
  // field (error strings, review prose, config) — the privacy-safe export must
  // never leak the username / home path.
  return scrubUserPaths(s);
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

  // --include-content includes repository/prompt CONTENT, but NEVER secrets:
  // redaction of secret-shaped values and secret-named keys is unconditional.
  const safeState = includeContent ? redactDeep(structuredClone(state)) : sanitizeState(state);
  const safeReceipt = receipt ? (includeContent ? redactDeep(receipt) : sanitizeReceipt(receipt)) : null;

  if (format === 'json') {
    const doc = { runId, state: safeState, receipt: safeReceipt, exportedWithContent: includeContent };
    const text = JSON.stringify(doc, null, 2);
    return emit(flags, runId, 'json', text);
  }

  // Markdown renders from the SANITIZED state, and every interpolated value is passed
  // through md() (control-char + newline stripped) to prevent markdown/terminal injection.
  const lines = [];
  lines.push(`# Mixture of Harnesses — Run Report`);
  lines.push('');
  lines.push(`- Run: \`${md(runId)}\``);
  lines.push(`- Preset: ${md(safeState.preset)}`);
  lines.push(`- Status: ${md(safeState.status)}`);
  lines.push(`- Leader: ${md(safeState.leaderSeatId || '—')}`);
  lines.push(`- Review verdict: ${md(safeState.review?.verdict || '—')}  (integrity: ${md(safeState.reviewIntegrity)})`);
  lines.push('');
  lines.push('## Seats & model provenance');
  for (const seat of safeState.seats) {
    const prov = safeState.provenanceBySeat?.[seat.seatId];
    lines.push(`### ${md(seat.label)} (${md(seat.adapterId)})`);
    if (prov) {
      lines.push('- ' + md(identityLine(prov)));
      lines.push('- ' + md(effectiveModelLine(prov)));
      lines.push(`- Requested: ${md(prov.requestedModel || 'Harness default')} · evidence state: ${md(prov.state)}`);
      if (prov.history?.length) lines.push(`- Model fallback history: ${md(prov.history.map((h) => `${h.from}→${h.to}`).join(', '))}`);
    } else {
      lines.push('- (no provenance recorded)');
    }
    lines.push('');
  }
  if (safeReceipt) {
    lines.push('## Result receipt');
    lines.push('```json');
    lines.push(JSON.stringify({ git: safeReceipt.git, receiptDigest: safeReceipt.receiptDigest, changed: (safeReceipt.changedManifest || []).length, reviewIntegrity: safeReceipt.reviewIntegrity }, null, 2));
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
