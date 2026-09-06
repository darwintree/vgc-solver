'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {suckerPunchGame} = require('../src/cases');
const {refreshMoveRequest} = require('../src/showdown-adapter');
const {OneVsOneSolver} = require('../src/solver');
const {AsyncTransitionSolver} = require('../src/async-solver');
const {TransitionPool} = require('../src/transition-pool');

test('async solver falls back to synchronous backend for native callback replacement', async () => {
  const {battle} = suckerPunchGame();
  for (const side of ['p1', 'p2']) {
    for (const slot of battle[side].active[0].moveSlots) slot.pp = 1;
  }
  refreshMoveRequest(battle);
  const ability = battle.dex.abilities.get('soundproof');
  const sturdy = battle.dex.abilities.get('sturdy');
  const original = Object.getOwnPropertyDescriptor(ability, 'onDamage');
  ability.onDamage = sturdy.onDamage;
  try {
    const expected = new OneVsOneSolver({maxStates: 10000}).solve(battle);
    const pool = new TransitionPool(2);
    await pool.ready;
    try {
      const actual = await new AsyncTransitionSolver({
        pool, workerCount: 2, eager: true, maxStates: 10000,
      }).solve(battle);
      assert.equal(actual.value, expected.value);
      assert.deepEqual(actual.payoffMatrix, expected.payoffMatrix);
      assert.equal(pool.metrics.dispatched, 0);
    } finally {
      await pool.close();
    }
  } finally {
    if (original) Object.defineProperty(ability, 'onDamage', original);
    else delete ability.onDamage;
  }
});

test('async solver falls back for numeric Dex rule changes and preserves the result', async () => {
  const {battle} = require('../src/cases').trivialPriorityKO();
  const move = battle.dex.moves.get('quickattack');
  const originalBasePower = move.basePower;
  move.basePower = 0;
  try {
    const expected = new OneVsOneSolver({maxStates: 10000}).solve(battle);
    const pool = new TransitionPool(2);
    await pool.ready;
    try {
      const actual = await new AsyncTransitionSolver({
        pool, workerCount: 2, eager: true, maxStates: 10000,
      }).solve(battle);
      assert.equal(actual.value, expected.value);
      assert.deepEqual(actual.payoffMatrix, expected.payoffMatrix);
      assert.equal(pool.metrics.dispatched, 0);
    } finally {
      await pool.close();
    }
  } finally {
    move.basePower = originalBasePower;
  }
});
