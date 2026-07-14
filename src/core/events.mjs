// Versioned, normalized event envelope. Every UI observes these; no vendor
// concepts leak in. `seq` is monotonic per run; `attemptId` fences late output.

export const SCHEMA_EVENT = 1;

/** Canonical event kinds. Payloads are normalized (harness-neutral). */
export const EventKind = Object.freeze({
  RUN_STARTED: 'run.started',
  STAGE_ENTERED: 'stage.entered',
  SEAT_TURN_STARTED: 'seat.turn.started',
  SEAT_OUTPUT: 'seat.output', // { text } incremental normalized text
  SEAT_TOOL: 'seat.tool', // { name, summary }
  SEAT_MODEL_OBSERVED: 'seat.model.observed', // provenance snapshot
  SEAT_MODEL_MISMATCH: 'seat.model.mismatch', // requested != reported
  SEAT_TURN_FINISHED: 'seat.turn.finished', // { status, finalText, sessionId }
  SEAT_TURN_CANCELLED: 'seat.turn.cancelled',
  SEAT_TURN_FAILED: 'seat.turn.failed', // { code, message }
  CRITIQUE_READY: 'critique.ready',
  LEADER_SELECTED: 'leader.selected', // human decision
  INTEGRATION_READY: 'integration.ready',
  REVIEW_READY: 'review.ready', // structured verdict
  REVISION_READY: 'revision.ready',
  RESULT_BRANCH_CREATED: 'result.branch.created',
  RUN_FINISHED: 'run.finished',
  NOTICE: 'notice', // { level, message, code? }
});

/**
 * Build an event envelope.
 * @param {object} p
 */
export function makeEvent({
  seq,
  runId,
  stage = null,
  attemptId = null,
  turnId = null,
  seatId = null,
  kind,
  payload = {},
  provenance = null,
  ts = null,
}) {
  if (!kind) throw new Error('event kind is required');
  return {
    v: SCHEMA_EVENT,
    seq,
    ts: ts ?? new Date().toISOString(),
    runId,
    stage,
    attemptId,
    turnId,
    seatId,
    kind,
    payload,
    provenance,
  };
}

/** A tiny in-process pub/sub used by the application service. */
export class EventBus {
  #subs = new Set();
  emit(evt) {
    for (const fn of this.#subs) {
      try {
        fn(evt);
      } catch {
        // subscriber errors must never break orchestration
      }
    }
  }
  subscribe(fn) {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }
}
