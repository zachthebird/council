// Application service — the ONE core. TUI, web, and CLI automation all drive runs
// through this object and observe the same normalized events. It imports the
// adapter *contract* and registry, never a UI module.
import { join } from 'node:path';
import { EventBus, makeEvent, EventKind } from './events.mjs';
import { makeIdFactory } from './ids.mjs';
import { Stage, Preset, stagesFor, hasIntegration } from './state.mjs';
import { newProvenance, observeModel, ProvenanceState } from './provenance.mjs';
import { newReviewChallenge, parseReview, Verdict, isApproved } from './review.mjs';
import { buildReceipt } from './receipt.mjs';
import { RunStore } from '../storage/store.mjs';
import { getAdapter } from '../adapters/registry.mjs';
import { prepareWorkspace, captureTree, changedPaths, digestFiles, createResultBranch, baseCommit } from '../git/workspace.mjs';
import { workspacesDir } from '../storage/paths.mjs';
import { authPresent } from '../process/env-policy.mjs';
import { stripControl } from '../security/redact.mjs';
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
    this._seq = 0;
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
    this._seq += 1;
    const ts = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
    const evt = makeEvent({ seq: this._seq, runId, ts, ...partial });
    this.store.appendEvent(runId, evt);
    this.bus.emit(evt);
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

  async createRun(config) {
    const runId = this.ids.runId();
    const preset = config.preset || Preset.FULL_MIXTURE;
    const seats = config.seats.map((s, i) => ({
      seatId: s.seatId || (i === 0 ? 'seat-a' : 'seat-b'),
      label: s.label || (i === 0 ? 'Seat A' : 'Seat B'),
      adapterId: s.adapterId,
      requestedModel: s.requestedModel ?? null,
      requestedEffort: s.requestedEffort ?? null,
      permissionMode: s.permissionMode ?? null,
      sandbox: s.sandbox ?? 'unknown',
      authEnvNames: s.authEnvNames ?? [],
      authLabel: s.authLabel,
      adapterConfig: s.adapterConfig ?? {},
    }));
    const state = {
      runId,
      preset,
      task: config.task,
      seed: config.seed,
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
      status: 'running',
    };
    this.store.create(runId, state);
    this._emit(runId, { kind: EventKind.RUN_STARTED, payload: { preset, seatCount: seats.length, task: config.task } });
    return { runId, state };
  }

  _saveStage(state, stage) {
    state.stage = stage;
    state.seq = this._seq;
    this.store.saveState(state.runId, state);
    this._emit(state.runId, { kind: EventKind.STAGE_ENTERED, stage, payload: { stage } });
  }

  /** Prepare an isolated git workspace per seat. */
  _prepareSeatWorkspace(state, seat) {
    const dir = join(this.workspacesRoot, state.runId, seat.seatId);
    const { base } = prepareWorkspace(dir, state.seed);
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

    const onEvent = (ev) => {
      if (abort.signal.aborted) return; // fence late output from superseded attempts
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
      prov.endedAt = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
      prov.exitStatus = 'error';
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_FAILED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { code: 'adapter_error', message: e.message }, provenance: prov });
      return { status: 'failed', finalText: '', sessionId: null, provenance: prov, attemptId };
    }

    prov.endedAt = this.deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
    prov.sessionId = result.sessionId || prov.sessionId;
    prov.exitStatus = result.status;
    if (prov.state === ProvenanceState.REQUESTED_ONLY && !prov.reportedModel) {
      prov.state = seat.requestedModel ? ProvenanceState.REQUESTED_ONLY : ProvenanceState.NOT_REPORTED;
    }
    state.provenanceBySeat[seat.seatId] = prov;

    if (result.status === 'cancelled') {
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_CANCELLED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { role }, provenance: prov });
    } else if (result.status !== 'ok') {
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_FAILED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { code: result.status, message: `turn ${result.status}` }, provenance: prov });
    } else {
      this._emit(state.runId, { kind: EventKind.SEAT_TURN_FINISHED, stage: state.stage, seatId: seat.seatId, attemptId, turnId, payload: { status: result.status, sessionId: result.sessionId }, provenance: prov });
    }
    return { status: result.status, finalText: result.finalText || '', sessionId: result.sessionId || null, provenance: prov, attemptId };
  }

  /** Run the full workflow to completion (or a gate abort). */
  async run(runId) {
    const state = this.store.loadState(runId);
    if (!state) throw new Error(`run not found: ${runId}`);
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

    // --- CRITIQUE (full mixture only, and only with two survivors) ---
    const critique = {};
    if (hasIntegration(state.preset) && !soleSurvivor) {
      this._saveStage(state, Stage.CRITIQUE);
      critique[seatA.seatId] = await this._seatTurn(state, seatA, 'critique', { prompt: P.critiquePrompt({ task: state.task, otherFinalText: gen[seatB.seatId].finalText }) });
      critique[seatB.seatId] = await this._seatTurn(state, seatB, 'critique', { prompt: P.critiquePrompt({ task: state.task, otherFinalText: gen[seatA.seatId].finalText }) });
      this._emit(state.runId, { kind: EventKind.CRITIQUE_READY, stage: Stage.CRITIQUE, payload: { seats: Object.keys(critique) } });
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
    if (hasIntegration(state.preset) && !soleSurvivor) {
      this._saveStage(state, Stage.INTEGRATE);
      const other = state.seats.find((s) => s.seatId !== leaderSeatId);
      await this._seatTurn(state, leader, 'integrate', {
        workspaceDir: leaderDir,
        prompt: P.integrationPrompt({
          task: state.task,
          ownFinalText: gen[leaderSeatId].finalText,
          otherFinalText: gen[other.seatId].finalText,
          otherCritique: critique[other.seatId]?.finalText || '(none)',
        }),
      });
      this._emit(state.runId, { kind: EventKind.INTEGRATION_READY, stage: Stage.INTEGRATE, payload: { leaderSeatId } });
    }

    // Capture the immutable candidate tree from the leader workspace.
    state.candidateTreeOid = captureTree(leaderDir);

    // --- REVIEW (structured, schema-validated, nonce-bound) ---
    let review = await this._reviewCandidate(state, leader, leaderDir);
    let reviewedTree = state.candidateTreeOid;

    // --- REVISE (at most MAX_REVISIONS) then re-review ---
    let revisions = 0;
    while (review && review.verdict === Verdict.REVISE && revisions < MAX_REVISIONS && stages.includes(Stage.REVISE)) {
      this._saveStage(state, Stage.REVISE);
      await this._seatTurn(state, leader, 'revise', { workspaceDir: leaderDir, prompt: P.revisionPrompt({ task: state.task, review }) });
      this._emit(state.runId, { kind: EventKind.REVISION_READY, stage: Stage.REVISE, payload: {} });
      state.candidateTreeOid = captureTree(leaderDir);
      review = await this._reviewCandidate(state, leader, leaderDir);
      reviewedTree = state.candidateTreeOid;
      revisions += 1;
    }

    state.review = review;
    state.reviewedTreeOid = reviewedTree;
    // Review integrity: we read the reviewed artifact bytes from git objects and
    // bind the verdict to a fresh nonce -> attested for this run.
    state.reviewIntegrity = review && review.attested ? 'attested' : 'unattested';

    // Determine final verdict for the gate. A sole-survivor run never yields a clean
    // "approve": the cross-critique mixture the product promises did not occur, so the
    // result is unmistakably UNREVIEWED (the reviewer's findings are still preserved
    // in state.review for transparency) and creation requires an explicit override.
    let verdict = review ? review.verdict : Verdict.UNREVIEWED;
    if (soleSurvivor) verdict = Verdict.UNREVIEWED;

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
      seats: state.seats.map((s) => ({ seatId: s.seatId, label: s.label, adapterId: s.adapterId, harnessId: s.adapterId, provenance: state.provenanceBySeat[s.seatId] || null })),
      review,
      reviewIntegrity: state.reviewIntegrity,
      decisions: { leaderSeatId, humanOverride: !isApproved(verdict), recordVerdict },
      limitations: soleSurvivor ? ['Sole-survivor run: only one seat produced a solution.'] : [],
    });
    this.store.writeReceipt(state.runId, receipt);
    state.receiptDigest = receipt.receiptDigest;

    this._saveStage(state, Stage.FINISHED);
    return { status: 'finished', verdict: recordVerdict, result, receiptDigest: receipt.receiptDigest, soleSurvivor };
  }

  async _reviewCandidate(state, leader, leaderDir) {
    this._saveStage(state, Stage.REVIEW);
    const challenge = newReviewChallenge();
    // Summarize changed files from git OBJECTS (symlink-safe), never worktree reads.
    const changed = changedPaths(leaderDir, state.workspaces[leader.seatId].base, state.candidateTreeOid);
    const summary = changed.map((c) => `${c.status}\t${c.path}`).join('\n') || '(no changes)';
    const turn = await this._seatTurn(state, leader, 'review', {
      workspaceDir: leaderDir,
      prompt: P.reviewPrompt({ task: state.task, changedSummary: summary, challenge }),
      reviewChallenge: challenge,
    });
    if (turn.status !== 'ok') {
      this._emit(state.runId, { kind: EventKind.REVIEW_READY, stage: Stage.REVIEW, payload: { verdict: Verdict.UNREVIEWED, reason: `review turn ${turn.status}` } });
      return { v: 1, verdict: Verdict.UNREVIEWED, summary: `review did not complete (${turn.status})`, findings: [], testsRun: false, limitations: ['review turn failed'], attested: false };
    }
    const parsed = parseReview(turn.finalText, challenge);
    if (!parsed.ok) {
      // Injected/ambiguous/malformed output CANNOT become approved.
      this._emit(state.runId, { kind: EventKind.REVIEW_READY, stage: Stage.REVIEW, payload: { verdict: Verdict.UNREVIEWED, reason: parsed.reason } });
      return { v: 1, verdict: Verdict.UNREVIEWED, summary: `unparseable review: ${parsed.reason}`, findings: [], testsRun: false, limitations: [parsed.reason], attested: false };
    }
    const review = { ...parsed.review, attested: true };
    this._emit(state.runId, { kind: EventKind.REVIEW_READY, stage: Stage.REVIEW, payload: { verdict: review.verdict, summary: review.summary, findings: review.findings } });
    return review;
  }
}
