'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {solveZeroSumMatrix} = require('../src/matrix-game');

const adapterPath = require.resolve('../src/showdown-adapter');
// Load the real module once so its cache record can be restored after each
// controlled-adapter solver instance.
require(adapterPath);
const adapterRecord = require.cache[adapterPath];
const realAdapterExports = adapterRecord.exports;
const solverPath = require.resolve('../src/solver');

function graphFor(matrix, outcomes = {}) {
  const p1Actions = matrix.map((_, i) => ({name: `p1-${i}`, id: `p1-${i}`, command: `p1-${i}`}));
  const p2Actions = matrix[0].map((_, j) => ({name: `p2-${j}`, id: `p2-${j}`, command: `p2-${j}`}));
  const battle = {id: 'root', actions: [p1Actions, p2Actions], terminal: false};
  const calls = [];
  const fakeAdapter = {
    enumerateTurn(snapshot, p1, p2) {
      const cell = `${p1.id},${p2.id}`;
      calls.push(cell);
      const specified = outcomes[cell];
      const values = specified ?? [{utility: matrix[Number(p1.id.slice(3))][Number(p2.id.slice(3))], probability: 1}];
      return {outcomes: values, simulatorRuns: 1};
    },
    legalActions(current, sideIndex) {
      return current.actions[sideIndex];
    },
    restoreBattle(snapshot) {
      return snapshot;
    },
    snapshotBattle(current) {
      return current;
    },
    stateKey(snapshot) {
      return snapshot.id;
    },
    terminalUtility(current) {
      return current.terminal ? current.utility : null;
    },
  };

  return {battle, calls, fakeAdapter};
}

function withGraph(graph, callback) {
  adapterRecord.exports = graph.fakeAdapter;
  delete require.cache[solverPath];
  const {OneVsOneSolver} = require(solverPath);
  try {
    return callback(OneVsOneSolver, graph);
  } finally {
    adapterRecord.exports = realAdapterExports;
    delete require.cache[solverPath];
  }
}

function treeGraph() {
  const action = (prefix, index) => ({
    name: `${prefix}-${index}`,
    id: `${prefix}-${index}`,
    command: `${prefix}-${index}`,
  });
  const root = {
    id: 'root',
    actions: [[action('p1', 0), action('p1', 1)], [action('p2', 0), action('p2', 1)]],
    terminal: false,
  };
  const middle = {
    id: 'middle',
    actions: [[action('m1', 0)], [action('m2', 0)]],
    terminal: false,
  };
  const terminal = (id, utility) => ({id, terminal: true, utility});
  const transitions = {
    'root:p1-0,p2-0': [
      {snapshot: middle, probability: 0.5},
      {snapshot: terminal('root-loss', -1), probability: 0.5},
    ],
    'root:p1-0,p2-1': [{utility: 0.25, probability: 1}],
    'root:p1-1,p2-0': [{utility: -0.5, probability: 1}],
    'root:p1-1,p2-1': [{utility: -1, probability: 1}],
    'middle:m1-0,m2-0': [{utility: 1, probability: 1}],
  };
  const calls = [];
  const fakeAdapter = {
    enumerateTurn(snapshot, p1, p2) {
      const key = `${snapshot.id}:${p1.id},${p2.id}`;
      calls.push(key);
      return {outcomes: transitions[key], simulatorRuns: 1};
    },
    legalActions(current, sideIndex) {
      return current.actions[sideIndex];
    },
    restoreBattle(snapshot) {
      return snapshot;
    },
    snapshotBattle(current) {
      return current;
    },
    stateKey(snapshot) {
      return snapshot.id;
    },
    terminalUtility(current) {
      return current.terminal ? current.utility : null;
    },
  };
  return {battle: root, calls, fakeAdapter};
}

