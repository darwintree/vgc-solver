import type {ModdedItemDataTable, PRNG, PokemonSet} from '@pkmn/sim';
import type {Mutable} from './helpers/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import {Battle, Dex, toID} from '@pkmn/sim';
import {BranchingPRNG, NeedRandom} from '../src/branching-prng';
import {assertSameDistribution, enumerateNative} from './helpers/distribution';
import {installSimulatorOptimizations} from '../src/simulator-optimizations';
import {
  createBattle,
  enumerateTurn,
  snapshotBattle,
} from '../src/showdown-adapter';
import {setHP, refreshMoveRequest} from '../src/showdown-adapter';

function attackBattle(move, target = 'Snorlax') {
  const battle = createBattle(
    {species: 'Mew', level: 50, moves: [move]},
    {species: target, level: 50, moves: ['Splash']}
  );
  setHP(battle, 'p2', battle.p2.active[0].maxhp - 1);
  refreshMoveRequest(battle);
  return battle;
}

test('randomMapped groups equal integer damage values with exact 32-bit mass', () => {
  const prng = new BranchingPRNG();
  assert.throws(() => prng.randomMapped(0, 16, roll => Math.floor(37 * (100 - roll) / 100), 'damage'), error => {
    assert.ok(error instanceof NeedRandom);
    assert.ok(error.alternatives.length < 16);
    const total = error.alternatives.reduce((sum, option) => sum + option.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-15);
    return true;
  });
});

test('randomGrouped returns raw representatives for observable classes', () => {
  const prng = new BranchingPRNG();
  assert.throws(() => prng.randomGrouped(0, 16, roll => roll < 8 ? 'low' : 'high', 'classes'), error => {
    assert.ok(error instanceof NeedRandom);
    assert.deepEqual(error.alternatives.map(option => option.decision.value), [0, 8]);
    const total = error.alternatives.reduce((sum, option) => sum + option.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-15);
    return true;
  });
});

test('fractional secondary chance matches native random(100) semantics', () => {
  const move = Dex.moves.get('flamethrower');
  const originalChance = move.secondaries[0].chance;
  move.secondaries[0].chance = 12.5;
  try {
    const battle = attackBattle('Flamethrower');
    const snapshot = snapshotBattle(battle);
    const p1 = {command: 'move 1'};
    const p2 = {command: 'move 1'};
    const native = enumerateNative(snapshot, p1, p2);
    const optimized = enumerateTurn(snapshot, p1, p2);
    assertSameDistribution(native, optimized);
    const burnedMass = optimized.outcomes
      .filter(({snapshot: next}) => next && next.sides[1].pokemon[0].status === 'brn')
      .reduce((sum, outcome) => sum + outcome.probability, 0);
    assert.ok(Math.abs(burnedMass - 0.13) < 2e-10, `${burnedMass}`);
    assert.ok(optimized.simulatorRuns < native.simulatorRuns);
  } finally {
    move.secondaries[0].chance = originalChance;
  }
});

test('secondary aggregation bypasses forceRandomChance like native random(100)', () => {
  const nativeBattle = attackBattle('Flamethrower');
  const nativeMove = nativeBattle.dex.getActiveMove('flamethrower');
  (nativeBattle as Mutable<Battle>).forceRandomChance = true;
  nativeBattle.prng = new BranchingPRNG() as unknown as PRNG;
  assert.throws(() => nativeBattle.actions.secondaries(
    [nativeBattle.p2.active[0]], nativeBattle.p1.active[0],
    nativeMove, nativeMove, false
  ), error => error instanceof NeedRandom && error.alternatives.length === 100);

  const optimizedBattle = attackBattle('Flamethrower');
  const optimizedMove = optimizedBattle.dex.getActiveMove('flamethrower');
  (optimizedBattle as Mutable<Battle>).forceRandomChance = true;
  optimizedBattle.prng = new BranchingPRNG() as unknown as PRNG;
  installSimulatorOptimizations(optimizedBattle);
  assert.throws(() => optimizedBattle.actions.secondaries(
    [optimizedBattle.p2.active[0]], optimizedBattle.p1.active[0],
    optimizedMove, optimizedMove, false
  ), error => {
    assert.ok(error instanceof NeedRandom);
    assert.equal(error.alternatives.length, 2);
    assert.ok(Math.abs(error.alternatives[0].probability - 0.1) < 2e-10);
    return true;
  });
});

