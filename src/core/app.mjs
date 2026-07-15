// Application service — the ONE core. TUI, web, and CLI automation all drive runs
// through this object and observe the same normalized events. It imports the
// adapter *contract* and registry, never a UI module.
import { join } from 'node:path';
import { EventBus, makeEvent, EventKind } from './events.mjs';
import { makeIdFactory, isSafeSegment, isSafeRunId } from './ids.mjs';
import { Stage, Preset, stagesFor, hasIntegration } from './state.mjs';
import { newProvenance, observeModel, ProvenanceState } from './provenance.mjs';
import { newReviewChallenge, parseReview, Verdict, isApproved } from './review.mjs';
import { buildReceipt } from './receipt.mjs';
import { RunStore } from '../storage/store.mjs';
import { getAdapter } from '../adapters/registry.mjs';
import { prepareWorkspace, captureTree, changedPaths, digestFiles, createResultBranch, buildReviewEvidence, assertInside } from '../git/workspace.mjs';
import { workspacesDir } from '../storage/paths.mjs';
import { authPresent } from '../process/env-policy.mjs';
import { stripControl, redactDeep, sanitizeGitUrl } from '../security/redact.mjs';
import * as P from '../prompts/prompts.mjs';

const MAX_REVISIONS = 1;

/** A decider supplies human decisions at gates. Auto-decider is used by demo/CI. */
export function autoDecider() {
  return {
    async chooseLeader(candidates) {
      return candidates[0].seatId;
    },
    async confirmResult() {
      return { confirm: true };
    },
  };
}

export class Application {
  constructor({ store, deterministic = false, decider = autoDecider(), workspacesRoot = workspacesDir() } = {}) {
    this.store = store || new RunStore();
    this.bus = new EventBus();
    this.ids = makeIdFactory({ deterministic, seed: 'moh-demo' });
    this.deterministic = deterministic;
    this.decider = decider;
    this.workspacesRoot = workspacesRoot;
    this._seqByRun = new Map(); // per-run monotonic sequence
    this._finishedRuns = new Set(); // runs whose RUN_FINISHED was already emitted
    this._cancelled = false;
  }

  subscribe(fn) {
    return this.bus.subscribe(fn);
  }

  cancel() {
    this._cancelled = true;
    if (this._activeAbort) this._activeAbort.abort();
  }

  _emit(runId, partial) {
    // Fence: once a run has finished, no further event may be persisted (late
    // adapter callbacks are dropped). RUN_FINISHED itself is allowed through once.
    const isFinish = partial.kind === EventKind.RUN_FINISHED;
    if (this._finishedRuns.has(runId) && !isFinish) return null;
    const seq = (this._seqByRun.get(runId) || 0) + 1; // PER-RUN monotonic sequence
    this._seqByRun.set(runId, seq);
    const ts = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
    // Redact secret-shaped values and secret-named keys from EVERY event before it
    // is persisted or broadcast (covers text, notices, model metadata, errors).
    const evt = redactDeep(makeEvent({ seq, runId, ts, ...partial }));
    this.store.appendEvent(runId, evt);
    this.bus.emit(evt);
    if (isFinish) this._finishedRuns.add(runId);
    return evt;
  }

  /** Resolve non-secret discovery facts for a seat's adapter (offline). */
  async _seatHarnessFacts(adapter) {
    const disc = await adapter.discover();
    let version = null;
    try {
      version = (await adapter.probeVersion())?.version || null;
    } catch {
      version = null;
    }
    return { harnessPath: disc.realPath || disc.path || null, harnessVersion: version, adapterVersion: adapter.version };
  }

  _authLabel(seat) {
    if (Array.isArray(seat.authEnvNames)) {
      for (const name of seat.authEnvNames) {
        if (authPresent(name)) return `${name} present`;
      }
    }
    return seat.authLabel || 'authentication unknown';
  }

