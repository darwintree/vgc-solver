'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {Battle, State} = require('@pkmn/sim');
const {FIXED_SEED} = require('../src/branching-prng');
const {snapshotBattle, restoreBattle, stateKey} = require('../src/showdown-adapter');

function canonicalizeForTest(raw) {
  return {
    ...raw,
    log: [], inputLog: [], messageLog: [], hints: [], lastMoveLine: -1,
    sentLogPos: 0, sentEnd: false, sentRequests: true,
    prng: FIXED_SEED, prngSeed: FIXED_SEED,
  };
}

function oldSnapshot(raw) {
  return JSON.parse(JSON.stringify(canonicalizeForTest(raw)));
}

function makeBattle(formatid = 'gen9customgame') {
  const doubles = formatid.includes('doubles');
  const battle = new Battle({
    formatid, debug: true, strictChoices: true,
    p1: {name: 'P1', team: [
      {species: 'Ditto', moves: ['Transform']},
      {species: 'Mew', moves: ['Splash']},
    ]},
    p2: {name: 'P2', team: [
      {species: 'Mew', moves: ['Splash']},
      {species: 'Alakazam', moves: ['Splash']},
    ]},
  });
  battle.makeChoices(doubles ? 'team 12' : 'team 1', doubles ? 'team 12' : 'team 1');
  return battle;
}

test('snapshot detaches only native serializer aliases and preserves state shape', () => {
  const battle = makeBattle();
  battle.activeMove = battle.dex.getActiveMove('tackle');
  battle.p1.active[0].illusion = battle.p2.active[0];
  battle.p1.active[0].transformed = true;
  battle.p1.active[0].volatiles.snapshotProbe = {
    nestedUndefined: undefined,
    nestedNull: null,
    nan: NaN,
    positiveInfinity: Infinity,
    negativeInfinity: -Infinity,
    negativeZero: -0,
    array: [, undefined, NaN, -0],
  };
  battle.p1.active[0].volatiles.protoProbe = JSON.parse('{"__proto__":{"leaked":true},"kept":1}');
  const raw = battle.toJSON();
  const snapshot = snapshotBattle(battle);
  assert.deepStrictEqual(snapshot, oldSnapshot(raw));

  assert.deepEqual(snapshot.activeMove, raw.activeMove);
  assert.deepEqual(snapshot.sides[0].pokemon[0].set, raw.sides[0].pokemon[0].set);
  assert.notEqual(snapshot.sides[0].pokemon[0].set, raw.sides[0].pokemon[0].set);
  assert.equal(snapshot.sides[0].pokemon[0].illusion, '[Pokemon:p2a]');
  assert.equal(snapshot.sides[0].pokemon[0].transformed, true);
  assert.equal(Object.keys(snapshot).length, Object.keys(raw).length);

  // Canonical public keys are unchanged from the old JSON roundtrip.
  assert.equal(stateKey(snapshot), stateKey(raw));
  assert.equal(snapshot.sides[0].pokemon[0].fainted, false);
  const probe = snapshot.sides[0].pokemon[0].volatiles.snapshotProbe;
  assert.equal(Object.prototype.hasOwnProperty.call(probe, 'nestedUndefined'), false);
  assert.equal(probe.nestedNull, null);
  assert.deepEqual(probe.array, [null, null, null, 0]);
  assert.equal(Object.getPrototypeOf(snapshot.sides[0].pokemon[0].volatiles.protoProbe), Object.prototype);

  // Mutating a detached set cannot mutate the live Pokemon's set.
  const liveSet = battle.p1.pokemon[0].set;
  snapshot.sides[0].pokemon[0].set.moves[0] = 'Splash';
  assert.equal(liveSet.moves[0], 'Transform');
  assert.equal(stateKey(snapshot), stateKey(snapshotBattle(restoreBattle(snapshot))));
});

test('doubles, team ordering, illusion and active move serialize without graph alias', () => {
  const battle = makeBattle('gen9doublescustomgame');
  battle.activeMove = battle.dex.getActiveMove('protect');
  battle.p1.active[0].illusion = battle.p2.active[1];
  battle.p1.active[0].transformed = true;
  const snapshot = snapshotBattle(battle);
  assert.equal(snapshot.sides[0].pokemon.length, 2);
  assert.equal(snapshot.sides[1].pokemon.length, 2);
  for (const side of snapshot.sides) {
    for (const pokemon of side.pokemon) {
      assert.ok(pokemon.set && typeof pokemon.set === 'object');
      assert.ok(pokemon.illusion === null || typeof pokemon.illusion === 'string');
    }
  }
  assert.equal(snapshot.sides[0].pokemon[0].illusion, '[Pokemon:p2b]');
  assert.deepEqual(snapshot.activeMove, {hit: 0, move: '[Move:protect]'});
  assert.deepStrictEqual(snapshot, oldSnapshot(battle.toJSON()));
});

test('shared team set aliases preserve old JSON roundtrip splitting', () => {
  const battle = makeBattle();
  battle.p1.pokemon[1].set = battle.p1.pokemon[0].set;
  const snapshot = snapshotBattle(battle);
  const first = snapshot.sides[0].pokemon[0];
  const second = snapshot.sides[0].pokemon[1];
  assert.notEqual(first.set, second.set);
  assert.equal(second.illusion, null);
  assert.equal(Object.values(second).some(value => value === undefined), false);
  assert.deepStrictEqual(snapshot, oldSnapshot(battle.toJSON()));
});

test('custom toJSON falls back to the complete JSON path', () => {
  const battle = makeBattle();
  const native = battle.toJSON;
  battle.toJSON = () => ({...native.call(battle), custom: {undefinedValue: undefined, nullValue: null}});
  assert.deepStrictEqual(snapshotBattle(battle), oldSnapshot(battle.toJSON()));
});

test('State.serializeBattle override also disables the native fast path', () => {
  const battle = makeBattle();
  const native = State.serializeBattle;
  State.serializeBattle = function patchedSerializeBattle(current) {
    return {...native.call(this, current), custom: {undefinedValue: undefined}};
  };
  try {
    assert.deepStrictEqual(snapshotBattle(battle), oldSnapshot(battle.toJSON()));
  } finally {
    State.serializeBattle = native;
  }
});

test('overridden State.serializeWithRefs falls back without retaining live aliases', () => {
  const battle = makeBattle();
  const native = State.serializeWithRefs;
  State.serializeWithRefs = function patchedSerializeWithRefs(value, current) {
    if (value === current.p1.active[0].volatiles) return value;
    return native.call(this, value, current);
  };
  try {
    const liveVolatiles = battle.p1.active[0].volatiles;
    const snapshot = snapshotBattle(battle);
    assert.notEqual(snapshot.sides[0].pokemon[0].volatiles, liveVolatiles);
    assert.deepStrictEqual(snapshot, oldSnapshot(battle.toJSON()));
  } finally {
    State.serializeWithRefs = native;
  }
});
