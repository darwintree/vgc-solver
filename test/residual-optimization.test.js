'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {NeedRandom, BranchingPRNG} = require('../src/branching-prng');
const {installResidualOptimization} = require('../src/residual-optimization');
const {createBattle} = require('../src/showdown-adapter');

function protectResidualBattle() {
  const battle = createBattle(
    {species: 'Mew', moves: ['Protect']},
    {species: 'Mew', moves: ['Protect']}
  );
  const protect = battle.dex.getActiveMove('Protect');
  for (const pokemon of battle.getAllActive()) {
    pokemon.addVolatile('protect', pokemon, protect);
  }
  battle.prng = new BranchingPRNG();
  return battle;
}

test('residual tie optimization preserves independent duration handlers', () => {
  const native = protectResidualBattle();
  assert.throws(
    () => native.fieldEvent('Residual', native.getAllActive()),
    error => error instanceof NeedRandom
  );

  const optimized = protectResidualBattle();
  assert.equal(installResidualOptimization(optimized), true);
  optimized.fieldEvent('Residual', optimized.getAllActive());

  assert.equal(optimized.p1.active[0].volatiles.protect, undefined);
  assert.equal(optimized.p2.active[0].volatiles.protect, undefined);
});

test('residual optimization rejects overridden native dispatch', () => {
  const battle = protectResidualBattle();
  battle.resolvePriority = battle.resolvePriority.bind(battle);
  assert.equal(installResidualOptimization(battle), false);
});