test('self drops and multi-hit secondaries preserve native distributions', () => {
  const selfBattle = attackBattle('Overheat');
  const selfSnapshot = snapshotBattle(selfBattle);
  const nativeSelf = enumerateNative(selfSnapshot, {command: 'move 1'}, {command: 'move 1'});
  const optimizedSelf = enumerateTurn(selfSnapshot, {command: 'move 1'}, {command: 'move 1'});
  assertSameDistribution(nativeSelf, optimizedSelf);
  assert.ok(optimizedSelf.simulatorRuns < nativeSelf.simulatorRuns);

  const multiBattle = attackBattle('Double Iron Bash');
  // Keep the native differential finite: the first hit always ends the turn,
  // while still exercising the multi-hit move's first-hit effect path.
  setHP(multiBattle, 'p2', 1);
  refreshMoveRequest(multiBattle);
  const multiSnapshot = snapshotBattle(multiBattle);
  const nativeMulti = enumerateNative(multiSnapshot, {command: 'move 1'}, {command: 'move 1'});
  const optimizedMulti = enumerateTurn(multiSnapshot, {command: 'move 1'}, {command: 'move 1'});
  assertSameDistribution(nativeMulti, optimizedMulti);
  assert.ok(optimizedMulti.simulatorRuns < nativeMulti.simulatorRuns);
});

test('two-hit Double Kick preserves the complete native distribution', () => {
  const battle = attackBattle('Double Kick');
  const snapshot = snapshotBattle(battle);
  const native = enumerateNative(snapshot, {command: 'move 1'}, {command: 'move 1'});
  const optimized = enumerateTurn(snapshot, {command: 'move 1'}, {command: 'move 1'});
  assertSameDistribution(native, optimized);
  assert.ok(optimized.simulatorRuns < native.simulatorRuns);
});

test('custom truncation keeps native randomizer behavior', () => {
  const battle = attackBattle('Flamethrower');
  const native = battle.randomizer;
  battle.trunc = value => Math.trunc(value);
  assert.equal(installSimulatorOptimizations(battle), true);
  assert.equal(battle.randomizer, native);
});

test('unsupported action overrides fall back to native methods', () => {
  const battle = attackBattle('Flamethrower');
  const original = battle.actions.secondaries;
  battle.actions.secondaries = function customSecondaries() {};
  assert.equal(installSimulatorOptimizations(battle), true);
  assert.equal(battle.actions.secondaries.name, 'customSecondaries');
  assert.notEqual(original, battle.actions.secondaries);
});

test('type callbacks and action overrides preserve exact fallback behavior', () => {
  const battle = attackBattle('Tackle');
  const move = battle.dex.getActiveMove('tackle');
  const originalEffectiveness = move.onEffectiveness;
  move.onEffectiveness = () => 0;
  try {
    const snapshot = snapshotBattle(battle);
    const p1 = {command: 'move 1'};
    const p2 = {command: 'move 1'};
    const native = enumerateNative(snapshot, p1, p2);
    const optimized = enumerateTurn(snapshot, p1, p2);
    assertSameDistribution(native, optimized);

    const overrideBattle = attackBattle('Tackle');
    const nativeGetDamage = overrideBattle.actions.getDamage;
    overrideBattle.actions.getDamage = function customGetDamage(...args) {
      return nativeGetDamage.apply(this, args);
    };
    installSimulatorOptimizations(overrideBattle);
    assert.equal(overrideBattle.actions.getDamage.name, 'customGetDamage');
  } finally {
    if (originalEffectiveness === undefined) delete move.onEffectiveness;
    else move.onEffectiveness = originalEffectiveness;
  }
});

function compareDamage(move, targetOptions: Partial<PokemonSet> = {}, hp = 1) {
  const battle = createBattle(
    {species: 'Mew', moves: [move]},
    {species: targetOptions.species || 'Snorlax', ...targetOptions, moves: ['Splash']}
  );
  setHP(battle, 'p2', hp);
  refreshMoveRequest(battle);
  const snapshot = snapshotBattle(battle);
  const p1 = {command: 'move 1'};
  const p2 = {command: 'move 1'};
  const native = enumerateNative(snapshot, p1, p2);
  const optimized = enumerateTurn(snapshot, p1, p2);
  assertSameDistribution(native, optimized);
  return {native, optimized};
}