test('root still returns the complete matrix while value-only children can prune', () => {
  const matrix = [[1, 1], [0, -1]];
  const graph = graphFor(matrix);
  withGraph(graph, (OneVsOneSolver, current) => {
    const solver = new OneVsOneSolver({maxStates: 1});
    const valueOnly = solver._solve(current.battle);
    assert.equal(valueOnly.value, 1);
    assert.equal(valueOnly.p1Strategy, undefined);
    assert.equal(current.calls.length, 2, 'the forced row avoids the second row');

    const full = solver.solve(current.battle);
    assert.deepEqual(full.payoffMatrix, matrix);
    assert.ok(full.p1Strategy);
    assert.ok(full.p2Strategy);
    assert.equal(solver.stats.solvedStates, 1, 'upgrading a state is not a second state');
  });
});

test('a tiny-probability losing outcome prevents +1 pruning', () => {
  const matrix = [[1, 1], [1, -1]];
  const graph = graphFor(matrix, {
    'p1-0,p2-0': [
      {utility: 1, probability: 1 - 1e-12},
      {utility: 0, probability: 1e-12},
    ],
  });
  withGraph(graph, (OneVsOneSolver, current) => {
    const result = new OneVsOneSolver()._solve(current.battle);
    assert.ok(result.p1Strategy, 'the near-win row must not be treated as forced');
    assert.deepEqual(result.payoffMatrix, [[1 - 1e-12, 1], [1, -1]]);
    assert.equal(current.calls.length, 4, 'all cells are needed after the rare failure');
  });
});

test('a sub-ulp losing branch still prevents forced-win pruning', () => {
  const tiny = Number.EPSILON / 2;
  const matrix = [[1, 1], [1, -1]];
  const graph = graphFor(matrix, {
    'p1-0,p2-0': [
      {utility: 1, probability: 1 - tiny},
      {utility: 0, probability: tiny},
    ],
  });
  withGraph(graph, (OneVsOneSolver, current) => {
    const result = new OneVsOneSolver()._solve(current.battle);
    assert.ok(result.p1Strategy, 'the rare non-winning outcome remains observable');
    assert.equal(current.calls.length, 4, 'the row is not treated as forced from probability rounding');
  });
});

test('pure saddle certificate agrees with LP and lazily evaluates cells', () => {
  const matrix = [[0.2, 0.4, 0.7], [-1, 0.1, 0.2], [-0.5, 0, 0.1]];
  const graph = graphFor(matrix);
  withGraph(graph, (OneVsOneSolver, current) => {
    const result = new OneVsOneSolver()._solve(current.battle);
    assert.equal(result.value, solveZeroSumMatrix(matrix).value);
    assert.equal(result.p1Strategy, undefined);
    assert.equal(current.calls.length, 5, 'one row plus the candidate column');
  });
});

test('failed saddle candidates still complete every missing cell', () => {
  const matrix = [[0, 0.5, 1], [0.5, 0, 1], [1, 1, 0]];
  const graph = graphFor(matrix);
  withGraph(graph, (OneVsOneSolver, current) => {
    const result = new OneVsOneSolver()._solve(current.battle);
    assert.equal(result.value, solveZeroSumMatrix(matrix).value);
    assert.deepEqual(result.payoffMatrix, matrix);
    assert.equal(new Set(current.calls).size, 9);
  });
});

test('terminal cache entries remain hits when a strategy is requested', () => {
  const graph = graphFor([[1]]);
  graph.battle.terminal = true;
  graph.battle.utility = 1;
  withGraph(graph, (OneVsOneSolver, current) => {
    const solver = new OneVsOneSolver();
    const snapshot = solver._solve(current.battle, false);
    const again = solver._solve(current.battle, true);
    assert.equal(snapshot, again);
    assert.equal(solver.stats.memoHits, 1);
    assert.equal(current.calls.length, 0);
  });
});

test('recursive random state tree agrees with the full LP oracle', () => {
  const graph = treeGraph();
  withGraph(graph, (OneVsOneSolver, current) => {
    const expected = [[0, 0.25], [-0.5, -1]];
    const result = new OneVsOneSolver().solve(current.battle);
    const oracle = solveZeroSumMatrix(expected);
    assert.deepEqual(result.payoffMatrix, expected);
    assert.equal(result.value, oracle.value);
    assert.ok(current.calls.includes('middle:m1-0,m2-0'));
  });
});
