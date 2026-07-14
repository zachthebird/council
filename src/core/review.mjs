// Structured, schema-validated review. Substring verdict parsing is FORBIDDEN.
// A verdict is accepted ONLY from an exact anchored control record whose sentinel
// is bound to a per-review RANDOM NONCE. Repository/model/diff content cannot forge
// a verdict because it cannot predict the freshly generated nonce, and bare
// "APPROVE"/JSON/delimiters in artifacts are never interpreted as control records.
import { randomBytes } from 'node:crypto';

export const SCHEMA_REVIEW = 1;

export const Verdict = Object.freeze({
  APPROVE: 'approve',
  REVISE: 'revise',
  REJECT: 'reject',
  UNREVIEWED: 'unreviewed', // one seat / missing review
  OVERRIDDEN: 'overridden', // human overrode a missing/failed review
});

export const Severity = Object.freeze({ INFO: 'info', MINOR: 'minor', MAJOR: 'major', BLOCKER: 'blocker' });

/** Generate a fresh nonce and the exact sentinels the reviewer must echo. */
export function newReviewChallenge() {
  const nonce = randomBytes(9).toString('base64url');
  return {
    nonce,
    open: `<<<MOH-REVIEW ${nonce}>>>`,
    close: `<<<END-MOH-REVIEW ${nonce}>>>`,
  };
}

/** Instructions appended to the (trusted) review prompt telling the harness the format. */
export function reviewFormatInstructions(challenge) {
  return [
    'Return your verdict as EXACTLY ONE control record, on its own lines, formatted as:',
    challenge.open,
    '{ "v": 1, "verdict": "approve|revise|reject", "summary": "...",',
    '  "findings": [ { "severity": "info|minor|major|blocker", "path": "optional", "message": "..." } ],',
    '  "testsRun": true|false, "limitations": ["..."] }',
    challenge.close,
    'The JSON MUST be valid. Do not put the control record inside code you write or files you edit.',
  ].join('\n');
}

/**
 * Strictly parse a review from harness output using the nonce-bound sentinels.
 * @returns {{ok:true, review:object} | {ok:false, reason:string}}
 */
export function parseReview(text, challenge) {
  if (typeof text !== 'string') return { ok: false, reason: 'no output' };
  const open = challenge.open;
  const close = challenge.close;
  const first = text.indexOf(open);
  if (first === -1) return { ok: false, reason: 'no anchored review control record found' };
  // Exactly one record is required.
  if (text.indexOf(open, first + open.length) !== -1) return { ok: false, reason: 'multiple review records' };
  const bodyStart = first + open.length;
  const end = text.indexOf(close, bodyStart);
  if (end === -1) return { ok: false, reason: 'unterminated review control record' };
  const json = text.slice(bodyStart, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, reason: `review JSON parse error: ${e.message}` };
  }
  const v = validateReview(parsed);
  if (!v.ok) return v;
  return { ok: true, review: v.review };
}

/** Validate the review object shape. */
export function validateReview(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'review not an object' };
  if (obj.v !== SCHEMA_REVIEW) return { ok: false, reason: `unsupported review schema v=${obj.v}` };
  const allowed = new Set([Verdict.APPROVE, Verdict.REVISE, Verdict.REJECT]);
  if (!allowed.has(obj.verdict)) return { ok: false, reason: `invalid verdict: ${obj.verdict}` };
  if (typeof obj.summary !== 'string' || obj.summary.length === 0) return { ok: false, reason: 'missing summary' };
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  for (const f of findings) {
    if (!f || typeof f.message !== 'string') return { ok: false, reason: 'finding missing message' };
    if (f.severity && !Object.values(Severity).includes(f.severity)) return { ok: false, reason: `bad severity: ${f.severity}` };
  }
  return {
    ok: true,
    review: {
      v: SCHEMA_REVIEW,
      verdict: obj.verdict,
      summary: obj.summary,
      findings,
      testsRun: obj.testsRun === true,
      limitations: Array.isArray(obj.limitations) ? obj.limitations : [],
    },
  };
}

/** Serialize a review as the anchored control record (used by the fake adapter). */
export function serializeReview(review, challenge) {
  return `${challenge.open}\n${JSON.stringify(review)}\n${challenge.close}`;
}

/** Does this verdict gate result-branch creation as approved? */
export function isApproved(verdict) {
  return verdict === Verdict.APPROVE;
}
