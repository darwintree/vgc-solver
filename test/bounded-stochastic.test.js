'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {BoundedSolver} = require('../src/bounded-solver');
const {solveZeroSumMatrixOracle} = require('./matrix-game.oracle');

test('bounded search certifies rectangular stochastic DAGs with shared successors', () => {
  let seed = 20260907;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let trial = 0; trial < 12; trial++) {
    const states = [];
    const values = [];
    // Later states only point to earlier ones, giving an independent exact
    // bottom-up reference without using the solver's backups or memo keys.
    for (let index = 0; index < 10; index++) {
      const cells = Array.from({length: 2 + index % 2}, () =>
        Array.from({length: 2 + index % 3}, () => {
          const outcomes = [{utility: random() * 2 - 1, probability: 0.2}];
          for (const probability of [0.3, 0.5]) {
            outcomes.push(index === 0
              ? {utility: random() * 2 - 1, probability}
              : {snapshot: Math.floor(random() * index), probability});
          }
          return outcomes;
        }));
      states.push(cells);
      const matrix = cells.map(row => row.map(outcomes => outcomes.reduce((sum, outcome) =>
        sum + outcome.probability * (outcome.utility ?? values[outcome.snapshot]), 0)));
      values.push(solveZeroSumMatrixOracle(matrix).value);
    }
    const adapter = {
      stateKey: String,
      terminalUtility: () => null,
      legalActions: (state, side) => Array.from({
        length: side === 0 ? states[state].length : states[state][0].length,
      }, (_, index) => index),
      enumerateTurn: (state, row, column) => ({outcomes: states[state][row][column]}),
    };
    for (const lazyCells of [false, true]) {
      for (const selectionPolicy of ['auto', 'security', 'joint']) {
        const result = new BoundedSolver({adapter, lazyCells, selectionPolicy}).solve(9);
        assert.equal(result.converged, true, `${trial}: ${selectionPolicy}, lazy=${lazyCells}`);
        assert.ok(result.lowerBound <= values[9] + 1e-8);
        assert.ok(result.upperBound >= values[9] - 1e-8);
        assert.ok(result.upperBound - result.lowerBound <= 0.02 + 1e-8);
      }
    }
  }
});
