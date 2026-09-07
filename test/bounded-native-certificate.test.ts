import type {Action} from '../src/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import {BoundedSolver} from '../src/bounded-solver';
import {
  suckerPunchBulkyTargetGame,
  suckerPunchBothProtectGame,
} from '../src/cases';
import {enumerateNative} from './helpers/distribution';
import {solveZeroSumMatrixOracle} from './matrix-game.oracle';

const PROBABILITY_TOLERANCE = 1e-9;
const BOUND_TOLERANCE = 1e-8;

function terminalKey(utility) {
  return `terminal:${utility}`;
}

function aggregate(outcomes, keyForSnapshot) {
  const result = new Map();
  for (const outcome of outcomes) {
    const key = outcome.snapshot === undefined || outcome.snapshot === null
      ? terminalKey(outcome.utility)
      : `child:${keyForSnapshot(outcome.snapshot)}`;
    result.set(key, (result.get(key) || 0) + outcome.probability);
  }
  return result;
}

function assertSameOutcomes(actual, expected, context) {
  const keys = new Set([...actual.keys(), ...expected.keys()]);
  for (const key of keys) {
    const left = actual.get(key) || 0;
    const right = expected.get(key) || 0;
    assert.ok(Math.abs(left - right) <= PROBABILITY_TOLERANCE,
      `${context}: ${key} probability ${left} != ${right}`);
  }
}

function independentBackup(solver, root) {
  const visiting = new Set();
  const memo = new Map();

  function backup(node) {
    if (node.terminal !== null) return {lower: node.terminal, upper: node.terminal};
    const cached = memo.get(node.key);
    if (cached) return cached;
    // A discovered but uninitialized node is a represented unknown frontier.
    if (!node.initialized) {
      const unknown = {lower: -1, upper: 1};
      memo.set(node.key, unknown);
      return unknown;
    }
    assert.ok(node.cells, `initialized node ${node.key} has no cells`);
    assert.equal(visiting.has(node.key), false, `cycle at ${node.key}`);
    visiting.add(node.key);
    try {
      const lowerMatrix = [];
      const upperMatrix = [];
      for (const row of node.cells) {
        const lowerRow = [];
        const upperRow = [];
        for (const cell of row) {
          if (!cell.outcomes) {
            lowerRow.push(-1);
            upperRow.push(1);
            continue;
          }
          let lower = 0;
          let upper = 0;
          for (const outcome of cell.outcomes) {
            if (outcome.utility !== null) {
              lower += outcome.probability * outcome.utility;
              upper += outcome.probability * outcome.utility;
            } else {
              assert.ok(outcome.child, `unrepresented outcome in ${node.key}`);
              const child = backup(outcome.child);
              lower += outcome.probability * child.lower;
              upper += outcome.probability * child.upper;
            }
          }
          lowerRow.push(lower);
          upperRow.push(upper);
        }
        lowerMatrix.push(lowerRow);
        upperMatrix.push(upperRow);
      }
      const result = {
        lower: solveZeroSumMatrixOracle(lowerMatrix).value,
        upper: solveZeroSumMatrixOracle(upperMatrix).value,
        lowerMatrix,
        upperMatrix,
      };
      memo.set(node.key, result);
      return result;
    } finally {
      visiting.delete(node.key);
    }
  }

  return {result: backup(root), memo};
}

function strategySecurity(strategy, matrix, maximizing) {
  const probabilities = strategy.map(entry => entry.probability);
  assert.ok(probabilities.every(value => Number.isFinite(value) && value >= -BOUND_TOLERANCE));
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) <= BOUND_TOLERANCE, `strategy mass ${total}`);
  if (maximizing) {
    return Math.min(...matrix[0].map((_, j) =>
      matrix.reduce((sum, row, i) => sum + probabilities[i] * row[j], 0)));
  }
  return Math.max(...matrix.map((row, i) =>
    row.reduce((sum, value, j) => sum + value * probabilities[j], 0)));
}

