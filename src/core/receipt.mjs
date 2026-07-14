// Deterministic, versioned run receipt with exact Git OIDs and SHA-256 artifact
// digests. Full signed attestation is P1; this is the reproducible P0 record.
import { createHash } from 'node:crypto';

export const SCHEMA_RECEIPT = 1;

function sha256(s) {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

/**
 * Build a receipt. All inputs are already-computed facts; this function performs
 * no I/O so it is deterministic given its inputs.
 */
export function buildReceipt({
  runId,
  preset,
  baseCommit,
  reviewedTreeOid,
  resultCommit,
  resultBranch,
  changedManifest, // [{status, path}]
  artifactDigests, // { path: 'sha256:...' | null }
  promptWorkflowDescriptor,
  seats, // [{ seatId, label, adapterId, harnessId, provenance }]
  review, // { verdict, summary, findings, testsRun, limitations } | null
  reviewIntegrity, // 'attested' | 'unattested'
  decisions, // { leaderSeatId, humanOverride?:bool, overrideReason? }
  limitations = [],
  truncations = [], // explicit record of any omitted evidence
}) {
  const receipt = {
    v: SCHEMA_RECEIPT,
    runId,
    preset,
    git: {
      baseCommit: baseCommit || null,
      reviewedTreeOid: reviewedTreeOid || null,
      resultCommit: resultCommit || null,
      resultBranch: resultBranch || null,
    },
    changedManifest: changedManifest || [],
    artifactDigests: artifactDigests || {},
    promptWorkflowDigest: sha256(promptWorkflowDescriptor || ''),
    seats: (seats || []).map((s) => ({
      seatId: s.seatId,
      label: s.label,
      adapterId: s.adapterId,
      harnessId: s.harnessId,
      provenance: s.provenance || null,
    })),
    review: review || null,
    reviewIntegrity: reviewIntegrity || 'unattested',
    decisions: decisions || {},
    limitations,
    truncations,
  };
  // Self-digest over the canonical (sorted-key) JSON, excluding the digest field.
  receipt.receiptDigest = sha256(canonical(receipt));
  return receipt;
}

/** Stable stringify with sorted keys — the basis for a reproducible digest. */
export function canonical(obj) {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === 'receiptDigest') continue;
      out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

/** Recompute and verify a receipt's self-digest. */
export function verifyReceipt(receipt) {
  const expected = sha256(canonical(receipt));
  return expected === receipt.receiptDigest;
}
