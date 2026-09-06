'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {Battle} = require('@pkmn/sim');
const {FIXED_SEED} = require('../src/branching-prng');
const {
  createBattle,
  createPPTransitionCache,
  enumerateTurn,
  restoreBattle,
  setHP,
  snapshotBattle,
  stateKey,
} = require('../src/showdown-adapter');
const {assertSameDistribution} = require('./helpers/distribution');

function copyWithPP(snapshot, sideIndex, pokemonIndex, slotIndex, pp) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  copy.sides[sideIndex].pokemon[pokemonIndex].moveSlots[slotIndex].pp = pp;
  return copy;
}

function snapshots(result) {
  return result.outcomes.filter(outcome => outcome.snapshot).map(outcome => outcome.snapshot);
}

function compareAcrossPP({snapshot, action1, action2, slot, assertEffect}) {
  const seed = copyWithPP(snapshot, slot.side, slot.pokemon, slot.move, 5);
  const cache = createPPTransitionCache();
  enumerateTurn(seed, action1, action2, {ppCache: cache});
  for (const pp of [5, 3, 2, 1]) {
    const candidateSnapshot = copyWithPP(snapshot, slot.side, slot.pokemon, slot.move, pp);
    const cached = enumerateTurn(candidateSnapshot, action1, action2, {ppCache: cache});
    const native = enumerateTurn(candidateSnapshot, action1, action2);
    assertSameDistribution(native, cached);
    assert.deepEqual(
      cached.outcomes.map(outcome => outcome.snapshot ? stateKey(outcome.snapshot) : `terminal:${outcome.utility}`)
        .sort(),
      native.outcomes.map(outcome => outcome.snapshot ? stateKey(outcome.snapshot) : `terminal:${outcome.utility}`)
        .sort()
    );
    assertEffect(native, cached, pp);
  }
  return cache;
}

function priorTurnBattle(p1, p2, firstAction, secondAction) {
  const battle = createBattle(p1, p2);
  battle.makeChoices(firstAction, secondAction);
  return snapshotBattle(battle);
}

test('Spite after a real last move changes the target move PP', () => {
  const snapshot = priorTurnBattle(
    {species: 'Mew', moves: ['Spite', 'Splash']},
    {species: 'Snorlax', moves: ['Tackle', 'Splash']},
    'move 2', 'move 1'
  );
  const cache = compareAcrossPP({
    snapshot,
    action1: {command: 'move 1'},
    action2: {command: 'move 2'},
    slot: {side: 0, pokemon: 0, move: 0},
    assertEffect(native, cached) {
      for (const output of [native, cached]) {
        for (const snapshot of snapshots(output)) assert.equal(snapshot.sides[1].pokemon[0].moveSlots[0].pp, 51);
      }
    },
  });
  assert.ok(cache.templates.size > 0);
});

test('Encore after a real last move creates the lock and disables another move', () => {
  const snapshot = priorTurnBattle(
    {species: 'Mew', moves: ['Encore', 'Splash']},
    {species: 'Snorlax', moves: ['Tackle', 'Splash']},
    'move 2', 'move 1'
  );
  const cache = compareAcrossPP({
    snapshot,
    action1: {command: 'move 1'},
    action2: {command: 'move 2'},
    slot: {side: 0, pokemon: 0, move: 0},
    assertEffect(native, cached) {
      for (const output of [native, cached]) {
        for (const snapshot of snapshots(output)) {
          assert.equal(snapshot.sides[1].pokemon[0].volatiles.encore.move, 'tackle');
          assert.equal(snapshot.sides[1].pokemon[0].moveSlots[1].disabled, true);
        }
      }
    },
  });
  assert.equal(cache.templates.size, 0);
});

test('Leppa restores a move when PP really reaches zero', () => {
  const battle = createBattle(
    {species: 'Mew', moves: ['Tackle', 'Splash'], item: 'Leppa Berry'},
    {species: 'Snorlax', moves: ['Splash', 'Protect']}
  );
  const snapshot = snapshotBattle(battle);
  const cache = compareAcrossPP({
    snapshot,
    action1: {command: 'move 1'},
    action2: {command: 'move 1'},
    slot: {side: 0, pokemon: 0, move: 0},
    assertEffect(native, cached, pp) {
      if (pp !== 1) return;
      for (const output of [native, cached]) {
        for (const snapshot of snapshots(output)) {
          assert.equal(snapshot.sides[0].pokemon[0].moveSlots[0].pp, 10);
          assert.equal(snapshot.sides[0].pokemon[0].item, '');
        }
      }
    },
  });
  assert.equal(cache.templates.size, 0);
});

