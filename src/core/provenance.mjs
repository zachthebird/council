// Model & execution provenance. Release-blocking: requested, configured, and
// runtime-reported model identities are DISTINCT FACTS and never collapsed.

export const SCHEMA_PROVENANCE = 1;

/** Evidence state for a model-identity claim. */
export const ProvenanceState = Object.freeze({
  RUNTIME_REPORTED: 'runtime_reported',
  HARNESS_REPORTED: 'harness_reported',
  CONFIGURED_ONLY: 'configured_only',
  REQUESTED_ONLY: 'requested_only',
  NOT_REPORTED: 'not_reported',
  PARSE_ERROR: 'parse_error',
  MISMATCH_OR_FALLBACK: 'mismatch_or_fallback',
});

export const NOT_REPORTED_LINE = 'Effective model: Not reported by harness';

/**
 * Create a fresh per-turn provenance record. Only `requested*` fields are known
 * at launch; runtime fields are filled by adapter observation events.
 */
export function newProvenance({
  seatId,
  seatLabel,
  adapterId,
  harnessId,
  harnessPath = null,
  harnessVersion = null,
  adapterVersion = null,
  provider = 'unknown',
  requestedModel = null, // null => "Harness default"
  requestedModelSource = 'user', // user | config | default
  configuredModel = null, // from offline probe if the harness exposes it
  requestedEffort = null,
  authLabel = 'authentication unknown',
  sandbox = 'unknown',
  approval = 'unknown',
  network = 'unknown',
  continuity = 'new', // new | native_resume | prompt_rehydration
  sessionId = null,
}) {
  return {
    v: SCHEMA_PROVENANCE,
    seatId,
    seatLabel,
    adapterId,
    harnessId,
    harnessPath,
    harnessVersion,
    adapterVersion,
    provider,
    requestedModel,
    requestedModelSource,
    configuredModel,
    reportedModel: null, // runtime-reported; only set from real evidence
    evidenceSource: null, // e.g. 'stream.system.init' | 'result.usage'
    state: requestedModel ? ProvenanceState.REQUESTED_ONLY : ProvenanceState.NOT_REPORTED,
    requestedEffort,
    reportedEffort: null,
    authLabel,
    sandbox,
    approval,
    network,
    continuity,
    sessionId,
    startedAt: null,
    endedAt: null,
    exitStatus: null,
    usage: null, // only when reliably reported
    history: [], // model-change / fallback history
  };
}

/**
 * Apply a runtime model observation to a provenance record, recording evidence
 * and detecting mismatch/fallback. Returns { prov, mismatch }.
 * `reportedModel` MUST come from harness runtime output, never from prose.
 */
export function observeModel(prov, { reportedModel, evidenceSource, reportedEffort = null, usage = null }) {
  const next = { ...prov, history: [...prov.history] };
  if (reportedEffort != null) next.reportedEffort = reportedEffort;
  if (usage != null) next.usage = usage;
  if (!reportedModel) return { prov: next, mismatch: false };

  const prevReported = next.reportedModel;
  next.reportedModel = reportedModel;
  next.evidenceSource = evidenceSource || next.evidenceSource;
  next.state = ProvenanceState.RUNTIME_REPORTED;

  // Mismatch: requested model was explicit and the reported id doesn't contain it.
  let mismatch = false;
  if (next.requestedModel && !modelsCompatible(next.requestedModel, reportedModel)) {
    next.state = ProvenanceState.MISMATCH_OR_FALLBACK;
    mismatch = true;
  }
  // Fallback mid-run: reported model changed from a previous observation.
  if (prevReported && prevReported !== reportedModel) {
    next.state = ProvenanceState.MISMATCH_OR_FALLBACK;
    mismatch = true;
    next.history.push({ from: prevReported, to: reportedModel, evidenceSource });
  }
  return { prov: next, mismatch };
}

/**
 * Loose compatibility: a requested alias (e.g. "sonnet") is compatible with a
 * reported full id (e.g. "claude-sonnet-4-5-...") if the alias appears as a token.
 * We do NOT invent dated ids; this only compares observed strings.
 */
export function modelsCompatible(requested, reported) {
  if (!requested || !reported) return true;
  const r = String(requested).toLowerCase();
  const rep = String(reported).toLowerCase();
  return rep.includes(r) || r.includes(rep);
}

/** The compact identity line shown in TUI and web. Never fabricates values. */
export function identityLine(prov) {
  const parts = [];
  parts.push(prov.seatLabel || prov.seatId);
  const hv = [prov.harnessId, prov.harnessVersion].filter(Boolean).join(' ');
  if (hv) parts.push(hv);
  parts.push(`provider: ${prov.provider || 'unknown'}`);
  parts.push(`requested: ${prov.requestedModel || 'Harness default'}`);
  if (prov.reportedModel) {
    const src = prov.evidenceSource ? ` (${prov.evidenceSource})` : '';
    parts.push(`reported: ${prov.reportedModel}${src}`);
  } else {
    parts.push('reported: not reported by harness');
  }
  if (prov.requestedEffort) parts.push(`effort: ${prov.requestedEffort}`);
  parts.push(`auth: ${prov.authLabel}`);
  if (prov.sandbox && prov.sandbox !== 'unknown') parts.push(`sandbox: ${prov.sandbox}`);
  return parts.join(' · ');
}

/** The line describing the *effective* model, honoring the truthfulness rule. */
export function effectiveModelLine(prov) {
  if (prov.reportedModel) return `Effective model: ${prov.reportedModel}`;
  return NOT_REPORTED_LINE;
}
