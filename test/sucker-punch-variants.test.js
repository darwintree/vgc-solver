'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  enumerateTurn,
  snapshotBattle,
} = require('../src/showdown-adapter');
const {
  suckerPunchAccuracyGame,
  suckerPunchBothProtectGame,
  suckerPunchBulkyTargetGame,
  suckerPunchCoverageGame,
  suckerPunchGame,
  suckerPunchOHKOTwoHKOGame,
  suckerPunchTwoHKOGame,
} = require('../src/cases');
const {assertSameDistribution, enumerateNative} = require('./helpers/distribution');

const variants = [
  ['two-HKO', suckerPunchTwoHKOGame, 'Techno Blast', 1, 1],
  ['accuracy', suckerPunchAccuracyGame, 'Hyper Beam', 1, 2],
  ['coverage', suckerPunchCoverageGame, 'Hyper Beam', 1, 3],
  ['bulky target', suckerPunchBulkyTargetGame, 'Hyper Beam', 130, 4],
  ['both Protect', suckerPunchBothProtectGame, 'Hyper Beam', 130, 5],
];

function moveSlot(battle, side, name) {
  const id = name.toLowerCase().replaceAll(' ', '');
  const slot = battle[side].active[0].moveSlots.findIndex(move => move.id === id);
  assert.notEqual(slot, -1, `${side} is missing ${name}`);
  return slot;
}

function command(battle, side, name) {
  return `move ${moveSlot(battle, side, name) + 1}`;
}

function distributionFor(makeCase, p1Move, p2Move) {
  const battle = makeCase().battle;
  const snapshot = snapshotBattle(battle);
  const p1 = {command: command(battle, 'p1', p1Move)};
  const p2 = {command: command(battle, 'p2', p2Move)};
  return {
    native: enumerateNative(snapshot, p1, p2),
    optimized: enumerateTurn(snapshot, p1, p2),
  };
}

function damage(makeCase, sourceSide, targetSide, moveName, roll, willCrit) {
  const battle = makeCase().battle;
  const move = battle.dex.getActiveMove(moveName);
  move.willCrit = willCrit;
  // Keep the native getDamage implementation while selecting each of its
  // randomizer rolls (85..100) deterministically.
  battle.random = () => 100 - roll;
  return battle.actions.getDamage(
    battle[sourceSide].active[0], battle[targetSide].active[0], move, true
  );
}

test('five cumulative fixtures preserve the requested battle shape', () => {
  for (const [name, makeCase, strongMove, targetHP, stage] of variants) {
    const battle = makeCase().battle;
    const kingambit = battle.p1.active[0];
    const electrode = battle.p2.active[0];

    assert.equal(kingambit.hp, 6, name);
    assert.equal(electrode.hp, targetHP, name);
    assert.equal(kingambit.ability, 'defiant', name);
    assert.equal(electrode.ability, 'soundproof', name);
    assert.equal(kingambit.set.nature, 'Brave', name);
    assert.equal(electrode.set.nature, 'Timid', name);
    assert.ok(kingambit.getStat('spe') < electrode.getStat('spe'), `${name}: speed order`);

    const p1Moves = kingambit.moveSlots.map(move => move.id);
    const expectedP1 = stage >= 5
      ? ['suckerpunch', 'knockoff', 'earthquake', 'protect']
      : stage >= 3
        ? ['suckerpunch', 'knockoff', 'earthquake']
        : ['suckerpunch', 'knockoff'];
    assert.deepEqual(p1Moves, expectedP1, name);
    assert.deepEqual(electrode.moveSlots.map(move => move.id), [
      'protect', 'tackle', strongMove.toLowerCase().replaceAll(' ', ''),
    ], name);

    for (const side of battle.sides) {
      for (const slot of side.active[0].moveSlots) {
        assert.equal(slot.pp, slot.maxpp, `${name}: ${side.id} ${slot.id} max PP`);
      }
    }

    assert.equal(battle.dex.moves.get('suckerpunch').priority, 1);
    assert.equal(battle.dex.moves.get('protect').priority, 4);
    assert.equal(battle.dex.moves.get('knockoff').priority, 0);
    assert.equal(battle.dex.moves.get('earthquake').priority, 0);
    assert.equal(battle.dex.moves.get(strongMove).accuracy, stage === 1 ? 100 : 90);
  }
});

test('native damage ranges support the 2HKO fixtures and coverage KO', () => {
  for (const [roll, expected] of [[85, 3], [100, 4]]) {
    assert.equal(damage(suckerPunchTwoHKOGame, 'p2', 'p1', 'Tackle', roll, false), expected);
  }
  for (const [roll, expected] of [[85, 5], [100, 6]]) {
    assert.equal(damage(suckerPunchTwoHKOGame, 'p2', 'p1', 'Tackle', roll, true), expected);
  }

  for (const [roll, expected] of [[85, 70], [100, 84]]) {
    assert.equal(damage(suckerPunchBulkyTargetGame, 'p1', 'p2', 'Knock Off', roll, false), expected);
    assert.equal(2 * expected >= 130, true);
  }
  for (const [roll, expected] of [[85, 106], [100, 126]]) {
    assert.equal(damage(suckerPunchBulkyTargetGame, 'p1', 'p2', 'Knock Off', roll, true), expected);
    assert.ok(expected < 130, `critical Knock Off must not OHKO: ${expected}`);
  }

  assert.ok(damage(suckerPunchBulkyTargetGame, 'p1', 'p2', 'Earthquake', 85, false) >= 130);
});

