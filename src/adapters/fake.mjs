// Deterministic, zero-token fake harness. Powers `moh demo` and every test.
// It writes REAL files into the seat workspace (so git captures a real tree),
// emits normalized events through its OWN streaming JSONL parser (exercising the
// fragmentation-tolerant parse path), and honestly models both reported-model and
// not-reported-by-harness provenance, plus a mid-run fallback.
import { writeFileSync, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join, dirname } from 'node:path';
import { TrustLevel, Readiness, Capability, CapabilityState, capabilityMap, normEvent } from './contract.mjs';
import { serializeReview } from '../core/review.mjs';

function writeFile(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// --- Native fake JSONL parser (conformance target: fragmented UTF-8, unknown t, unknown fields) ---
export function fakeParseEvents(chunk, state) {
  // state.buf is a string accumulator; caller passes decoded strings.
  state.buf = (state.buf || '') + chunk;
  const events = [];
  let nl;
  while ((nl = state.buf.indexOf('\n')) !== -1) {
    const line = state.buf.slice(0, nl);
    state.buf = state.buf.slice(nl + 1);
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      events.push(normEvent('notice', { level: 'warn', message: 'malformed fake line ignored' }));
      continue;
    }
    switch (obj.t) {
      case 'init':
        state.sessionId = obj.session;
        if (obj.model) events.push(normEvent('model', { reportedModel: obj.model, evidenceSource: 'fake.init' }));
        break;
      case 'text':
        events.push(normEvent('text', { text: String(obj.chunk ?? '') }));
        break;
      case 'tool':
        events.push(normEvent('tool', { name: obj.name, summary: obj.summary }));
        break;
      case 'model':
        if (obj.model) events.push(normEvent('model', { reportedModel: obj.model, evidenceSource: 'fake.model' }));
        break;
      case 'final':
        state.finalText = String(obj.text ?? '');
        state.sessionId = obj.session ?? state.sessionId;
        if (obj.model) events.push(normEvent('model', { reportedModel: obj.model, evidenceSource: 'fake.final', usage: obj.usage || null }));
        events.push(normEvent('final', { finalText: state.finalText, sessionId: state.sessionId, usage: obj.usage || null }));
        break;
      default:
        // Unknown event type / forward-compatible fields: ignore without crashing.
        break;
    }
  }
  return events;
}

function personaSolution(seatLabel, prompt) {
  return `# Solution by ${seatLabel}\n\nTask: ${prompt}\n\nApproach: ${seatLabel} implements a small, well-tested greeting utility.\n`;
}

function greetingCode(seatLabel) {
  return `export function greet(name) {\n  // authored by seat ${seatLabel}\n  return \`Hello, \${name}!\`;\n}\n`;
}

/**
 * Build the deterministic native JSONL transcript for a turn, given a role.
 * The fake also reflects a per-seat provenance profile passed via config.
 */
function buildTranscript(ctx) {
  const cfg = ctx.adapterConfig || {};
  const label = ctx.seatLabel;
  const lines = [];
  // Model reporting profile: profile.reportedModel or null (not reported).
  // A "fallback" on the integrate role demonstrates mismatch/fallback history.
  let reported = cfg.reportedModel ?? null;
  if (cfg.fallbackOnIntegrate && ctx.role === 'integrate' && reported) reported = cfg.fallbackModel || reported + '-fallback';

  lines.push(JSON.stringify({ t: 'init', session: `${cfg.sessionPrefix || 'fake'}-${ctx.seatId}`, model: reported }));

  let finalText = '';
  if (ctx.role === 'generate') {
    writeFile(ctx.workspaceDir, 'solution.md', personaSolution(label, ctx.prompt));
    writeFile(ctx.workspaceDir, 'src/greeting.mjs', greetingCode(label));
    lines.push(JSON.stringify({ t: 'tool', name: 'write_file', summary: 'solution.md' }));
    lines.push(JSON.stringify({ t: 'tool', name: 'write_file', summary: 'src/greeting.mjs' }));
    lines.push(JSON.stringify({ t: 'text', chunk: `${label}: implemented greet().` }));
    finalText = `${label} produced a greeting utility with a solution write-up.`;
  } else if (ctx.role === 'critique') {
    lines.push(JSON.stringify({ t: 'text', chunk: `${label}: critique of the other seat.` }));
    finalText = `${label} critique: the other solution is reasonable but should document edge cases (empty name).`;
  } else if (ctx.role === 'integrate') {
    writeFile(ctx.workspaceDir, 'solution.md', personaSolution(label, ctx.prompt) + '\nIntegrated critique: handle empty names.\n');
    writeFile(ctx.workspaceDir, 'src/greeting.mjs', greetingCode(label).replace('return `Hello', 'if (!name) name = "world";\n  return `Hello'));
    lines.push(JSON.stringify({ t: 'tool', name: 'write_file', summary: 'integrated solution' }));
    finalText = `${label} integrated the strongest ideas from both seats.`;
  } else if (ctx.role === 'review') {
    // Emit the anchored review control record bound to the run's nonce.
    const review = {
      v: 1,
      verdict: cfg.reviewVerdict || 'approve',
      summary: 'Greeting utility handles the empty-name edge case and is documented.',
      findings: [{ severity: 'info', path: 'src/greeting.mjs', message: 'Consider trimming whitespace-only names.' }],
      testsRun: true,
      limitations: ['Reviewed with a deterministic fake harness; no real model executed.'],
    };
    finalText = 'Review complete.\n' + serializeReview(review, ctx.reviewChallenge);
  } else if (ctx.role === 'revise') {
    writeFile(ctx.workspaceDir, 'src/greeting.mjs', greetingCode(label).replace('return `Hello', 'name = String(name).trim() || "world";\n  return `Hello'));
    lines.push(JSON.stringify({ t: 'tool', name: 'write_file', summary: 'apply review revision' }));
    finalText = `${label} applied the reviewer's revision (trim whitespace-only names).`;
  } else {
    finalText = `${label} completed turn.`;
  }

  lines.push(JSON.stringify({ t: 'final', text: finalText, session: `${cfg.sessionPrefix || 'fake'}-${ctx.seatId}`, model: reported, usage: reported ? { input_tokens: 0, output_tokens: 0, note: 'fake' } : null }));
  return lines.join('\n') + '\n';
}

