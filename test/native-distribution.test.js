'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {Battle} = require('@pkmn/sim');
const {FIXED_SEED} = require('../src/branching-prng');
const {
  createBattle,
  enumerateTurn,
  snapshotBattle,
} = require('../src/showdown-adapter');
const {assertSameDistribution, enumerateNative} = require('./helpers/distribution');

function set(species, moves, extra = {}) {
  return {species, level: 50, moves, nature: 'Serious', ...extra};
}

function compareFixture(makeBattle, p1Command, p2Command) {
  const battle = makeBattle();
  const snapshot = snapshotBattle(battle);
  const before = JSON.stringify(snapshot);
  const p1 = {command: p1Command};
  const p2 = {command: p2Command};
  const native = enumerateNative(snapshot, p1, p2);
  const optimized = enumerateTurn(snapshot, p1, p2);
  assert.equal(JSON.stringify(snapshot), before);
  assertSameDistribution(native, optimized);
  assert.ok(optimized.simulatorRuns <= native.simulatorRuns);
}

test('native and current distributions match from fixed single and double snapshots', () => {
  compareFixture(
    () => createBattle(set('Mew', ['Seismic Toss']), set('Mew', ['Seismic Toss'])),
    'move 1', 'move 1'
  );

  compareFixture(
    () => {
      const battle = createBattle(set('Mew', ['Protect']), set('Mew', ['Protect']));
      battle.makeChoices('move 1', 'move 1');
      return battle;
    },
    'move 1', 'move 1'
  );

  compareFixture(
    () => {
      const battle = new Battle({
        formatid: 'gen9customgame',
        debug: true,
        strictChoices: true,
        seed: FIXED_SEED,
        p1: {name: 'P1', team: [set('Mew', ['Splash']), set('Snorlax', ['Splash'])]},
        p2: {name: 'P2', team: [set('Mew', ['Seismic Toss'])]},
      });
      battle.makeChoices('team 12', 'team 1');
      return battle;
    },
    'switch 2', 'move 1'
  );

  compareFixture(
    () => {
      const battle = new Battle({
        formatid: 'gen9doublescustomgame',
        debug: true,
        strictChoices: true,
        seed: FIXED_SEED,
        p1: {name: 'P1', team: [set('Mew', ['Seismic Toss']), set('Alakazam', ['Splash'])]},
        p2: {name: 'P2', team: [set('Snorlax', ['Splash']), set('Slowbro', ['Splash'], {ivs: {spe: 0}})]},
      });
      battle.makeChoices('team 12', 'team 12');
      return battle;
    },
    'move 1 2, move 1', 'move 1, move 1'
  );
});