test('native strong fast move has the expected 100% and 90% outcomes', () => {
  for (const [index, [, makeCase, strongMove]] of variants.entries()) {
    const lowMove = index >= 2 ? 'Earthquake' : 'Knock Off';
    const {native} = distributionFor(makeCase, lowMove, strongMove);
    const terminal = new Map(native.outcomes.map(outcome => [outcome.utility, outcome.probability]));
    if (index === 0) {
      assert.ok(Math.abs((terminal.get(-1) || 0) - 1) < 1e-12);
      assert.equal(terminal.get(1) || 0, 0);
    } else {
      assert.ok(Math.abs((terminal.get(-1) || 0) - 0.9) < 1e-9);
      assert.ok(Math.abs((terminal.get(1) || 0) - 0.1) < 1e-9);
    }
  }
});

test('optimized transitions match native transitions for miss, Protect, and bulky HP', () => {
  for (const [makeCase, p1Move, p2Move] of [
    [suckerPunchAccuracyGame, 'Knock Off', 'Hyper Beam'],
    [suckerPunchBulkyTargetGame, 'Earthquake', 'Hyper Beam'],
    [suckerPunchBothProtectGame, 'Protect', 'Hyper Beam'],
    [suckerPunchBothProtectGame, 'Earthquake', 'Protect'],
  ]) {
    const {native, optimized} = distributionFor(makeCase, p1Move, p2Move);
    assertSameDistribution(native, optimized);
    assert.ok(optimized.simulatorRuns <= native.simulatorRuns);
  }
});

test('parallel case 4 fixture has native OHKO and 2HKO damage contracts', () => {
  const battle = suckerPunchOHKOTwoHKOGame().battle;
  const kingambit = battle.p1.active[0];
  const electrode = battle.p2.active[0];

  assert.equal(kingambit.hp, 6);
  assert.equal(electrode.hp, 56);
  assert.deepEqual(kingambit.moveSlots.map(move => move.id), [
    'suckerpunch', 'tackle', 'earthquake',
  ]);
  assert.deepEqual(electrode.moveSlots.map(move => move.id), [
    'protect', 'tackle', 'hyperbeam',
  ]);
  assert.deepEqual(
    battle.sides.map(side => side.active[0].moveSlots.map(move => move.pp)),
    [[8, 56, 16], [16, 56, 8]],
  );
  assert.equal(battle.dex.moves.get('suckerpunch').priority, 1);
  assert.equal(battle.dex.moves.get('tackle').priority, 0);
  assert.equal(battle.dex.moves.get('earthquake').priority, 0);
  assert.equal(battle.dex.moves.get('protect').priority, 4);
  assert.equal(battle.dex.moves.get('hyperbeam').priority, 0);
  assert.ok(kingambit.getStat('spe') < electrode.getStat('spe'));

  for (let roll = 85; roll <= 100; roll++) {
    for (const willCrit of [false, true]) {
      const suckerPunchDamage = damage(
        suckerPunchOHKOTwoHKOGame, 'p1', 'p2', 'Sucker Punch', roll, willCrit,
      );
      const tackleDamage = damage(
        suckerPunchOHKOTwoHKOGame, 'p1', 'p2', 'Tackle', roll, willCrit,
      );
      assert.ok(suckerPunchDamage >= 56,
        `Sucker Punch must OHKO at roll ${roll}, crit=${willCrit}: ${suckerPunchDamage}`);
      assert.ok(tackleDamage < 56,
        `Tackle must not OHKO at roll ${roll}, crit=${willCrit}: ${tackleDamage}`);
      assert.ok(tackleDamage * 2 >= 56,
        `Tackle must 2HKO at roll ${roll}, crit=${willCrit}: ${tackleDamage}`);
    }
  }
});

test('parallel case 4 native and optimized priority transitions agree', () => {
  const suckerPunch = distributionFor(suckerPunchOHKOTwoHKOGame, 'Sucker Punch', 'Hyper Beam');
  assertSameDistribution(suckerPunch.native, suckerPunch.optimized);
  assert.deepEqual(suckerPunch.native.outcomes.map(outcome => outcome.utility), [1]);
  assert.equal(suckerPunch.native.outcomes[0].probability, 1);

  const tackle = distributionFor(suckerPunchOHKOTwoHKOGame, 'Tackle', 'Hyper Beam');
  assertSameDistribution(tackle.native, tackle.optimized);
  const terminal = new Map(tackle.native.outcomes.map(outcome => [outcome.utility, outcome.probability]));
  const continuing = tackle.native.outcomes
    .filter(outcome => outcome.snapshot)
    .reduce((sum, outcome) => sum + outcome.probability, 0);
  assert.ok(Math.abs((terminal.get(-1) || 0) - 0.9) < 1e-9);
  assert.equal(terminal.get(1) || 0, 0);
  assert.ok(continuing > 0 && Math.abs(continuing - 0.1) < 1e-9);

  const protect = distributionFor(suckerPunchOHKOTwoHKOGame, 'Sucker Punch', 'Protect');
  assertSameDistribution(protect.native, protect.optimized);
  assert.equal(protect.native.outcomes.length, 1);
  assert.equal(protect.native.outcomes[0].utility, null);
  assert.equal(protect.native.outcomes[0].snapshot.sides[1].pokemon[0].hp, 56);
});

test('constructing variants does not alter the original fixture', () => {
  const oldFixtures = [suckerPunchGame, ...variants.map(([, makeCase]) => makeCase)];
  const before = oldFixtures.map(makeCase => snapshotBattle(makeCase().battle));
  suckerPunchOHKOTwoHKOGame();
  const after = oldFixtures.map(makeCase => snapshotBattle(makeCase().battle));
  assert.deepEqual(after, before);
});