export const fakeAdapter = {
  id: 'fake',
  displayName: 'Fake Harness (deterministic)',
  version: '1.0.0',
  contractVersion: 1,
  trustLevel: TrustLevel.BUILTIN,

  async discover() {
    return { found: true, path: '(builtin)', realPath: '(builtin)' };
  },
  async probeVersion() {
    return { version: '1.0.0' };
  },
  async probeReadiness() {
    return { readiness: Readiness.READY, authLabel: 'no auth required (deterministic)', detail: 'Always ready; makes no network calls.' };
  },
  capabilities() {
    return capabilityMap({
      [Capability.STRUCTURED_STREAMING]: CapabilityState.SUPPORTED,
      [Capability.FINAL_TEXT_ONLY]: CapabilityState.SUPPORTED,
      [Capability.NATIVE_RESUME]: CapabilityState.SUPPORTED,
      [Capability.EXPLICIT_MODEL_SELECTION]: CapabilityState.SUPPORTED,
      [Capability.RUNTIME_MODEL_OBSERVATION]: CapabilityState.SUPPORTED,
      [Capability.TOOL_EVENTS]: CapabilityState.SUPPORTED,
      [Capability.USAGE_REPORTING]: CapabilityState.SUPPORTED,
      [Capability.WORKSPACE_ISOLATION]: CapabilityState.SUPPORTED,
    });
  },

  // In-process execution — no subprocess, no tokens. Still routes through the
  // streaming parser to exercise it.
  async runTurn(ctx, hooks) {
    const cfg = ctx.adapterConfig || {};
    // Test hook: force a failure at a chosen role (e.g. generate) to exercise
    // sole-survivor / one-seat-failure paths deterministically.
    if (cfg.forceFail && (cfg.forceFailRole ? cfg.forceFailRole === ctx.role : true)) {
      hooks?.onEvent?.({ kind: 'notice', payload: { level: 'error', message: 'forced failure (test)' } });
      return { status: 'failed', finalText: '', sessionId: null };
    }
    const transcript = buildTranscript(ctx);
    const state = {};
    // Feed the transcript in small chunks through a StringDecoder — exactly like the
    // process supervisor does — so split multibyte characters are preserved.
    const bytes = Buffer.from(transcript, 'utf8');
    const dec = new StringDecoder('utf8');
    const results = [];
    for (let i = 0; i < bytes.length; i += 7) {
      if (ctx.signal?.aborted) {
        return { status: 'cancelled', finalText: '', sessionId: state.sessionId || null };
      }
      const slice = dec.write(bytes.subarray(i, i + 7)); // byte-safe across boundaries
      if (!slice) continue;
      for (const ev of fakeParseEvents(slice, state)) {
        results.push(ev);
        hooks?.onEvent?.(ev);
      }
    }
    const tail = dec.end();
    if (tail) for (const ev of fakeParseEvents(tail, state)) { results.push(ev); hooks?.onEvent?.(ev); }
    return {
      status: 'ok',
      finalText: state.finalText || '',
      sessionId: state.sessionId || null,
      events: results,
    };
  },

  // Contract-required members (also used by conformance tests).
  prepareInvocation(ctx) {
    // The fake does not spawn a process; expose a nominal invocation for tests.
    return { executable: '(builtin)', argv: ['--fake', ctx.role || 'generate'], env: {}, stdin: null };
  },
  parseEvents: fakeParseEvents,
  finalize(state) {
    return { finalText: state.finalText || '', sessionId: state.sessionId || null };
  },
  async diagnostics() {
    return { ok: true, notes: ['deterministic; no external dependencies'] };
  },
};