  /** Sanitize a seed spec BEFORE it is persisted; reject embedded credentials. */
  _safeSeed(seed) {
    if (!seed || typeof seed !== 'object') return { kind: 'greenfield' };
    if (seed.kind === 'url') {
      // Throws on credential-bearing URLs so they never reach disk.
      return { kind: 'url', url: sanitizeGitUrl(seed.url, { reject: true }) };
    }
    return seed;
  }

  async createRun(config) {
    const runId = this.ids.runId();
    if (!isSafeRunId(runId)) throw new Error(`generated unsafe run id: ${runId}`);
    const preset = config.preset || Preset.FULL_MIXTURE;
    // P0 supports EXACTLY two seats with UNIQUE ids. Enforce before any workspace is
    // created so a duplicate id can never share/delete another seat's workspace (and
    // never after a paid turn has run).
    if (!Array.isArray(config.seats) || config.seats.length !== 2) {
      throw new Error(`P0 requires exactly two seats (got ${Array.isArray(config.seats) ? config.seats.length : 'none'})`);
    }
    const seatIdSet = new Set();
    for (let i = 0; i < config.seats.length; i++) {
      const id = config.seats[i].seatId || (i === 0 ? 'seat-a' : 'seat-b');
      if (seatIdSet.has(id)) throw new Error(`duplicate seat id: ${JSON.stringify(id)} (seat ids must be unique)`);
      seatIdSet.add(id);
    }
    const seats = config.seats.map((s, i) => {
      const seatId = s.seatId || (i === 0 ? 'seat-a' : 'seat-b');
      // Seat ids become filesystem path segments — reject traversal before use.
      if (!isSafeSegment(seatId)) throw new Error(`unsafe seat id: ${JSON.stringify(seatId)}`);
      return {
      seatId,
      label: s.label || (i === 0 ? 'Seat A' : 'Seat B'),
      adapterId: s.adapterId,
      requestedModel: s.requestedModel ?? null,
      requestedEffort: s.requestedEffort ?? null,
      permissionMode: s.permissionMode ?? null,
      sandbox: s.sandbox ?? 'unknown',
      authEnvNames: s.authEnvNames ?? [],
      authLabel: s.authLabel,
      adapterConfig: s.adapterConfig ?? {},
      };
    });
    const state = {
      runId,
      preset,
      task: config.task,
      seed: this._safeSeed(config.seed),
      stage: Stage.CREATED,
      seats,
      timeoutMs: config.timeoutMs ?? undefined,
      createdAt: this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString(),
      workspaces: {},
      provenanceBySeat: {},
      decisions: {},
      leaderSeatId: null,
      candidateTreeOid: null,
      reviewedTreeOid: null,
      review: null,
      reviewIntegrity: 'unattested',
      result: null,
      limitations: [],
      status: 'running',
    };
    this.store.create(runId, state);
    this._emit(runId, { kind: EventKind.RUN_STARTED, payload: { preset, seatCount: seats.length, task: config.task } });
    return { runId, state };
  }

  _saveStage(state, stage) {
    state.stage = stage;
    state.seq = this._seqByRun.get(state.runId) || 0;
    this.store.saveState(state.runId, state);
    this._emit(state.runId, { kind: EventKind.STAGE_ENTERED, stage, payload: { stage } });
  }

  /** Prepare an isolated git workspace per seat. */
  _prepareSeatWorkspace(state, seat) {
    const root = join(this.workspacesRoot, state.runId);
    const dir = join(root, seat.seatId);
    // Guard: the destination MUST resolve inside the run's workspaces root before
    // prepareWorkspace performs any recursive delete.
    assertInside(this.workspacesRoot, dir);
    const { base } = prepareWorkspace(dir, state.seed, { allowedRoot: this.workspacesRoot, deterministic: this.deterministic });
    state.workspaces[seat.seatId] = { dir, base };
    return dir;
  }

