import assert from 'node:assert/strict';
import test from 'node:test';
import {BoundedSolver} from '../src/bounded-solver';
import {solveZeroSumMatrix} from '../src/matrix-game';
import {OneVsOneSolver} from '../src/solver';
import {
  refreshMoveRequest,
  setMovePP,
} from '../src/showdown-adapter';
import {suckerPunchGame} from '../src/cases';

function toyAdapter(spec) {
  return {
    snapshotBattle: state => state,
    restoreBattle: state => state,
    stateKey: state => String(state),
    terminalUtility: state => Number.isFinite(state)
      ? state
      : (Object.prototype.hasOwnProperty.call(spec.terminals || {}, state)
        ? spec.terminals[state] : null),
    legalActions: (state, side) => (side === 0 ? spec.actions[state] : spec.opponentActions?.[state]) || ['finish'],
    enumerateTurn: (state, p1, p2) => {
      const outcome = spec.transitions[`${state}:${p1}:${p2}`];
      if (!outcome) throw new Error(`Missing transition ${state}:${p1}:${p2}`);
      return {outcomes: Array.isArray(outcome) ? outcome : [outcome]};
    },
  };
}

function utility(value) {
  return {utility: value, probability: 1};
}

function snapshot(value) {
  return {snapshot: value, probability: 1};
}

test('expands one ply at a time and certifies an exact DAG', () => {
  const adapter = toyAdapter({
    actions: {root: ['risky', 'safe'], future: ['finish']},
    opponentActions: {root: ['attack', 'wait'], future: ['finish']},
    transitions: {
      'root:risky:attack': snapshot('future'),
      'root:risky:wait': utility(1),
      'root:safe:attack': utility(-1),
      'root:safe:wait': utility(-1),
      'future:finish:finish': utility(1),
    },
  });
  const result = new BoundedSolver({adapter, tolerance: 0.02, warmStartRoot: false}).solve('root');

  assert.equal(result.converged, true);
  assert.equal(result.exact, false);
  assert.equal(result.approximate, true);
  assert.ok(result.lowerBound <= 1);
  assert.ok(result.upperBound >= 1);
  assert.ok(result.lowerBound >= 1 - 1e-8);
  assert.equal(result.p1Strategy[0].action, 'risky');
  assert.equal(result.p1Strategy[0].probability, 1);
  assert.equal(result.stats.expandedStates, 2);
  assert.ok(result.stats.matrixSolves >= 2, 'child bounds should invalidate the root matrix');
  for (const row of result.payoffMatrixIntervals) {
    for (const cell of row) assert.ok(cell.lowerBound <= cell.upperBound);
  }
  assert.deepEqual(result.payoffMatrixIntervals[1][0], {lowerBound: -1, upperBound: 1});
});

test('eager expansion stops on a pure security certificate and preserves unknown cells', () => {
  let transitions = 0;
  const adapter = toyAdapter({
    actions: {root: ['winning-row', 'losing-row']},
    opponentActions: {root: ['c0', 'c1']},
    transitions: {
      'root:winning-row:c0': utility(1),
      'root:winning-row:c1': utility(1),
      // The losing row is deliberately absent: a pure row certificate should
      // make it unnecessary to ask the adapter for either transition.
    },
  });
  const originalEnumerate = adapter.enumerateTurn;
  adapter.enumerateTurn = (...args) => {
    transitions++;
    return originalEnumerate(...args);
  };

  const result = new BoundedSolver({
    adapter,
    lazyCells: false,
    tolerance: 0.02,
    warmStartRoot: false,
  }).solve('root');

  assert.equal(result.converged, true);
  assert.ok(result.lowerBound >= 1 - 1e-9);
  assert.ok(result.upperBound <= 1 + 1e-9);
  assert.equal(transitions, 2, 'the losing row is not needed for the pure certificate');
  assert.deepEqual(result.payoffMatrixIntervals[1][0], {lowerBound: -1, upperBound: 1});
  assert.deepEqual(result.payoffMatrixIntervals[1][1], {lowerBound: -1, upperBound: 1});
  assert.equal(result.approximate, true, 'unexpanded cells prevent an exact certificate');
});

