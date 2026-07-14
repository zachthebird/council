// Workflow domain: stages, presets, and the gates that require a human decision.
// Harness-neutral: no vendor concepts appear here.

export const Stage = Object.freeze({
  CREATED: 'created',
  GENERATE: 'generate',
  CRITIQUE: 'critique',
  LEADER_SELECTION: 'leader_selection',
  INTEGRATE: 'integrate',
  REVIEW: 'review',
  REVISE: 'revise',
  RESULT_GATE: 'result_gate',
  CREATE_RESULT: 'create_result',
  FINISHED: 'finished',
  FAILED: 'failed',
});

export const Preset = Object.freeze({
  FULL_MIXTURE: 'full-mixture',
  QUICK_COMPARE: 'quick-compare',
});

/** Ordered stages per preset (excluding terminal states). */
export function stagesFor(preset) {
  if (preset === Preset.QUICK_COMPARE) {
    return [Stage.GENERATE, Stage.LEADER_SELECTION, Stage.REVIEW, Stage.RESULT_GATE, Stage.CREATE_RESULT];
  }
  return [Stage.GENERATE, Stage.CRITIQUE, Stage.LEADER_SELECTION, Stage.INTEGRATE, Stage.REVIEW, Stage.REVISE, Stage.RESULT_GATE, Stage.CREATE_RESULT];
}

/** Human-gated stages. */
export const GATES = new Set([Stage.LEADER_SELECTION, Stage.RESULT_GATE]);

export function isGate(stage) {
  return GATES.has(stage);
}

/** Presets that include cross-critique / integration. */
export function hasIntegration(preset) {
  return preset === Preset.FULL_MIXTURE;
}
