'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {solveZeroSumMatrix} = require('../src/matrix-game');

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
