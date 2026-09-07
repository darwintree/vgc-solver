import assert from 'node:assert/strict';
import test from 'node:test';
import {BoundedSolver} from '../src/bounded-solver';
import {createTurnCursor, type TransitionProgress} from '../src/progressive-transition';
import {createBattle, snapshotBattle} from '../src/showdown-adapter';
import {assertSameDistribution, enumerateNative} from './helpers/distribution';

function partialSolver(tolerance: number) {
  let batches = 0;
  const solver = new BoundedSolver({tolerance, adapter: {
    snapshotBattle: state => state,
    restoreBattle: state => state,
    stateKey: String,
    terminalUtility: () => null,
    legalActions: () => ['a'],
    enumerateTurn: () => { throw new Error('cursor adapter expected'); },
    createTurnCursor: () => ({advance: (): TransitionProgress => {
      batches++;
      const loss = batches === 1 ? 0 : batches === 2 ? 0.3 : 0.4;
      return {outcomes: [{utility: 1, probability: 0.6}, {utility: -1, probability: loss}],
        remainingProbability: 0.4 - loss, complete: batches === 3, simulatorRuns: 1};
    }}),
  }});
  return {solver, batches: () => batches};
}

test('partial probability remains adversarial uncertainty and can certify before completion', () => {
  const {solver, batches} = partialSolver(0.3);
  const result = solver.solve('root');
  assert.equal(result.converged, true);
  assert.equal(result.exact, false);
  assert.equal(batches(), 2);
  assert.ok(result.lowerBound <= 0.2 && result.lowerBound > 0.19999999);
  assert.ok(result.upperBound >= 0.4 && result.upperBound < 0.40000001);
});

test('resuming a partial transition replaces cumulative mass and certifies completion', () => {
  const {solver, batches} = partialSolver(0.01);
  const result = solver.solve('root');
  assert.equal(result.converged, true);
  assert.equal(result.exact, true);
  assert.equal(batches(), 3);
  assert.ok(Math.abs(result.value - 0.2) < 1e-8);
});

test('generated child evidence can precede resuming a partial transition', () => {
  const expanded: string[] = [];
  const solver = new BoundedSolver({tolerance: 0.02, adapter: {
    snapshotBattle: state => state, restoreBattle: state => state, stateKey: String,
    terminalUtility: () => null, legalActions: () => ['a'],
    enumerateTurn: () => { throw new Error('cursor adapter expected'); },
    createTurnCursor: state => ({advance: (): TransitionProgress => {
      expanded.push(state);
      if (state === 'child') return {outcomes: [{utility: 1, probability: 1}],
        remainingProbability: 0, complete: true, simulatorRuns: 1};
      return {outcomes: [{snapshot: 'child' as any, probability: 0.995}],
        remainingProbability: 0.005, complete: false, simulatorRuns: 1};
    }}),
  }});
  const result = solver.solve('root');
  assert.equal(result.converged, true);
  assert.equal(result.exact, false);
  assert.deepEqual(expanded, ['root', 'child']);
  assert.ok(result.lowerBound <= 0.99 && result.lowerBound > 0.98999999);
  assert.equal(result.upperBound, 1);
});

function protectSnapshot() {
  const set = {species: 'Mew', level: 50, moves: ['Protect'], nature: 'Serious'};
  const battle = createBattle(set, set);
  battle.makeChoices('move 1', 'move 1');
  return snapshotBattle(battle);
}

function finish(cursor) {
  let result;
  do { result = cursor.advance({maxRuns: 1, deadline: Infinity}); } while (!result.complete);
  return result;
}

test('native one-replay batches preserve all repeated-Protect probability', () => {
  const snapshot = protectSnapshot();
  const action = {command: 'move 1'};
  const cursor = createTurnCursor(snapshot, action, action);
  const first = cursor.advance({maxRuns: 1, deadline: Infinity});
  assert.equal(first.complete, false);
  assert.ok(first.remainingProbability > 0);
  assert.ok(first.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0) > 0);
  const result = finish(cursor);
  assert.equal(result.remainingProbability, 0);
  assertSameDistribution(enumerateNative(snapshot, action, action), result);
});

test('cancellation after splitting a prefix restores only the active residual mass', () => {
  const snapshot = protectSnapshot();
  const action = {command: 'move 1'};
  const cursor = createTurnCursor(snapshot, action, action);
  const original = performance.now;
  let calls = 0;
  let partial;
  performance.now = () => ++calls <= 2 ? 0 : 2;
  try { partial = cursor.advance({maxRuns: 20, deadline: 1}); }
  finally { performance.now = original; }
  assert.equal(partial.complete, false);
  assert.equal(partial.simulatorRuns, 1);
  assert.equal(partial.remainingProbability + partial.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0), 1);
  assertSameDistribution(enumerateNative(snapshot, action, action), finish(cursor));
});

test('a cursor enforces the total simulator limit across batches', () => {
  const cursor = createTurnCursor(protectSnapshot(), {command: 'move 1'}, {command: 'move 1'},
    {maxSimulatorRunsPerTransition: 1});
  assert.equal(cursor.advance({maxRuns: 1, deadline: Infinity}).complete, false);
  assert.throws(() => cursor.advance({maxRuns: 1, deadline: Infinity}), /Random branch limit/);
});

test('node-limited cumulative transition acceptance keeps missing children unknown', () => {
  let batches = 0;
  const solver = new BoundedSolver({tolerance: 0.02, maxNodes: 1, adapter: {
    snapshotBattle: state => state, restoreBattle: state => state, stateKey: String,
    terminalUtility: () => null, legalActions: () => ['a'],
    enumerateTurn: () => { throw new Error('cursor adapter expected'); },
    createTurnCursor: () => ({advance: (): TransitionProgress => {
      batches++;
      return {outcomes: batches === 1 ? [{utility: 1, probability: 0.6}]
        : [{utility: 1, probability: 0.6}, {snapshot: 'unrepresented' as any, probability: 0.4}],
      remainingProbability: batches === 1 ? 0.4 : 0, complete: batches === 2, simulatorRuns: 1};
    }}),
  }});
  const result = solver.solve('root');
  assert.equal(result.converged, false);
  assert.equal(result.exact, false);
  assert.equal(result.stopReason, 'node-limit');
  assert.equal(batches, 2);
  assert.ok(result.lowerBound <= 0.2 && result.lowerBound > 0.19999999);
  assert.equal(result.upperBound, 1);
});

for (const utility of [-1, 1]) {
  for (const error of [-5e-10, 5e-10]) {
    test(`partial mass normalization encloses both remainder completions (${utility}, ${error})`, () => {
      const completed = 0.75 + error;
      const remaining = 0.25;
      const total = completed + remaining;
      const solver = new BoundedSolver({tolerance: 0.6, adapter: {
        legalActions: () => ['a'],
        enumerateTurn: () => { throw new Error('cursor adapter expected'); },
        createTurnCursor: () => ({advance: () => ({
          outcomes: [{utility, probability: completed}],
          remainingProbability: remaining, complete: false, simulatorRuns: 1,
        })}),
      }});
      const result = solver.solve('root');
      const lowerCompletion = (utility * completed - remaining) / total;
      const upperCompletion = (utility * completed + remaining) / total;
      assert.equal(result.converged, true);
      assert.equal(result.exact, false);
      // No comparison epsilon: the admitted probability error exceeds the
      // solver's numerical guard, so that guard must not hide a bad endpoint.
      assert.ok(result.lowerBound <= lowerCompletion);
      assert.ok(result.upperBound >= upperCompletion);
      assert.ok(Math.abs(result.value - utility * completed / total) < 1e-10);
    });
  }
}