function compareLowHP(move, targetOptions: Partial<PokemonSet> = {}) {
  return compareDamage(move, targetOptions, 1);
}

test('HP saturation preserves native damage, recoil, and drain outcomes', () => {
  for (const move of ['Tackle', 'Double Edge', 'Giga Drain']) {
    const {native, optimized} = compareLowHP(move);
    assert.ok(optimized.simulatorRuns < native.simulatorRuns, move);
  }
});

test('damage handlers disable HP saturation for Sturdy and Focus Sash', () => {
  for (const targetOptions of [
    {species: 'Geodude', ability: 'Sturdy'},
    {species: 'Snorlax', item: 'Focus Sash'},
  ]) {
    const {native, optimized} = compareLowHP('Tackle', targetOptions);
    assert.ok(optimized.simulatorRuns <= native.simulatorRuns);
  }
});

test('Substitute and multi-hit transitions remain exact at low HP', () => {
  const multi = compareLowHP('Double Kick');
  assert.ok(multi.optimized.simulatorRuns < multi.native.simulatorRuns);

  const substituteBattle = createBattle(
    {species: 'Mew', moves: ['Tackle']},
    {species: 'Snorlax', moves: ['Splash']}
  );
  const target = substituteBattle.p2.active[0];
  target.addVolatile('substitute', target, substituteBattle.dex.getActiveMove('Substitute'));
  setHP(substituteBattle, 'p2', 1);
  refreshMoveRequest(substituteBattle);
  const snapshot = snapshotBattle(substituteBattle);
  const p1 = {command: 'move 1'};
  const p2 = {command: 'move 1'};
  const native = enumerateNative(snapshot, p1, p2);
  const optimized = enumerateTurn(snapshot, p1, p2);
  assertSameDistribution(native, optimized);
  assert.ok(optimized.simulatorRuns <= native.simulatorRuns);
});

test('low HP secondary outcomes match native enumeration', () => {
  const {native, optimized} = compareLowHP('Flamethrower');
  assertSameDistribution(native, optimized);
  assert.ok(optimized.simulatorRuns < native.simulatorRuns);
});

test('post-tail saturation preserves resisted and threshold-crossing damage', () => {
  const resisted = compareDamage('Tackle', {species: 'Rhyhorn', ability: 'Rock Head'}, 5);
  assert.ok(resisted.optimized.simulatorRuns < resisted.native.simulatorRuns);

  const crossing = compareDamage('Tackle', {species: 'Rhyhorn', ability: 'Rock Head'}, 20);
  assert.ok(crossing.optimized.simulatorRuns < crossing.native.simulatorRuns);
  assert.ok(crossing.optimized.outcomes.length > 1);
});

function contactBattleWithReserve(defense: Partial<PokemonSet> = {}, attacker: Partial<PokemonSet> = {}) {
  const battle = new Battle({
    formatid: toID('gen9customgame'), seed: '1,2,3,4',
    p1: {name: 'P1', team: [{species: 'Mew', ...attacker, moves: ['Tackle']}] as PokemonSet[]},
    p2: {name: 'P2', team: [
      {species: 'Garchomp', ...defense, moves: ['Splash']},
      {species: 'Snorlax', moves: ['Splash']},
    ] as PokemonSet[]},
  });
  battle.makeChoices('team 1', 'team 12');
  setHP(battle, 'p2', 1);
  refreshMoveRequest(battle);
  return battle;
}

test('saturated contact damage preserves retaliation and complete surviving team state', () => {
  for (const defense of [
    {ability: 'Rough Skin'},
    {item: 'Rocky Helmet'},
    {ability: 'Rough Skin', item: 'Rocky Helmet'},
  ]) {
    const battle = contactBattleWithReserve(defense);
    const snapshot = snapshotBattle(battle);
    const native = enumerateNative(snapshot, {command: 'move 1'}, {command: 'move 1'});
    const optimized = enumerateTurn(snapshot, {command: 'move 1'}, {command: 'move 1'});
    assertSameDistribution(native, optimized);
    assert.ok(optimized.outcomes.every(outcome => outcome.snapshot));
    assert.ok(optimized.outcomes.every(outcome =>
      outcome.snapshot.sides[0].pokemon[0].hp < snapshot.sides[0].pokemon[0].hp));
    assert.ok(optimized.simulatorRuns < native.simulatorRuns);
  }
});

