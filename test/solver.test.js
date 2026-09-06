'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {OneVsOneSolver} = require('../src/solver');
const {
  leftoversThreeHKO,
  suckerPunchGame,
  trivialPriorityKO,
} = require('../src/cases');

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function probabilityFor(strategy, action) {
  const entry = strategy.find(item => item.action === action);
  assert.ok(entry, `Missing action ${action}`);
  return entry.probability;
}

test('trivial priority KO is a forced P1 win', () => {
  const result = new OneVsOneSolver().solve(trivialPriorityKO().battle);
  close(result.value, 1);
});

test('symmetric Leftovers/Protect 3HKO has value zero', () => {
  const testCase = leftoversThreeHKO();
  const maxHP = testCase.battle.p1.active[0].maxhp;
  assert.ok(2 * 50 < maxHP && maxHP <= 3 * 50, `Expected Seismic Toss to be a 3HKO; HP=${maxHP}`);

  const result = new OneVsOneSolver().solve(testCase.battle);
  close(result.value, 0);
});

test('Sucker Punch endgame is matching pennies', () => {
  const result = new OneVsOneSolver().solve(suckerPunchGame().battle);
  close(result.value, 0);
  close(probabilityFor(result.p1Strategy, 'Sucker Punch'), 0.5);
  close(probabilityFor(result.p1Strategy, 'Knock Off'), 0.5);
  close(probabilityFor(result.p2Strategy, 'Protect'), 0.5);
  close(probabilityFor(result.p2Strategy, 'Tackle'), 0.5);
});
