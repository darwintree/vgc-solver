'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {suckerPunchGame} = require('../src/cases');
const {snapshotBattle, stateKey} = require('../src/showdown-adapter');
const {OneVsOneSolver} = require('../src/solver');
const {
  auditNativeMemoState,
  createMemoStateKey,
  privateSnapshotKey,
} = require('../src/native-memo-key');

test('native memo audit accepts the stock Gen 9 data callbacks', () => {
  const {battle} = suckerPunchGame();
  assert.equal(auditNativeMemoState(battle), true);
});

test('a changed native Battle prototype method disables normalization', {concurrency: false}, () => {
  const {Battle} = require('@pkmn/sim');
  const {battle} = suckerPunchGame();
  const original = Battle.prototype.randomizer;
  Battle.prototype.randomizer = function customAbsoluteOrderReader() {
    return this.effectOrder % 2 ? 1 : 100;
  };
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    Battle.prototype.randomizer = original;
  }
});

test('a changed Dex helper instance method disables normalization', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const original = Object.getOwnPropertyDescriptor(battle.dex, 'getEffectiveness');
  battle.dex.getEffectiveness = function customAbsoluteOrderReader() {
    return this.effectOrder;
  };
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    if (original) Object.defineProperty(battle.dex, 'getEffectiveness', original);
    else delete battle.dex.getEffectiveness;
  }
});

test('a changed State serializer prototype method disables normalization', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const path = require('node:path');
  const simDirectory = path.dirname(require.resolve('@pkmn/sim'));
  const {State} = require(path.join(simDirectory, 'state.js'));
  const prototype = Object.getPrototypeOf(State);
  const original = Object.getOwnPropertyDescriptor(prototype, 'serializeBattle');
  prototype.serializeBattle = function customAbsoluteOrderReader() {
    return this.effectOrder;
  };
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    Object.defineProperty(prototype, 'serializeBattle', original);
  }
});

for (const [label, getTarget, method] of [
  ['Battle randomizer', battle => battle, 'randomizer'],
  ['Pokemon damage', battle => battle.p1.active[0], 'damage'],
  ['BattleActions method', battle => battle.actions, 'selfDrops'],
]) {
  test(`an instance override of ${label} disables normalization`, {concurrency: false}, () => {
    const {battle} = suckerPunchGame();
    const target = getTarget(battle);
    const original = Object.getOwnPropertyDescriptor(target, method);
    target[method] = function customAbsoluteOrderReader() {
      return this.effectState.effectOrder;
    };
    try {
      assert.equal(auditNativeMemoState(battle), false);
    } finally {
      if (original) Object.defineProperty(target, method, original);
      else delete target[method];
    }
  });
}

test('a callback installed on the actual active ability disables normalization', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const ability = battle.p1.active[0].getAbility();
  const original = ability.onBeforeTurn;
  ability.onBeforeTurn = function customEffectOrderReader() {
    return this.effectState.effectOrder;
  };
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    if (original === undefined) delete ability.onBeforeTurn;
    else ability.onBeforeTurn = original;
  }
});

test('a callback accessor on an active effect forces the exact-key fallback', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const ability = battle.p1.active[0].getAbility();
  const hadOwn = Object.prototype.hasOwnProperty.call(ability, 'onBeforeTurn');
  const original = Object.getOwnPropertyDescriptor(ability, 'onBeforeTurn');
  Object.defineProperty(ability, 'onBeforeTurn', {
    configurable: true,
    enumerable: true,
    get() { return function accessorCallback() {}; },
  });
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    if (hadOwn) Object.defineProperty(ability, 'onBeforeTurn', original);
    else delete ability.onBeforeTurn;
  }
});

test('an inherited callback descriptor is included in the audit', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const ability = battle.p1.active[0].getAbility();
  const originalPrototype = Object.getPrototypeOf(ability);
  const customPrototype = Object.create(originalPrototype);
  Object.defineProperty(customPrototype, 'onBeforeTurn', {
    configurable: true,
    enumerable: true,
    value() { return this.effectState.effectOrder; },
  });
  Object.setPrototypeOf(ability, customPrototype);
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    Object.setPrototypeOf(ability, originalPrototype);
  }
});

test('a changed Pokemon prototype getter is rejected before it can run', {concurrency: false}, () => {
  const {Pokemon} = require('@pkmn/sim');
  const {battle} = suckerPunchGame();
  const original = Pokemon.prototype.getAbility;
  Pokemon.prototype.getAbility = function customGetter() {
    return this.effectState.effectOrder;
  };
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    Pokemon.prototype.getAbility = original;
  }
});

test('function values inside collection roots are audited', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const original = battle.events;
  battle.events = new Map([['custom', function customEvent() {
    return this.effectState.effectOrder;
  }]]);
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    battle.events = original;
  }
});

test('the same native audit accepts a doubles battle', () => {
  const {Battle} = require('@pkmn/sim');
  const battle = new Battle({formatid: 'gen9doublescustomgame'});
  assert.equal(auditNativeMemoState(battle), true);
});

test('a non-base Dex mode uses the exact-key fallback', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const original = battle.dex.currentMod;
  battle.dex.currentMod = 'custommod';
  try {
    assert.equal(auditNativeMemoState(battle), false);
  } finally {
    battle.dex.currentMod = original;
  }
});