test('custom raw damage observers retain their complete native distribution', () => {
  const move = Dex.moves.get('tackle') as Mutable<ReturnType<typeof Dex.moves.get>>;
  const original = move.onDamage;
  move.onDamage = function(damage, target, source) {
    source.hp = damage + 100;
  };
  try {
    const snapshot = snapshotBattle(contactBattleWithReserve({ability: 'Rough Skin'}));
    const native = enumerateNative(snapshot, {command: 'move 1'}, {command: 'move 1'});
    const optimized = enumerateTurn(snapshot, {command: 'move 1'}, {command: 'move 1'});
    assertSameDistribution(native, optimized);
    assert.ok(optimized.outcomes.length > 1);
  } finally {
    if (original === undefined) delete move.onDamage;
    else move.onDamage = original;
  }
});

test('custom spread-hit wrappers retain native damage randomization', () => {
  const battle = contactBattleWithReserve({ability: 'Rough Skin'});
  const native = battle.actions.spreadMoveHit;
  const randomizer = battle.randomizer;
  battle.actions.spreadMoveHit = function(...args) {
    return native.apply(this, args);
  };
  installSimulatorOptimizations(battle);
  assert.equal(battle.randomizer, randomizer);
});

test('weather damage adjustment preserves the complete nonterminal roll distribution', () => {
  const battle = attackBattle('Water Gun');
  battle.field.setWeather('sunnyday', battle.p1.active[0]);
  const snapshot = snapshotBattle(battle);
  const native = enumerateNative(snapshot, {command: 'move 1'}, {command: 'move 1'});
  const optimized = enumerateTurn(snapshot, {command: 'move 1'}, {command: 'move 1'});
  assertSameDistribution(native, optimized);
  assert.ok(optimized.outcomes.every(outcome => outcome.snapshot));
  assert.ok(optimized.simulatorRuns < native.simulatorRuns);
});

test('Life Orb final rounding and suppression preserve complete native distributions', () => {
  for (const configuration of ['active', 'klutz', 'magicroom', 'reflect']) {
    for (const hp of [1, 30, 100]) {
      const battle = contactBattleWithReserve({}, {
        item: 'Life Orb', ability: configuration === 'klutz' ? 'Klutz' : 'Synchronize',
      });
      setHP(battle, 'p2', hp);
      if (configuration === 'magicroom') {
        battle.field.addPseudoWeather('magicroom', battle.p1.active[0]);
      }
      if (configuration === 'reflect') {
        battle.p2.addSideCondition('reflect', battle.p2.active[0]);
      }
      refreshMoveRequest(battle);
      const snapshot = snapshotBattle(battle);
      const native = enumerateNative(snapshot, {command: 'move 1'}, {command: 'move 1'});
      const optimized = enumerateTurn(snapshot, {command: 'move 1'}, {command: 'move 1'});
      assertSameDistribution(native, optimized);
      assert.ok(optimized.outcomes.every(outcome => outcome.snapshot));
      if (hp === 1 && configuration !== 'reflect') {
        assert.ok(optimized.simulatorRuns < native.simulatorRuns);
      }
    }
  }
});

test('custom final damage callbacks preserve their raw damage observations', () => {
  const item = Dex.items.get('lifeorb') as ModdedItemDataTable[keyof ModdedItemDataTable];
  const original = item.onModifyDamage;
  item.onModifyDamage = function(damage, source) {
    source.hp = damage + 100;
    return this.chainModify([5324, 4096]);
  };
  try {
    const snapshot = snapshotBattle(contactBattleWithReserve({}, {item: 'Life Orb'}));
    const native = enumerateNative(snapshot, {command: 'move 1'}, {command: 'move 1'});
    const optimized = enumerateTurn(snapshot, {command: 'move 1'}, {command: 'move 1'});
    assertSameDistribution(native, optimized);
    assert.ok(optimized.outcomes.length > 1);
  } finally {
    item.onModifyDamage = original;
  }
});
