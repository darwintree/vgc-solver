import assert from 'node:assert/strict';
import test from 'node:test';
import {solveZeroSumMatrix} from '../src/matrix-game';

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('solves a trivial matrix', () => {
  const result = solveZeroSumMatrix([[1]]);
  close(result.value, 1);
  close(result.p1[0], 1);
  close(result.p2[0], 1);
});

test('solves matching pennies', () => {
  const result = solveZeroSumMatrix([[-1, 1], [1, -1]]);
  close(result.value, 0);
  close(result.p1[0], 0.5);
  close(result.p1[1], 0.5);
  close(result.p2[0], 0.5);
  close(result.p2[1], 0.5);
});

test('solves rock-paper-scissors', () => {
  const result = solveZeroSumMatrix([
    [0, -1, 1],
    [1, 0, -1],
    [-1, 1, 0],
  ]);
  close(result.value, 0);
  for (const p of [...result.p1, ...result.p2]) close(p, 1 / 3);
});

test('solves 8x8 degenerate matrices with duplicate and dominated actions', () => {
  // Mirrors 8-action Mega Evolution matrices where non-Mega and Mega rows/cols
  // produce identical or weakly dominated payoffs alongside a mixed 3x3 core.
  const payoff = [
    [0, -1, 1, 0, -1, 1, 0.5, 0.5],
    [1, 0, -1, 1, 0, -1, 0.5, 0.5],
    [-1, 1, 0, -1, 1, 0, 0.5, 0.5],
    [0, -1, 1, 0, -1, 1, 0.5, 0.5],
    [-0.5, -1, 0.5, -0.5, -1, 0.5, 0, 0],
    [1 - 1e-14, 0, -1, 1, 0, -1, 0.5, 0.5],
    [-1, 1, 0, -1, 1, 0, 0.5, 0.5],
    [-1, -1, -1, -1, -1, -1, -1, -1],
  ];
  const result = solveZeroSumMatrix(payoff);
  close(result.value, 0, 1e-7);
  assert.equal(result.p1.length, 8);
  assert.equal(result.p2.length, 8);
  // Verify full unreduced Nash certificate
  const minCol = Math.min(...payoff[0].map((_, j) =>
    payoff.reduce((s, row, i) => s + result.p1[i] * row[j], 0)));
  const maxRow = Math.max(...payoff.map(row =>
    row.reduce((s, v, j) => s + v * result.p2[j], 0)));
  close(minCol, result.value, 1e-7);
  close(maxRow, result.value, 1e-7);
});

test('solves ill-conditioned 8x4 near-duplicate mixed matrix without simplex failure', () => {
  const payoff = [
    [0.9835899164743457, 0.9797054039489493, 0.99, 0.99],
    [0.9797054039489493, 0.9835899164743457, 0.99, 0.99],
    [0.9835899164743457 - 1e-13, 0.9797054039489493, 0.99, 0.99],
    [0.9797054039489493, 0.9835899164743457 - 1e-13, 0.99, 0.99],
    [0.95, 0.95, 0.95, 0.95],
    [0.95, 0.95, 0.95, 0.95],
    [0.9835899164743457, 0.9797054039489493, 1.0, 1.0],
    [0.9797054039489493, 0.9835899164743457, 1.0, 1.0],
  ];
  const result = solveZeroSumMatrix(payoff);
  const expected = (0.9835899164743457 + 0.9797054039489493) / 2;
  close(result.value, expected, 1e-7);
});
