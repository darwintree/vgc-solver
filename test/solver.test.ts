import assert from 'node:assert/strict';
import test from 'node:test';
import {OneVsOneSolver} from '../src/solver';
import {
  refreshMoveRequest,
  setMovePP,
} from '../src/showdown-adapter';
import {
  leftoversThreeHKO,
  suckerPunchGame,
  trivialPriorityKO,
} from '../src/cases';

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
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

test('5-PP Sucker Punch endgame has value two thirds', () => {
  const {battle} = suckerPunchGame();
  for (const side of battle.sides) {
    for (const move of side.active[0].moveSlots) setMovePP(battle, side.id, move.id, 5);
  }
  refreshMoveRequest(battle);
  for (const side of battle.sides) {
    const pokemon = side.active[0];
    for (const slots of [pokemon.moveSlots, pokemon.baseMoveSlots]) {
      assert.deepEqual(slots.map(slot => slot.pp), [5, 5]);
    }
  }
  const result = new OneVsOneSolver().solve(battle);
  close(result.value, 2 / 3);
  close(result.payoffMatrix[0][0], 3 / 5);
  close(result.payoffMatrix[0][1], 1);
  close(result.payoffMatrix[1][0], 1);
  close(result.payoffMatrix[1][1], -1);
  for (const strategy of [result.p1Strategy, result.p2Strategy]) {
    close(strategy[0].probability, 5 / 6);
    close(strategy[1].probability, 1 / 6);
  }
});

test('2-PP Sucker Punch endgame has value one third', () => {
  const {battle} = suckerPunchGame();
  for (const side of battle.sides) {
    for (const move of side.active[0].moveSlots) setMovePP(battle, side.id, move.id, 2);
  }
  refreshMoveRequest(battle);
  const result = new OneVsOneSolver().solve(battle);
  close(result.value, 1 / 3);
  assert.deepEqual(result.payoffMatrix, [[0, 1], [1, -1]]);
  for (const strategy of [result.p1Strategy, result.p2Strategy]) {
    close(strategy[0].probability, 2 / 3);
    close(strategy[1].probability, 1 / 3);
  }
});
