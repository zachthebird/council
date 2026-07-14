// Versioned harness-adapter contract. The orchestration core depends only on
// THIS module's shapes — never on a vendor adapter. Adapters self-register.

export const ADAPTER_CONTRACT_VERSION = 1;

/** Trust levels for adapters. Third-party adapters require explicit opt-in. */
export const TrustLevel = Object.freeze({
  BUILTIN: 'builtin',
  EXPERIMENTAL: 'experimental',
  THIRD_PARTY: 'third_party',
});

/** Readiness states surfaced by discovery/preflight. */
export const Readiness = Object.freeze({
  READY: 'ready',
  NEEDS_LOGIN: 'needs_login',
  MISSING: 'missing',
  EXPERIMENTAL: 'experimental',
  BLOCKED: 'blocked',
  PROBE_FAILED: 'probe_failed',
  UNAVAILABLE: 'unavailable',
});

/** Capability keys. Each capability is one of the CapabilityState values. */
export const Capability = Object.freeze({
  STRUCTURED_STREAMING: 'structured_streaming',
  FINAL_TEXT_ONLY: 'final_text_only',
  NATIVE_RESUME: 'native_resume',
  PROMPT_REHYDRATED_CONTINUITY: 'prompt_rehydrated_continuity',
  EXPLICIT_MODEL_SELECTION: 'explicit_model_selection',
  MODEL_DISCOVERY: 'model_discovery',
  PROVIDER_SELECTION: 'provider_selection',
  RUNTIME_MODEL_OBSERVATION: 'runtime_model_observation',
  TOOL_EVENTS: 'tool_events',
  USAGE_REPORTING: 'usage_reporting',
  SANDBOX_CONTROLS: 'sandbox_controls',
  APPROVAL_CONTROLS: 'approval_controls',
  NETWORK_POLICY_CONTROLS: 'network_policy_controls',
  INTERACTIVE_AUTH: 'interactive_auth',
  WORKSPACE_ISOLATION: 'workspace_isolation',
});

/** A capability is never fabricated as "supported" without evidence. */
export const CapabilityState = Object.freeze({
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
  EXPERIMENTAL: 'experimental',
  BLOCKED: 'blocked',
});

/**
 * The adapter interface (documented in docs/ADAPTERS.md). An adapter is a plain
 * object; not all methods are required. Optional methods are guarded by capability.
 *
 * Required: id, displayName, version, trustLevel, discover, probeVersion,
 *           probeReadiness, capabilities, prepareInvocation, parseEvents, finalize.
 * Optional: discoverModels, resume, diagnostics, observe.
 *
 * prepareInvocation(turn) MUST return { executable, argv:string[], env, stdin?,
 *   promptFile? } and MUST NOT build a shell command string.
 */
export function assertAdapterShape(a) {
  const required = ['id', 'displayName', 'version', 'trustLevel', 'discover', 'probeVersion', 'probeReadiness', 'capabilities', 'prepareInvocation', 'parseEvents', 'finalize'];
  for (const k of required) {
    if (a[k] === undefined) throw new Error(`adapter ${a.id || '?'} missing required member: ${k}`);
  }
  if (typeof a.prepareInvocation !== 'function') throw new Error(`adapter ${a.id} prepareInvocation must be a function`);
  return true;
}

/** Helper: build a full capability map defaulting unknowns to UNKNOWN. */
export function capabilityMap(overrides = {}) {
  const map = {};
  for (const key of Object.values(Capability)) map[key] = overrides[key] || CapabilityState.UNKNOWN;
  return map;
}

/** Normalized parse result yielded by parseEvents / finalize. */
export function normEvent(kind, payload = {}, provenance = null) {
  return { kind, payload, provenance };
}
