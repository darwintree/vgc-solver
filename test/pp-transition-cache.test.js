'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createBattle,
  createPPTransitionCache,
  enumerateTurn,
  snapshotBattle,
  stateKey,
} = require('../src/showdown-adapter');
const {assertSameDistribution, enumerateNative} = require('./helpers/distribution');
const {suckerPunchOHKOTwoHKOGame} = require('../src/cases');
const {ppBaseKey} = require('../src/pp-transition-cache');

test('full-PP Tackle/Tackle root preserves every native successor and probability', () => {
  const snapshot = snapshotBattle(suckerPunchOHKOTwoHKOGame().battle);
  const action = {command: 'move 2'};
  const native = enumerateNative(snapshot, action, action);
  const cache = createPPTransitionCache();
  const options = {ppCache: cache};
  const computed = enumerateTurn(snapshot, action, action, options);
  const replayed = enumerateTurn(snapshot, action, action, options);
  assert.ok(computed.outcomes.filter(outcome => outcome.snapshot).length > 1);
  assert.equal(replayed.cacheHits, 1);
  assertSameDistribution(native, computed);
  assertSameDistribution(native, replayed);
});

test('PP key buckets only move-slot PP without changing the snapshot', () => {
  const snapshot = snapshotBattle(createBattle(
    {species: 'Mew', moves: ['splash', 'protect']},
    {species: 'Snorlax', moves: ['splash', 'protect']},
  ));
  snapshot.sides[0].pokemon[0].baseMoveSlots = [{id: 'splash', pp: 0}];
  snapshot.sides[0].pokemon[0].volatiles.probe = {pp: 23};
  const before = JSON.stringify(snapshot);
  const expected = JSON.parse(before);
  for (const side of expected.sides) {
    for (const pokemon of side.pokemon) {
      for (const name of ['moveSlots', 'baseMoveSlots']) {
        if (!Array.isArray(pokemon[name])) continue;
        for (const slot of pokemon[name]) slot.pp = slot.pp > 0 ? 1 : 0;
      }
    }
  }
  assert.equal(ppBaseKey(snapshot), JSON.stringify(expected));
  assert.equal(JSON.stringify(snapshot), before);
});

test('PP template construction keys each continuing branch once and preserves the distribution', () => {
  const snapshot = snapshotBattle(createBattle(
    {species: 'Snorlax', moves: ['tackle']},
    {species: 'Mew', moves: ['splash']},
  ));
  const action = {command: 'move 1'};
  const cache = createPPTransitionCache();
  let keyCalls = 0;
  const result = enumerateTurn(snapshot, action, action, {
    ppCache: cache,
    outcomeKey(next) { keyCalls++; return stateKey(next); },
  });
  assert.equal(cache.templates.size, 1);
  assert.equal(keyCalls, result.simulatorRuns);
  const candidate = withPP(snapshot, 0, 0, 0, 3);
  const cached = enumerateTurn(candidate, action, action, {ppCache: cache});
  assert.equal(cached.cacheHits, 1);
  assertSameDistribution(enumerateTurn(candidate, action, action), cached);
});

function withPP(snapshot, sideIndex, pokemonIndex, slotIndex, pp) {
  const copy = JSON.parse(JSON.stringify(snapshot));
  copy.sides[sideIndex].pokemon[pokemonIndex].moveSlots[slotIndex].pp = pp;
  return copy;
}

function distribution(result) {
  return result.outcomes.map(outcome => [
    outcome.snapshot ? stateKey(outcome.snapshot) : `terminal:${outcome.utility}`,
    outcome.probability,
  ]).sort((a, b) => a[0].localeCompare(b[0]));
}

test('PP template replays exact positive-range transitions without simulating branches', () => {
  const battle = createBattle(
    {species: 'Snorlax', moves: ['tackle', 'protect']},
    {species: 'Pikachu', moves: ['tackle', 'protect']},
  );
  const initial = snapshotBattle(battle);
  const p1 = {command: 'move 1'};
  const p2 = {command: 'move 1'};
  const cache = createPPTransitionCache();

  enumerateTurn(withPP(initial, 0, 0, 0, 3), p1, p2, {ppCache: cache});
  const cached = enumerateTurn(withPP(initial, 0, 0, 0, 2), p1, p2, {ppCache: cache});
  const native = enumerateTurn(withPP(initial, 0, 0, 0, 2), p1, p2);

  assert.equal(cached.cacheHits, 1);
  assert.equal(cached.simulatorRuns, 0);
  assertSameDistribution(native, cached);
});

test('PP template rejects a changed exhaustion branch and remains exact', () => {
  const battle = createBattle(
    {species: 'Snorlax', moves: ['tackle', 'protect']},
    {species: 'Pikachu', moves: ['tackle', 'protect']},
  );
  const initial = snapshotBattle(battle);
  const p1 = {command: 'move 1'};
  const p2 = {command: 'move 1'};
  const cache = createPPTransitionCache();

  enumerateTurn(withPP(initial, 0, 0, 0, 2), p1, p2, {ppCache: cache});
  const candidate = enumerateTurn(withPP(initial, 0, 0, 0, 1), p1, p2, {ppCache: cache});
  const native = enumerateTurn(withPP(initial, 0, 0, 0, 1), p1, p2);

  assert.equal(candidate.cacheHits, 0);
  assert.ok(candidate.simulatorRuns > 0);
  assertSameDistribution(native, candidate);
});