  /**
   * Run one seat turn. Returns { status, finalText, sessionId, provenance }.
   * Attempt-fenced: a superseded (cancelled) attempt's result is ignored by callers.
   */
  async _seatTurn(state, seat, role, ctxExtra = {}) {
    const adapter = getAdapter(seat.adapterId);
    if (!adapter) throw new Error(`unknown adapter: ${seat.adapterId}`);
    const facts = await this._seatHarnessFacts(adapter);
    const attemptId = this.ids.next('att');
    const turnId = this.ids.next('turn');

    let prov = newProvenance({
      seatId: seat.seatId,
      seatLabel: seat.label,
      adapterId: adapter.id,
      harnessId: adapter.id,
      harnessPath: facts.harnessPath,
      harnessVersion: facts.harnessVersion,
      adapterVersion: facts.adapterVersion,
      provider: seat.provider || 'unknown',
      requestedModel: seat.requestedModel,
      requestedModelSource: seat.requestedModel ? 'user' : 'default',
      requestedEffort: seat.requestedEffort,
      authLabel: this._authLabel(seat),
      sandbox: seat.sandbox,
      continuity: ctxExtra.resume ? 'native_resume' : 'new',
    });
    prov.startedAt = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();

    this._emit(state.runId, { kind: EventKind.SEAT_TURN_STARTED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { role }, provenance: prov });

    const abort = new AbortController();
    this._activeAbort = abort;
    const ctx = {
      seatId: seat.seatId,
      seatLabel: seat.label,
      workspaceDir: ctxExtra.workspaceDir || state.workspaces[seat.seatId]?.dir,
      prompt: ctxExtra.prompt,
      role,
      requestedModel: seat.requestedModel,
      requestedEffort: seat.requestedEffort,
      permissionMode: seat.permissionMode,
      sandbox: seat.sandbox,
      adapterConfig: seat.adapterConfig,
      reviewChallenge: ctxExtra.reviewChallenge,
      resume: ctxExtra.resume || null,
      limits: state.timeoutMs ? { timeoutMs: state.timeoutMs } : {},
      signal: abort.signal,
    };

    let turnDone = false; // set once runTurn resolves; fences straggler callbacks
    const onEvent = (ev) => {
      // Fence late/straggler output from a completed, superseded, or cancelled attempt.
      if (turnDone || abort.signal.aborted) return;
      if (ev.kind === 'text') {
        // Neutralize terminal control sequences from untrusted harness output.
        this._emit(state.runId, { kind: EventKind.SEAT_OUTPUT, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { text: stripControl(ev.payload.text) } });
      } else if (ev.kind === 'tool') {
        this._emit(state.runId, { kind: EventKind.SEAT_TOOL, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { name: stripControl(ev.payload.name), summary: stripControl(ev.payload.summary) } });
      } else if (ev.kind === 'model') {
        const { prov: next, mismatch } = observeModel(prov, ev.payload);
        prov = next;
        this._emit(state.runId, { kind: EventKind.SEAT_MODEL_OBSERVED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: {}, provenance: prov });
        if (mismatch) {
          this._emit(state.runId, { kind: EventKind.SEAT_MODEL_MISMATCH, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { requested: prov.requestedModel, reported: prov.reportedModel, history: prov.history }, provenance: prov });
        }
      } else if (ev.kind === 'notice') {
        this._emit(state.runId, { kind: EventKind.NOTICE, stage: state.stage, seatId: seat.seatId, payload: ev.payload });
      }
    };

    if (this._cancelled) abort.abort();
    let result;
    try {
      result = await adapter.runTurn(ctx, { onEvent });
    } catch (e) {
      turnDone = true;
      prov.endedAt = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
      prov.exitStatus = 'error';
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_FAILED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { code: 'adapter_error', message: e.message }, provenance: prov });
      return { status: 'failed', finalText: '', sessionId: null, provenance: prov, attemptId };
    }
    turnDone = true; // no further onEvent callbacks may advance state after this point

    prov.endedAt = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
    prov.sessionId = result.sessionId || prov.sessionId;
    prov.exitStatus = result.status;
    prov.turnId = turnId;
    prov.role = role;
    if (prov.state === ProvenanceState.REQUESTED_ONLY && !prov.reportedModel) {
      prov.state = seat.requestedModel ? ProvenanceState.REQUESTED_ONLY : ProvenanceState.NOT_REPORTED;
    }
    // Accumulate provenance across turns: keep the full per-turn record AND carry
    // cross-turn model-change/fallback history forward so it is never overwritten.
    if (!state.turnsBySeat) state.turnsBySeat = {};
    if (!state.turnsBySeat[seat.seatId]) state.turnsBySeat[seat.seatId] = [];
    const prevAgg = state.provenanceBySeat[seat.seatId];
    const mergedHistory = [...(prevAgg?.history || []), ...prov.history];
    if (prevAgg?.reportedModel && prov.reportedModel && prevAgg.reportedModel !== prov.reportedModel) {
      mergedHistory.push({ from: prevAgg.reportedModel, to: prov.reportedModel, turn: turnId, role, crossTurn: true });
      if (prov.state === ProvenanceState.RUNTIME_REPORTED) prov.state = ProvenanceState.MISMATCH_OR_FALLBACK;
    }
    prov.history = mergedHistory;
    state.turnsBySeat[seat.seatId].push({ turnId, role, stage: state.stage, provenance: JSON.parse(JSON.stringify(prov)) });
    state.provenanceBySeat[seat.seatId] = prov;
    if (mergedHistory.length && mergedHistory[mergedHistory.length - 1]?.crossTurn) {
      this._emit(state.runId, { kind: EventKind.SEAT_MODEL_MISMATCH, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { requested: prov.requestedModel, reported: prov.reportedModel, history: prov.history }, provenance: prov });
    }

    if (result.status === 'cancelled') {
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_CANCELLED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { role }, provenance: prov });
    } else if (result.status !== 'ok') {
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_FAILED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { code: result.status, message: `turn ${result.status}` }, provenance: prov });
    } else {
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_FINISHED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { status: result.status, sessionId: result.sessionId }, provenance: prov });
    }
    return { status: result.status, finalText: result.finalText || '', sessionId: result.sessionId || null, provenance: prov, attemptId };
  }

  /** Terminal run statuses — a completed run is never silently re-driven. */
  static TERMINAL = new Set(['finished', 'failed', 'declined', 'not_created', 'blocked']);

  /**
   * Seed the per-run sequence counter from the durable record so a restarted
   * Application (or any second emitter on the same run) never reuses a seq number.
   */
  _seedSeq(runId, state) {
    if (this._seqByRun.has(runId)) return;
    let max = typeof state?.seq === 'number' ? state.seq : 0;
    // The event log is authoritative for the true high-water mark.
    try {
      for (const e of this.store.readEvents(runId)) if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
    } catch {
      /* ignore */
    }
    this._seqByRun.set(runId, max);
    if (max > 0) this._finishedRuns.delete(runId); // allow appends to continue from max
  }

  /** Run the full workflow to completion (or a gate abort). */
  async run(runId) {
    const state = this.store.loadState(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
    // Refuse to re-drive a completed run: this would repeat paid turns and append a
    // second run.finished. Callers wanting a re-attempt use `resume --retry` (a NEW run).
    if (Application.TERMINAL.has(state.status)) {
      throw new Error(`run ${runId} is already ${state.status}; use \`moh resume ${runId} --retry\` to start a fresh run`);
    }
    this._seedSeq(runId, state); // never reuse a persisted sequence number
    try {
      const outcome = await this._drive(state);
      state.status = outcome.status;
      this.store.saveState(runId, state);
      this._emit(runId, { kind: EventKind.RUN_FINISHED, payload: { status: outcome.status, ...outcome } });
      this.store.release(runId);
      return outcome;
    } catch (e) {
      state.status = 'failed';
      state.stage = Stage.FAILED;
      state.error = e.message;
      this.store.saveState(runId, state);
      this._emit(runId, { kind: EventKind.NOTICE, payload: { level: 'error', message: e.message } });
      this._emit(runId, { kind: EventKind.RUN_FINISHED, payload: { status: 'failed', error: e.message } });
      this.store.release(runId);
      throw e;
    }
  }

  async _drive(state) {
    const [seatA, seatB] = state.seats;
    const stages = stagesFor(state.preset);

    // --- GENERATE (independent, isolated workspaces) ---
    this._saveStage(state, Stage.GENERATE);
    for (const seat of state.seats) this._prepareSeatWorkspace(state, seat);
    const genPrompt = P.generationPrompt({ task: state.task });
    const gen = {};
    for (const seat of state.seats) {
      gen[seat.seatId] = await this._seatTurn(state, seat, 'generate', { prompt: genPrompt });
    }
    const survivors = state.seats.filter((s) => gen[s.seatId].status === 'ok');
    if (survivors.length === 0) {
      return { status: 'failed', reason: 'both seats failed to generate' };
    }
    const soleSurvivor = survivors.length === 1;

    // Peer ACTUAL diffs (read from git objects) so critics/leader see real code,
    // not just a self-reported summary.
    const seatDiff = {};
    for (const s of survivors) seatDiff[s.seatId] = this._seatEvidence(state, s.seatId);

    // --- CRITIQUE (full mixture only, and only with two survivors) ---
    const critique = {};
    let critiqueFailed = false;
    if (hasIntegration(state.preset) && !soleSurvivor) {
      this._saveStage(state, Stage.CRITIQUE);
      critique[seatA.seatId] = await this._seatTurn(state, seatA, 'critique', { prompt: P.critiquePrompt({ task: state.task, otherFinalText: gen[seatB.seatId].finalText, otherDiff: seatDiff[seatB.seatId] }) });
      critique[seatB.seatId] = await this._seatTurn(state, seatB, 'critique', { prompt: P.critiquePrompt({ task: state.task, otherFinalText: gen[seatA.seatId].finalText, otherDiff: seatDiff[seatA.seatId] }) });
      const total = Object.keys(critique).length;
      const failedSeats = Object.entries(critique).filter(([, c]) => c.status !== 'ok').map(([id]) => id);
      // ANY failed cross-critique degrades the mixture: the peer-review step did not
      // fully happen, so the result cannot be a clean, ATTESTED approval and the
      // receipt records a limitation. Only signal readiness when EVERY critique
      // succeeded.
      if (failedSeats.length === 0) {
        this._emit(state.runId, { kind: EventKind.CRITIQUE_READY, stage: Stage.CRITIQUE, payload: { seats: Object.keys(critique) } });
      } else {
        state.critiqueDegraded = true;
        critiqueFailed = true; // any failure blocks a clean attested approval
        state.limitations.push(`Cross-critique incomplete: ${failedSeats.length}/${total} critique turn(s) failed (${failedSeats.join(', ')}).`);
        this._emit(state.runId, { kind: EventKind.NOTICE, stage: Stage.CRITIQUE, payload: { level: 'warn', code: 'critique_incomplete', message: `${failedSeats.length}/${total} critique turn(s) failed; result cannot be cleanly approved` } });
      }
    }

    // --- LEADER SELECTION (gate) ---
    this._saveStage(state, Stage.LEADER_SELECTION);
    let leaderSeatId;
    if (soleSurvivor) {
      leaderSeatId = survivors[0].seatId;
    } else {
      const candidates = survivors.map((s) => ({ seatId: s.seatId, label: s.label, finalText: gen[s.seatId].finalText }));
      leaderSeatId = await this.decider.chooseLeader(candidates);
    }
    state.leaderSeatId = leaderSeatId;
    state.decisions.leaderSeatId = leaderSeatId;
    state.decisions.soleSurvivor = soleSurvivor;
    this._emit(state.runId, { kind: EventKind.LEADER_SELECTED, stage: Stage.LEADER_SELECTION, payload: { leaderSeatId, soleSurvivor } });
    const leader = state.seats.find((s) => s.seatId === leaderSeatId);
    const leaderDir = state.workspaces[leaderSeatId].dir;

    // --- INTEGRATE (full mixture only) ---
    let integrationFailed = false;
    if (hasIntegration(state.preset) && !soleSurvivor) {
      this._saveStage(state, Stage.INTEGRATE);
      const other = state.seats.find((s) => s.seatId !== leaderSeatId);
      const integ = await this._seatTurn(state, leader, 'integrate', {
        workspaceDir: leaderDir,
        prompt: P.integrationPrompt({
          task: state.task,
          ownFinalText: gen[leaderSeatId].finalText,
          otherFinalText: gen[other.seatId].finalText,
          otherDiff: seatDiff[other.seatId],
          otherCritique: critique[other.seatId]?.finalText || '(none)',
        }),
      });
      // Integration failure must NOT be ignored: only signal readiness on success,
      // and prevent a failed integration from ever finishing as a clean approve.
      if (integ.status !== 'ok') {
        integrationFailed = true;
        state.integrationFailed = true;
        state.limitations.push(`Integration turn ${integ.status}; result cannot be cleanly approved.`);
        this._emit(state.runId, { kind: EventKind.NOTICE, stage: Stage.INTEGRATE, payload: { level: 'error', code: 'integration_failed', message: `integration turn ${integ.status}; result cannot be cleanly approved` } });
      } else {
        this._emit(state.runId, { kind: EventKind.INTEGRATION_READY, stage: Stage.INTEGRATE, payload: { leaderSeatId } });
      }
    }

    // Capture the immutable candidate tree from the leader workspace.
    state.candidateTreeOid = captureTree(leaderDir);

    // --- REVIEW (structured, schema-validated, nonce-bound) ---
    let review = await this._reviewCandidate(state, leader, leaderDir);
    let reviewedTree = state.candidateTreeOid;

    // --- REVISE (at most MAX_REVISIONS) then re-review ---
    let revisions = 0;
    let revisionFailed = false;
    while (review && review.verdict === Verdict.REVISE && revisions < MAX_REVISIONS && stages.includes(Stage.REVISE)) {
      this._saveStage(state, Stage.REVISE);
      const rev = await this._seatTurn(state, leader, 'revise', { workspaceDir: leaderDir, prompt: P.revisionPrompt({ task: state.task, review }) });
      // A failed revision must not be treated as a completed one. Do not emit
      // revision.ready, do not re-review a non-revision, and block clean approval.
      if (rev.status !== 'ok') {
        revisionFailed = true;
        state.limitations.push(`Revision turn ${rev.status}; result cannot be cleanly approved.`);
        this._emit(state.runId, { kind: EventKind.NOTICE, stage: Stage.REVISE, payload: { level: 'error', code: 'revision_failed', message: `revision turn ${rev.status}; result cannot be cleanly approved` } });
        break;
      }
      this._emit(state.runId, { kind: EventKind.REVISION_READY, stage: Stage.REVISE, payload: {} });
      state.candidateTreeOid = captureTree(leaderDir);
      review = await this._reviewCandidate(state, leader, leaderDir);
      reviewedTree = state.candidateTreeOid;
      revisions += 1;
    }

    state.review = review;
    state.reviewedTreeOid = reviewedTree;
    // Review integrity is `attested` ONLY when the verdict was parsed from the nonce
    // record, ALL required evidence bytes were read from git objects (no unread
    // truncation), AND no required workflow turn was degraded. Parsing alone is not
    // sufficient, and a degraded mixture is never a clean, attested approval.
    const workflowDegraded = integrationFailed || critiqueFailed || revisionFailed;
    state.reviewIntegrity = review && review.attested && !workflowDegraded ? 'attested' : 'unattested';

    // Determine final verdict for the gate.
    let verdict = review ? review.verdict : Verdict.UNREVIEWED;
    // A sole-survivor run never yields a clean "approve": the cross-critique mixture
    // did not occur. The reviewer's findings are preserved in state.review.
    if (soleSurvivor) verdict = Verdict.UNREVIEWED;
    // A failed required turn (integration, both critiques, or a revision) can never
    // finish as a clean approval.
    if (integrationFailed || critiqueFailed || revisionFailed) verdict = Verdict.UNREVIEWED;
    // An approve that is not attested (unread evidence, or verdict not bound to git
    // objects) must not pass the gate as approved.
    if (isApproved(verdict) && review && !review.attested) verdict = Verdict.UNREVIEWED;

    // --- RESULT GATE (human) ---
    this._saveStage(state, Stage.RESULT_GATE);
    const changed = changedPaths(leaderDir, state.workspaces[leaderSeatId].base, reviewedTree);
    const decision = await this.decider.confirmResult({
      runId: state.runId,
      verdict,
      approved: isApproved(verdict),
      soleSurvivor,
      changed,
      review,
      leaderDir, // internal: lets a caller inspect the reviewed workspace before confirming
    });
    state.decisions.result = decision;

    if (!decision || !decision.confirm) {
      return { status: 'declined', reason: 'human declined result-branch creation', verdict };
    }

    // If not cleanly approved, require explicit override and record it honestly.
    let recordVerdict = verdict;
    if (!isApproved(verdict)) {
      if (!decision.override) {
        return { status: 'not_created', reason: `verdict is ${verdict}; result branch not created (no override)`, verdict };
      }
      recordVerdict = soleSurvivor || verdict === Verdict.UNREVIEWED ? Verdict.UNREVIEWED : Verdict.OVERRIDDEN;
      this._emit(state.runId, { kind: EventKind.NOTICE, payload: { level: 'warn', message: `Result created as ${recordVerdict.toUpperCase()} — not an approved review.` } });
    }

    // --- CREATE RESULT (from the reviewed tree, after a re-check) ---
    this._saveStage(state, Stage.CREATE_RESULT);
    // Re-verify: the current tree must still equal the reviewed tree.
    const currentTree = captureTree(leaderDir);
    if (currentTree !== reviewedTree) {
      return { status: 'blocked', reason: `candidate tree changed after review (${reviewedTree} -> ${currentTree}); refusing to create result branch`, verdict };
    }
    const result = createResultBranch(leaderDir, {
      runId: state.runId,
      treeOid: reviewedTree,
      baseOid: state.workspaces[leaderSeatId].base,
      message: `moh result for ${state.runId}\n\nverdict: ${recordVerdict}\nleader: ${leaderSeatId}`,
      deterministic: this.deterministic,
    });
    state.result = { ...result, verdict: recordVerdict, dir: leaderDir };
    this._emit(state.runId, { kind: EventKind.RESULT_BRANCH_CREATED, stage: Stage.CREATE_RESULT, payload: result });

    // --- Receipt ---
    const changedForReceipt = changedPaths(leaderDir, state.workspaces[leaderSeatId].base, reviewedTree);
    const digests = digestFiles(leaderDir, reviewedTree, changedForReceipt.filter((c) => c.status !== 'D').map((c) => c.path));
    const receipt = buildReceipt({
      runId: state.runId,
      preset: state.preset,
      baseCommit: state.workspaces[leaderSeatId].base,
      reviewedTreeOid: reviewedTree,
      resultCommit: result.commit,
      resultBranch: result.branch,
      changedManifest: changedForReceipt,
      artifactDigests: digests,
      promptWorkflowDescriptor: P.promptWorkflowDescriptor({ preset: state.preset, task: state.task }),
      seats: state.seats.map((s) => ({
        seatId: s.seatId,
        label: s.label,
        adapterId: s.adapterId,
        harnessId: s.adapterId,
        provenance: state.provenanceBySeat[s.seatId] || null,
        // Full per-turn provenance so cross-turn model fallback history is durable.
        turns: (state.turnsBySeat?.[s.seatId] || []).map((t) => ({ turnId: t.turnId, role: t.role, reportedModel: t.provenance.reportedModel, state: t.provenance.state })),
      })),
      review,
      reviewIntegrity: state.reviewIntegrity,
      decisions: { leaderSeatId, humanOverride: !isApproved(verdict), recordVerdict },
      limitations: [
        ...(soleSurvivor ? ['Sole-survivor run: only one seat produced a solution.'] : []),
        ...state.limitations,
        ...(state.review?.truncations?.length ? [`Review evidence truncated for: ${state.review.truncations.join(', ')} (approval not attested).`] : []),
      ],
      truncations: state.review?.truncations || [],
    });
    this.store.writeReceipt(state.runId, receipt);
    state.receiptDigest = receipt.receiptDigest;

    this._saveStage(state, Stage.FINISHED);
    return { status: 'finished', verdict: recordVerdict, result, receiptDigest: receipt.receiptDigest, soleSurvivor };
  }

  /** Evidence (actual changed-file bytes) for a seat, read from git objects. */
  _seatEvidence(state, seatId) {
    const ws = state.workspaces[seatId];
    if (!ws) return '(no workspace)';
    try {
      const tree = captureTree(ws.dir);
      return buildReviewEvidence(ws.dir, ws.base, tree).text;
    } catch {
      return '(evidence unavailable)';
    }
  }

  async _reviewCandidate(state, leader, leaderDir) {
    this._saveStage(state, Stage.REVIEW);
    const challenge = newReviewChallenge();
    const base = state.workspaces[leader.seatId].base;
    const candidateTree = state.candidateTreeOid;
    // Read the ACTUAL candidate bytes from GIT OBJECTS (symlink-safe, immutable),
    // bounded, recording any truncation explicitly.
    const evidence = buildReviewEvidence(leaderDir, base, candidateTree);
    const turn = await this._seatTurn(state, leader, 'review', {
      workspaceDir: leaderDir,
      prompt: P.reviewPrompt({ task: state.task, evidence: evidence.text, challenge }),
      reviewChallenge: challenge,
    });
    if (turn.status !== 'ok') {
      this._emit(state.runId, { kind: EventKind.REVIEW_READY, stage: Stage.REVIEW, payload: { verdict: Verdict.UNREVIEWED, reason: `review turn ${turn.status}` } });
      return { v: 1, verdict: Verdict.UNREVIEWED, summary: `review did not complete (${turn.status})`, findings: [], testsRun: false, limitations: ['review turn failed'], attested: false, reviewedTreeOid: candidateTree, truncations: evidence.truncated };
    }
    const parsed = parseReview(turn.finalText, challenge);
    if (!parsed.ok) {
      // Injected/ambiguous/malformed output CANNOT become approved.
      this._emit(state.runId, { kind: EventKind.REVIEW_READY, stage: Stage.REVIEW, payload: { verdict: Verdict.UNREVIEWED, reason: parsed.reason } });
      return { v: 1, verdict: Verdict.UNREVIEWED, summary: `unparseable review: ${parsed.reason}`, findings: [], testsRun: false, limitations: [parsed.reason], attested: false, reviewedTreeOid: candidateTree, truncations: evidence.truncated };
    }
    // Re-verify the candidate tree is still the exact tree whose bytes were reviewed.
    const stillTree = captureTree(leaderDir);
    const treeStable = stillTree === candidateTree;
    // Attested ONLY when: verdict parsed from the nonce record, evidence read from git
    // objects with NO unread truncation, and the reviewed tree is stable.
    const attested = treeStable && evidence.truncated.length === 0;
    const review = { ...parsed.review, attested, reviewedTreeOid: candidateTree, truncations: evidence.truncated };
    if (evidence.truncated.length) review.limitations = [...review.limitations, `evidence truncated for: ${evidence.truncated.join(', ')} (approval cannot be attested)`];
    this._emit(state.runId, { kind: EventKind.REVIEW_READY, stage: Stage.REVIEW, payload: { verdict: review.verdict, summary: review.summary, findings: review.findings, attested, truncations: evidence.truncated } });
    return review;
  }
}
