import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProvenance, observeModel, identityLine, effectiveModelLine, ProvenanceState, NOT_REPORTED_LINE } from '../src/core/provenance.mjs';

function base() {
  return newProvenance({ seatId: 'seat-a', seatLabel: 'Seat A', adapterId: 'fake', harnessId: 'fake', requestedModel: 'alpha' });
}

test('gate 13: no runtime evidence => Not reported by harness', () => {
  const p = newProvenance({ seatId: 's', seatLabel: 'S', adapterId: 'fake', harnessId: 'fake', requestedModel: null });
  assert.equal(p.state, ProvenanceState.NOT_REPORTED);
  assert.equal(effectiveModelLine(p), NOT_REPORTED_LINE);
});

test('gate 12: requested and reported stored separately', () => {
  const { prov } = observeModel(base(), { reportedModel: 'alpha-1', evidenceSource: 'stream.init' });
  assert.equal(prov.requestedModel, 'alpha');
  assert.equal(prov.reportedModel, 'alpha-1');
  assert.equal(prov.state, ProvenanceState.RUNTIME_REPORTED);
});

test('gate 14: mismatch flagged when reported is incompatible with requested', () => {
  const { prov, mismatch } = observeModel(base(), { reportedModel: 'beta-9', evidenceSource: 'stream.init' });
  assert.equal(mismatch, true);
  assert.equal(prov.state, ProvenanceState.MISMATCH_OR_FALLBACK);
});

test('gate 14: mid-turn fallback records history', () => {
  let p = base();
  ({ prov: p } = observeModel(p, { reportedModel: 'alpha-1', evidenceSource: 'a' }));
  const { prov, mismatch } = observeModel(p, { reportedModel: 'alpha-2', evidenceSource: 'b' });
  assert.equal(mismatch, true);
  assert.equal(prov.history.length, 1);
  assert.deepEqual(prov.history[0], { from: 'alpha-1', to: 'alpha-2', evidenceSource: 'b' });
});

test('identity line never invents a reported model', () => {
  const line = identityLine(base());
  assert.match(line, /requested: alpha/);
  assert.match(line, /reported: not reported by harness/);
});