test('unsupported getMoves callback path does not create a PP template', () => {
  const battle = createBattle(
    {species: 'Snorlax', moves: ['return', 'protect']},
    {species: 'Pikachu', moves: ['tackle', 'protect']},
  );
  const cache = createPPTransitionCache();
  const result = enumerateTurn(snapshotBattle(battle), {command: 'move 1'}, {command: 'move 1'}, {ppCache: cache});
  assert.ok(result.simulatorRuns > 0);
  assert.equal(cache.templates.size, 0);
});

test('PP templates stay exact across item and PP-consuming move mechanisms', () => {
  const mechanisms = ['seismic toss', 'spite', 'encore', 'grudge', 'trump card'];
  for (const move of mechanisms) {
    const battle = createBattle(
      {species: 'Mew', moves: [move, 'protect'], item: 'Leppa Berry'},
      {species: 'Snorlax', ability: 'Pressure', moves: ['splash', 'protect']},
    );
    const initial = snapshotBattle(battle);
    const p1 = {command: 'move 1'};
    const p2 = {command: 'move 1'};
    const cache = createPPTransitionCache();
    const high = withPP(initial, 0, 0, 0, 5);
    const low = withPP(initial, 0, 0, 0, 3);
    enumerateTurn(high, p1, p2, {ppCache: cache});
    const before = JSON.stringify(low);
    const cached = enumerateTurn(low, p1, p2, {ppCache: cache});
    const native = enumerateTurn(low, p1, p2);
    assert.equal(JSON.stringify(low), before);
    assertSameDistribution(native, cached);
  }
});

test('PP templates remain exact for switch and doubles position changes', () => {
  const {Battle} = require('@pkmn/sim');
  const {FIXED_SEED} = require('../src/branching-prng');
  const set = (species, moves) => ({species, level: 50, moves, nature: 'Serious'});
  const makeSwitch = () => {
    const battle = new Battle({
      formatid: 'gen9customgame', debug: true, strictChoices: true, seed: FIXED_SEED,
      p1: {name: 'P1', team: [set('Mew', ['splash', 'protect']), set('Mew', ['splash', 'protect'])]},
      p2: {name: 'P2', team: [set('Snorlax', ['splash', 'protect']), set('Snorlax', ['splash', 'protect'])]},
    });
    battle.makeChoices('team 12', 'team 12');
    return battle;
  };
  const switchBattle = makeSwitch();
  const switchSnapshot = snapshotBattle(switchBattle);
  const switchCache = createPPTransitionCache();
  const switchAction = {command: 'switch 2'};
  const moveAction = {command: 'move 1'};
  const switchHigh = withPP(switchSnapshot, 0, 1, 0, 5);
  const switchLow = withPP(switchSnapshot, 0, 1, 0, 3);
  enumerateTurn(switchHigh, switchAction, moveAction, {ppCache: switchCache});
  const switchCached = enumerateTurn(switchLow, switchAction, moveAction, {ppCache: switchCache});
  const switchNative = enumerateTurn(switchLow, switchAction, moveAction);
  assertSameDistribution(switchNative, switchCached);

  const doubles = new Battle({
    formatid: 'gen9doublescustomgame', debug: true, strictChoices: true, seed: FIXED_SEED,
    p1: {name: 'P1', team: [set('Mew', ['seismic toss', 'protect']), set('Alakazam', ['splash', 'protect'])]},
    p2: {name: 'P2', team: [set('Snorlax', ['splash', 'protect']), set('Slowbro', ['splash', 'protect'])]},
  });
  doubles.makeChoices('team 12', 'team 12');
  const doubleSnapshot = snapshotBattle(doubles);
  const doubleCache = createPPTransitionCache();
  const doubleAction1 = {command: 'move 1 2, move 1'};
  const doubleAction2 = {command: 'move 1, move 1'};
  const doubleHigh = withPP(doubleSnapshot, 0, 0, 0, 5);
  const doubleLow = withPP(doubleSnapshot, 0, 0, 0, 3);
  enumerateTurn(doubleHigh, doubleAction1, doubleAction2, {ppCache: doubleCache});
  const doubleCached = enumerateTurn(doubleLow, doubleAction1, doubleAction2, {ppCache: doubleCache});
  const doubleNative = enumerateTurn(doubleLow, doubleAction1, doubleAction2);
  assertSameDistribution(doubleNative, doubleCached);
});

test('Transform output shape changes disable PP templates', () => {
  const battle = createBattle(
    {species: 'Mew', moves: ['transform', 'protect']},
    {species: 'Snorlax', moves: ['tackle', 'protect']},
  );
  const initial = snapshotBattle(battle);
  const cache = createPPTransitionCache();
  const action1 = {command: 'move 1'};
  const action2 = {command: 'move 1'};
  enumerateTurn(withPP(initial, 0, 0, 0, 5), action1, action2, {ppCache: cache});
  const candidate = enumerateTurn(withPP(initial, 0, 0, 0, 3), action1, action2, {ppCache: cache});
  const native = enumerateTurn(withPP(initial, 0, 0, 0, 3), action1, action2);
  assertSameDistribution(native, candidate);
});