test('deep eager nodes stop at the scheduler-width threshold', () => {
  let transitions = 0;
  const adapter = toyAdapter({
    actions: {
      root: ['enter'],
      middle: ['enter'],
      leaf: ['winning-row', 'unknown-row'],
    },
    opponentActions: {
      root: ['wait'],
      middle: ['wait'],
      leaf: ['c0', 'c1'],
    },
    transitions: {
      'root:enter:wait': snapshot('middle'),
      'middle:enter:wait': snapshot('leaf'),
      'leaf:winning-row:c0': utility(1),
      'leaf:winning-row:c1': utility(1),
    },
  });
  const originalEnumerate = adapter.enumerateTurn;
  adapter.enumerateTurn = (...args) => {
    transitions++;
    return originalEnumerate(...args);
  };

  const result = new BoundedSolver({
    adapter,
    lazyCells: false,
    tolerance: 0.02,
    warmStartRoot: false,
  }).solve('root');

  assert.equal(result.converged, true);
  assert.ok(result.lowerBound >= 1 - 1e-9);
  assert.ok(result.upperBound <= 1 + 1e-9);
  assert.equal(transitions, 4, 'two path transitions plus the two leaf cells');
  assert.equal(result.approximate, true, 'the leaf retains two unknown cells');
});

test('returns honest bounds when the node limit blocks an unresolved child', () => {
  const adapter = toyAdapter({
    actions: {root: ['wait']},
    opponentActions: {root: ['wait']},
    transitions: {'root:wait:wait': snapshot('future')},
  });
  const result = new BoundedSolver({adapter, maxNodes: 1, tolerance: 0}).solve('root');

  assert.equal(result.converged, false);
  assert.equal(result.approximate, true);
  assert.equal(result.lowerBound, -1);
  assert.equal(result.upperBound, 1);
  assert.equal(result.stopReason, 'node-limit');
  assert.ok(result.valueErrorBound >= 1);
});

test('does not claim convergence for a regenerative cycle', () => {
  const adapter = toyAdapter({
    actions: {root: ['loop']},
    opponentActions: {root: ['loop']},
    transitions: {'root:loop:loop': snapshot('root')},
  });
  const result = new BoundedSolver({adapter, maxNodes: 4, tolerance: 0}).solve('root');

  assert.equal(result.converged, false);
  assert.equal(result.exact, false);
  assert.equal(result.lowerBound, -1);
  assert.equal(result.upperBound, 1);
  assert.equal(result.stopReason, 'stalled');
  assert.equal(result.stats.matrixSolves, 1, 'unchanged cyclic bounds should reuse the matrix solution');
});

test('time and fresh solve contexts are independent', () => {
  const adapter = toyAdapter({terminals: {win: 1, loss: -1}});
  const solver = new BoundedSolver({adapter, maxSearchMs: 0});
  const timedOut = solver.solve('unknown');
  assert.equal(timedOut.converged, false);
  assert.equal(timedOut.stopReason, 'time');
  assert.equal(timedOut.lowerBound, -1);
  assert.equal(timedOut.upperBound, 1);

  const win = solver.solve('win');
  const loss = solver.solve('loss');
  assert.equal(win.value, 1);
  assert.equal(loss.value, -1);
  assert.equal(win.stats.nodes, 1);
  assert.equal(loss.stats.nodes, 1);
});

test('an incomplete transition remains an unknown bounded cell', () => {
  const adapter = {
    snapshotBattle: state => state,
    restoreBattle: state => state,
    stateKey: state => String(state),
    terminalUtility: () => null,
    legalActions: () => ['wait'],
    enumerateTurn: () => ({outcomes: [], simulatorRuns: 7, complete: false}),
  };
  const solver = new BoundedSolver({adapter, tolerance: 0});
  const result = solver.solve({id: 'root'});

  assert.equal(result.converged, false);
  assert.equal(result.stopReason, 'transition-incomplete');
  assert.equal(result.payoffMatrixIntervals.length, 1);
  assert.equal(result.payoffMatrixIntervals[0].length, 1);
  assert.deepEqual(result.payoffMatrixIntervals[0][0], {lowerBound: -1, upperBound: 1});
  assert.equal(solver.stats.transitionCalls, 1);
  assert.equal(solver.stats.simulatorRuns, 7);
});