test('Grudge clears the source move PP on a nonterminal forced-switch state', () => {
  const battle = new Battle({
    formatid: 'gen9customgame', debug: true, strictChoices: true, seed: FIXED_SEED,
    p1: {name: 'P1', team: [
      {species: 'Mew', moves: ['Grudge', 'Splash']},
      {species: 'Snorlax', moves: ['Splash', 'Protect']},
    ]},
    p2: {name: 'P2', team: [{species: 'Snorlax', moves: ['Tackle', 'Splash']}]},
  });
  battle.makeChoices('team 12', 'team 1');
  setHP(battle, 'p1', 1);
  const snapshot = snapshotBattle(battle);
  const cache = compareAcrossPP({
    snapshot,
    action1: {command: 'move 1'},
    action2: {command: 'move 1'},
    slot: {side: 0, pokemon: 0, move: 0},
    assertEffect(native, cached) {
      for (const output of [native, cached]) {
        for (const snapshot of snapshots(output)) {
          assert.equal(snapshot.requestState, 'switch');
          assert.equal(snapshot.sides[1].pokemon[0].moveSlots[0].pp, 0);
          assert.equal(snapshot.sides[0].pokemon.length, 2);
        }
      }
    },
  });
  assert.equal(cache.templates.size, 0);
});

test('Transform with matching move IDs changes move-slot shape safely', () => {
  const snapshot = snapshotBattle(createBattle(
    {species: 'Mew', moves: ['Transform', 'Splash']},
    {species: 'Snorlax', moves: ['Transform', 'Splash']}
  ));
  const cache = compareAcrossPP({
    snapshot,
    action1: {command: 'move 1'},
    action2: {command: 'move 2'},
    slot: {side: 0, pokemon: 0, move: 0},
    assertEffect(native, cached) {
      for (const output of [native, cached]) {
        for (const snapshot of snapshots(output)) {
          const transformed = snapshot.sides[0].pokemon[0];
          const target = snapshot.sides[1].pokemon[0];
          assert.equal(transformed.transformed, true);
          assert.deepEqual(transformed.moveSlots.map(slot => slot.id), target.moveSlots.map(slot => slot.id));
          const restored = restoreBattle(snapshot);
          assert.notEqual(restored.p1.active[0].moveSlots[0], restored.p2.active[0].moveSlots[0]);
        }
      }
    },
  });
  assert.equal(cache.templates.size, 0);
});

test('Doubles Ally Switch preserves swapped positions with matching moves', () => {
  const set = (species, moves) => ({species, level: 50, moves, nature: 'Serious'});
  const battle = new Battle({
    formatid: 'gen9doublescustomgame', debug: true, strictChoices: true, seed: FIXED_SEED,
    p1: {name: 'P1', team: [set('Mew', ['Ally Switch', 'Splash']), set('Alakazam', ['Splash', 'Protect'])]},
    p2: {name: 'P2', team: [set('Snorlax', ['Splash', 'Protect']), set('Slowbro', ['Splash', 'Protect'])]},
  });
  battle.makeChoices('team 12', 'team 12');
  const snapshot = snapshotBattle(battle);
  const cache = compareAcrossPP({
    snapshot,
    action1: {command: 'move 1, move 1'},
    action2: {command: 'move 1, move 1'},
    slot: {side: 0, pokemon: 0, move: 0},
    assertEffect(native, cached) {
      for (const output of [native, cached]) {
        for (const snapshot of snapshots(output)) {
          assert.equal(snapshot.sides[0].pokemon[0].species, '[Species:alakazam]');
          assert.equal(snapshot.sides[0].pokemon[1].species, '[Species:mew]');
          assert.deepEqual(snapshot.sides[0].active, ['[Pokemon:p1a]', '[Pokemon:p1b]']);
        }
      }
    },
  });
  assert.equal(cache.templates.size, 0);
});
