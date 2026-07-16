// Model & execution provenance. Release-blocking: requested, configured, and
// runtime-reported model identities are DISTINCT FACTS and never collapsed.
import { redact, redactDeep, stripControl } from '../security/redact.mjs';

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

const ACCOUNT_KEY = /^(?:account(?:[_-]?id)?|user[_-]?id|email|organization[_-]?id|org[_-]?id|tenant[_-]?id|workspace[_-]?id)$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LABELED_ACCOUNT = /\b((?:account|user|organization|org|tenant|workspace)(?:[\s_-]*id)?|email)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const ACCOUNT_ID = /\b(?:acct|account)[_-][A-Za-z0-9][A-Za-z0-9_-]{3,}\b/gi;
const LONG_PRINCIPAL_ID = /\b(?:org|user|usr|tenant)[_-][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/gi;

function scrubAccountString(value) {
  return redact(stripControl(String(value)))
    .replace(EMAIL, '[account omitted]')
    .replace(LABELED_ACCOUNT, '$1=[account omitted]')
    .replace(ACCOUNT_ID, '[account omitted]')
    .replace(LONG_PRINCIPAL_ID, '[account omitted]');
}

function scrubAccountValues(value) {
  if (typeof value === 'string') return scrubAccountString(value);
  if (Array.isArray(value)) return value.map(scrubAccountValues);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = ACCOUNT_KEY.test(key) ? '[account omitted]' : scrubAccountValues(item);
  }
  return out;
}

/** Redact secrets and account identifiers from untrusted runtime metadata. */
export function sanitizeRuntimeMetadata(value) {
  return value == null ? value : scrubAccountValues(redactDeep(value));
}

/** Project an untrusted runtime model field onto a bounded, persistence-safe string. */
export function sanitizeReportedModel(value) {
  if (value == null) return null;
  const safe = scrubAccountString(value).trim().slice(0, 512);
  return safe || null;
}

function safeRuntimeString(value, maxLength) {
  if (value == null) return null;
  const safe = scrubAccountString(value).trim().slice(0, maxLength);
  return safe || null;
}

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
  profile = null,
  requestedModel = null, // null => "Harness default"
  requestedModelSource = 'user', // user | config | default
  configuredModel = null, // from offline probe if the harness exposes it
  modelPolicy = null,
  modelCatalog = null,
  modelCatalogSource = null,
  modelCatalogCheckedAt = null,
  modelClaim = null,
  requestedEffort = null,
  authLabel = 'authentication unknown',
  authMode = null,
  authEnvNames = [],
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
    profile,
    requestedModel,
    requestedModelSource,
    configuredModel,
    modelPolicy,
    modelCatalog,
    modelCatalogSource,
    modelCatalogCheckedAt,
    modelClaim,
    reportedModel: null, // runtime-reported; only set from real evidence
    evidenceSource: null, // e.g. 'stream.system.init' | 'result.usage'
    state: requestedModel ? ProvenanceState.REQUESTED_ONLY : configuredModel ? ProvenanceState.CONFIGURED_ONLY : ProvenanceState.NOT_REPORTED,
    requestedEffort,
    reportedEffort: null,
    authLabel,
    authMode,
    authEnvNames: Array.isArray(authEnvNames) ? [...authEnvNames] : [],
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
    modelObservations: [], // distinct runtime model/evidence observations
  };
}

/**
 * Apply a runtime model observation to a provenance record, recording evidence
 * and detecting mismatch/fallback. Returns { prov, mismatch }.
 * `reportedModel` MUST come from harness runtime output, never from prose.
 */
export function observeModel(prov, { reportedModel, evidenceSource, reportedEffort = null, usage = null }) {
  const next = {
    ...prov,
    history: [...(prov.history || [])],
    modelObservations: [...(prov.modelObservations || [])],
  };
  const safeModel = sanitizeReportedModel(reportedModel);
  const safeEvidenceSource = safeRuntimeString(evidenceSource, 256);
  if (reportedEffort != null) next.reportedEffort = safeRuntimeString(reportedEffort, 64);
  if (usage != null) next.usage = sanitizeRuntimeMetadata(usage);
  if (!safeModel) return { prov: next, mismatch: false };

  const prevReported = next.reportedModel;
  const repeatedModel = prevReported === safeModel;
  next.reportedModel = safeModel;
  next.evidenceSource = safeEvidenceSource || next.evidenceSource;
  next.state = ProvenanceState.RUNTIME_REPORTED;
  const observation = { reportedModel: safeModel, evidenceSource: safeEvidenceSource };
  if (!next.modelObservations.some((item) => item.reportedModel === observation.reportedModel && item.evidenceSource === observation.evidenceSource)) {
    next.modelObservations.push(observation);
  }

  // Mismatch: an explicit request was not satisfied by the runtime-reported id.
  let mismatch = false;
  if (next.requestedModel && !modelsCompatible(next.requestedModel, safeModel)) {
    next.state = ProvenanceState.MISMATCH_OR_FALLBACK;
    // Streams commonly repeat the same model at init, assistant, and result. The
    // provenance remains mismatched, but callers warn only on the first model id.
    mismatch = !repeatedModel;
  }
  // Fallback mid-run: reported model changed from a previous observation.
  if (prevReported && prevReported !== safeModel) {
    next.state = ProvenanceState.MISMATCH_OR_FALLBACK;
    mismatch = true;
    next.history.push({ from: prevReported, to: safeModel, evidenceSource: safeEvidenceSource });
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
  const r = String(requested).trim().toLowerCase();
  const rep = String(reported).trim().toLowerCase();
  if (r === rep) return true;
  // A digit-bearing request is an exact-looking version/model slug (gpt-5.6,
  // o3, claude-4-opus). Treating it as a substring would wrongly claim that a
  // different variant such as gpt-5.6-mini satisfied the request.
  if (/\d/.test(r)) return false;
  // Loose matching is reserved for clear, non-version aliases. Require slug-token
  // boundaries so "son" cannot accidentally match "sonnet".
  if (!/^[a-z]+(?:[-_.:/][a-z]+)*$/.test(r)) return false;
  const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[-_.:/])${escaped}(?:$|[-_.:/])`).test(rep);
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