test('native adapter interval contains the exact two-PP baseline', () => {
  const {battle} = suckerPunchGame();
  for (const side of battle.sides) {
    for (const move of side.active[0].moveSlots) setMovePP(battle, side.id, move.id, 2);
  }
  refreshMoveRequest(battle);
  const exact = new OneVsOneSolver().solve(battle);
  const bounded = new BoundedSolver({tolerance: 0.02, maxSearchMs: 2000}).solve(battle);

  assert.ok(bounded.lowerBound <= exact.value + 1e-9);
  assert.ok(bounded.upperBound >= exact.value - 1e-9);
  assert.ok(bounded.valueErrorBound <= 0.01 + 1e-9 || !bounded.converged);
  assert.ok(Array.isArray(bounded.payoffMatrixIntervals));
});

test('random small DAG intervals contain the matrix-game value', () => {
  let seed = 0x6d2b79f5;
  const random = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), 61 | seed);
    return ((seed ^ (seed >>> 14)) >>> 0) / 0x100000000;
  };

  for (let trial = 0; trial < 16; trial++) {
    const actions = {root: ['r0', 'r1', 'r2']};
    const opponentActions = {root: ['c0', 'c1', 'c2']};
    const transitions = {};
    const payoff = [];
    for (let i = 0; i < 3; i++) {
      const row = [];
      for (let j = 0; j < 3; j++) {
        const state = `trial${trial}-cell${i}-${j}`;
        const value = random() * 2 - 1;
        row.push(value);
        actions[state] = ['finish'];
        opponentActions[state] = ['finish'];
        transitions[`${state}:finish:finish`] = utility(value);
        transitions[`root:r${i}:c${j}`] = snapshot(state);
      }
      payoff.push(row);
    }
    const adapter = toyAdapter({actions, opponentActions, transitions});
    const expected = solveZeroSumMatrix(payoff).value;
    const converged = new BoundedSolver({adapter, tolerance: 0.02, maxNodes: 100}).solve('root');
    assert.ok(converged.lowerBound <= expected + 1e-8);
    assert.ok(converged.upperBound >= expected - 1e-8);

    const limited = new BoundedSolver({adapter, tolerance: 0, maxNodes: 1}).solve('root');
    assert.ok(limited.lowerBound <= expected + 1e-8);
    assert.ok(limited.upperBound >= expected - 1e-8);
    assert.equal(limited.converged, false);
  }
});

test('security ordering returns to mixed support after a pure proof path', () => {
  const adapter = toyAdapter({
    actions: {root: ['r0', 'r1'], future: ['finish']},
    opponentActions: {root: ['c0', 'c1'], future: ['finish']},
    transitions: {
      'root:r0:c0': utility(1),
      'root:r0:c1': snapshot('future'),
      'root:r1:c0': utility(-1),
      'root:r1:c1': utility(1),
      'future:finish:finish': utility(-1),
    },
  });
  const result = new BoundedSolver({
    adapter,
    lazyCells: false,
    selectionPolicy: 'security',
    tolerance: 0.02,
  }).solve('root');

  assert.equal(result.converged, true);
  assert.ok(result.lowerBound <= 0);
  assert.ok(result.upperBound >= 0);
  assert.equal(result.stopReason, null);
});

test('auto selection switches on a mixed root and resets per solve', () => {
  const adapter = toyAdapter({
    actions: {mixed: ['r0', 'r1'], pure: ['r']},
    opponentActions: {mixed: ['c0', 'c1'], pure: ['c']},
    transitions: {
      'mixed:r0:c0': utility(1),
      'mixed:r0:c1': utility(-1),
      'mixed:r1:c0': utility(-1),
      'mixed:r1:c1': utility(1),
      'pure:r:c': utility(1),
    },
  });
  const solver = new BoundedSolver({adapter, selectionPolicy: 'auto', warmStartRoot: false});
  const policies = [];
  const selectFrontier = solver._selectFrontier.bind(solver);
  solver._selectFrontier = (root, policy) => {
    policies.push(policy);
    return selectFrontier(root, policy);
  };

  const mixed = solver.solve('mixed');
  const mixedPolicies = policies.splice(0);
  assert.equal(mixed.converged, true);
  assert.ok(mixedPolicies.includes('security'));
  assert.ok(mixedPolicies.includes('joint'));
  assert.equal(solver.autoJoint, true);

  const pure = solver.solve('pure');
  assert.equal(pure.converged, true);
  assert.ok(policies.length > 0);
  assert.ok(policies.every(policy => policy === 'security'));
  assert.equal(solver.autoJoint, false);
});