function certifyFixture(makeFixture) {
  const solver = new BoundedSolver({
    lazyCells: false,
    selectionPolicy: 'security',
    tolerance: 0.02,
    maxSearchMs: 30000,
    maxNodes: 5000,
  });
  const {battle} = makeFixture();
  const claimed = solver.solve(battle);
  assert.equal(claimed.converged, true);
  assert.equal(claimed.stopReason, null);
  assert.equal(solver.limitReached, false);
  assert.ok(solver.nodes.size < 5000);

  const privateKey = snapshot => solver.memoStateKey(snapshot);
  let generatedCells = 0;
  for (const node of solver.nodes.values()) {
    if (!node.initialized || node.terminal !== null) continue;
    assert.ok(node.cells);
    for (let i = 0; i < node.cells.length; i++) {
      for (let j = 0; j < node.cells[i].length; j++) {
        const cell = node.cells[i][j];
        // Incremental eager scheduling can leave action pairs at the
        // conservative unknown interval once the parent certificate is tight.
        // The independent backup below treats those cells as [-1, 1]; only
        // generated cells need native transition equivalence auditing.
        if (!cell.outcomes) continue;
        generatedCells++;
        const native = enumerateNative(node.snapshot, node.actions1[i] as Action, node.actions2[j] as Action);
        const expected = aggregate(native.outcomes, privateKey);
        const actual = new Map();
        for (const outcome of cell.outcomes) {
          const key = outcome.utility !== null
            ? terminalKey(outcome.utility)
            : `child:${outcome.child?.key}`;
          assert.ok(outcome.utility !== null || outcome.child,
            `generated cell ${i},${j} contains a truncated outcome`);
          actual.set(key, (actual.get(key) || 0) + outcome.probability);
        }
        assertSameOutcomes(actual, expected, `node ${node.key} cell ${i},${j}`);
      }
    }
  }
  assert.ok(generatedCells > 0);

  const rootSnapshot = solver._snapshot(battle);
  const root = solver.nodes.get(solver._key(rootSnapshot));
  assert.ok(root);
  const {result: oracle} = independentBackup(solver, root);
  assert.ok(claimed.lowerBound <= oracle.lower + BOUND_TOLERANCE);
  assert.ok(claimed.upperBound + BOUND_TOLERANCE >= oracle.upper);
  assert.ok(oracle.lower <= oracle.upper + BOUND_TOLERANCE);

  const p1Security = strategySecurity(claimed.p1Strategy, oracle.lowerMatrix, true);
  const p2Security = strategySecurity(claimed.p2Strategy, oracle.upperMatrix, false);
  assert.ok(p1Security + BOUND_TOLERANCE >= claimed.lowerBound);
  assert.ok(p2Security - BOUND_TOLERANCE <= claimed.upperBound);
  return {claimed, oracle};
}

test('bounded native certificate covers full-PP case4', () => {
  const {claimed, oracle} = certifyFixture(suckerPunchBulkyTargetGame);
  assert.ok(claimed.upperBound - claimed.lowerBound <= 0.02 + BOUND_TOLERANCE);
  assert.ok(oracle.upper - oracle.lower <= 0.02 + BOUND_TOLERANCE);
});

test('bounded native certificate covers full-PP case5', () => {
  const {claimed, oracle} = certifyFixture(suckerPunchBothProtectGame);
  assert.ok(claimed.upperBound - claimed.lowerBound <= 0.02 + BOUND_TOLERANCE);
  assert.ok(oracle.upper - oracle.lower <= 0.02 + BOUND_TOLERANCE);
});

test('case4 and case5 roots retain maximum PP', () => {
  for (const makeFixture of [suckerPunchBulkyTargetGame, suckerPunchBothProtectGame]) {
    const {battle} = makeFixture();
    for (const side of battle.sides) {
      for (const pokemon of side.active) {
        for (const slot of pokemon.moveSlots) assert.equal(slot.pp, slot.maxpp);
        for (const slot of pokemon.baseMoveSlots) assert.equal(slot.pp, slot.maxpp);
      }
    }
  }
});