for (const [table, id, callback] of [
  ['Abilities', 'defiant', 'onStart'],
  ['Moves', 'tackle', 'onHit'],
  ['Conditions', 'brn', 'onStart'],
]) {
  test(`custom ${table} callback reading effectOrder disables normalization`, () => {
    const {battle} = suckerPunchGame();
    const entry = battle.dex.dataCache[table][id];
    const original = entry[callback];
    entry[callback] = function customEffectOrderReader() {
      return this.effectState.effectOrder;
    };
    try {
      assert.equal(auditNativeMemoState(battle), false);
    } finally {
      if (original === undefined) delete entry[callback];
      else entry[callback] = original;
    }
  });
}

test('private memo key normalizes only relative live effect order', {concurrency: false}, () => {
  const {battle} = suckerPunchGame();
  const memoKey = createMemoStateKey(battle, stateKey);
  const first = snapshotBattle(battle);
  const second = snapshotBattle(battle);
  const install = (snapshot, a, b, counter) => {
    snapshot.effectOrder = counter;
    snapshot.sides[0].pokemon[0].volatiles.orderA = {effectOrder: a};
    snapshot.sides[0].pokemon[0].volatiles.orderB = {effectOrder: b};
    snapshot.sides[0].pokemon[0].volatiles.orderZero = {effectOrder: 0};
  };
  install(first, 3, 11, 12);
  install(second, 30, 70, 99);
  assert.notEqual(stateKey(first), stateKey(second), 'public key remains absolute');
  assert.equal(memoKey(first), memoKey(second), 'private key keeps relative order');
  assert.equal(memoKey(first), memoKey(JSON.parse(JSON.stringify(first))), 'JSON clone has same key');

  const swapped = snapshotBattle(battle);
  install(swapped, 70, 30, 99);
  assert.notEqual(memoKey(first), memoKey(swapped));

  const tied = snapshotBattle(battle);
  install(tied, 3, 3, 12);
  assert.notEqual(memoKey(first), memoKey(tied));

  const invalidCounter = snapshotBattle(battle);
  install(invalidCounter, 3, 11, 3);
  assert.notEqual(memoKey(first), memoKey(invalidCounter), 'invalid global counter falls back');

  for (const counter of [0x100000000, Number.MAX_SAFE_INTEGER]) {
    const hugeCounter = snapshotBattle(battle);
    install(hugeCounter, 3, 11, counter);
    assert.notEqual(memoKey(first), memoKey(hugeCounter),
      `counter ${counter} stays on the exact-key path`);
  }
});

test('private key preserves strings, escaped keys, arrays, and undefined slots', {concurrency: false}, () => {
  const first = {
    effectOrder: 20,
    live: {effectOrder: 3},
    tie: {effectOrder: 3},
    zero: {effectOrder: 0},
    array: [undefined, {effectOrder: 11}],
    text: 'effectOrder: 999',
    'foo"effectOrder': 123,
  };
  const second = JSON.parse(JSON.stringify(first));
  second.effectOrder = 200;
  second.live.effectOrder = 30;
  second.tie.effectOrder = 30;
  second.array[1].effectOrder = 70;
  assert.equal(privateSnapshotKey(first), privateSnapshotKey(second));
  const reordered = JSON.parse(JSON.stringify(first));
  reordered.ordered = {b: 2, a: 1};
  first.ordered = {a: 1, b: 2};
  assert.notEqual(privateSnapshotKey(first), privateSnapshotKey(reordered),
    'the fast key deliberately preserves JSON insertion order');
  const encoded = privateSnapshotKey(first);
  assert.match(encoded, /"array":\[null/);
  assert.match(encoded, /effectOrder: 999/);
  assert.match(encoded, /"foo\\"effectOrder":123/);
});

test('relative-order serialization preserves frozen graphs and own __proto__ paths', () => {
  const snapshot = JSON.parse('{"effectOrder":20,"__proto__":{"effectOrder":7},"array":[{"effectOrder":2}],"zero":{"effectOrder":0}}');
  const before = JSON.stringify(snapshot);
  function freeze(value) {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  freeze(snapshot);
  const encoded = privateSnapshotKey(snapshot);
  const result = JSON.parse(encoded.slice('memo:relative-effect-order:'.length));
  assert.equal(result.effectOrder, 3);
  assert.equal(result.__proto__.effectOrder, 2);
  assert.equal(result.array[0].effectOrder, 1);
  assert.equal(result.zero.effectOrder, 0);
  assert.equal(JSON.stringify(snapshot), before);
});

test('one solver re-audits a reused instance and separates exact keys', {concurrency: false}, () => {
  const solver = new OneVsOneSolver();
  const native = suckerPunchGame().battle;
  native.effectOrder = 99;
  native.p2.active[0].hp = 0;
  solver.solve(native);

  const custom = suckerPunchGame().battle;
  custom.effectOrder = 99;
  custom.p2.active[0].hp = 0;
  const ability = custom.p1.active[0].getAbility();
  ability.onBeforeTurn = function customEffectOrderReader() {
    return this.effectState.effectOrder;
  };
  try {
    solver.solve(custom);
    assert.equal(solver.memo.has(stateKey(snapshotBattle(custom))), true,
      'custom solve re-audits and stores an exact key');
  } finally {
    delete ability.onBeforeTurn;
  }
});
