'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {Battle, Dex} = require('@pkmn/sim');
const {
  buildStockProfile,
  compareStockProfile,
} = require('../src/stock-rule-profile');

const profile = buildStockProfile({cacheKeys: {
  // These are lazily materialized by normal Battle setup rather than raw
  // base tables, so a worker that wants to share this fixture pre-covers them.
  conditions: ['trickroom', 'mew'],
  formats: ['gen9customgame'],
}});
assert.equal(profile.supported, true);

function clearRuntimeCaches() {
  for (const [data, cacheName] of [
    [Dex.abilities, 'abilityCache'], [Dex.items, 'itemCache'],
    [Dex.moves, 'moveCache'], [Dex.conditions, 'conditionCache'],
    [Dex.species, 'speciesCache'], [Dex.formats, 'rulesetCache'],
  ]) data[cacheName]?.clear?.();
}

function startBattle(p1, p2) {
  const battle = new Battle({
    formatid: 'gen9customgame', debug: true, strictChoices: true,
    seed: [1, 2, 3, 4], p1: {name: 'P1', team: [p1]}, p2: {name: 'P2', team: [p2]},
  });
  if (battle.requestState === 'teampreview') battle.makeChoices('team 1', 'team 1');
  return battle;
}

function runPriorityBattle() {
  const battle = startBattle(
    {species: 'Scizor', level: 50, ability: 'Swarm', nature: 'Serious', moves: ['Quick Attack']},
    {species: 'Blissey', level: 50, ability: 'Natural Cure', nature: 'Serious', moves: ['Tackle']}
  );
  battle.p1.active[0].hp = 1;
  battle.p2.active[0].hp = 1;
  battle.makeChoices('move 1', 'move 1');
  return battle.winner === 'P1' ? 1 : -1;
}

test('an untouched parent Dex matches the independent worker stock profile', () => {
  assert.deepEqual(compareStockProfile(Dex, profile), {ok: true, reasons: []});
});

test('a stock format numeric mutation is detected before battle setup', () => {
  const format = Dex.formats.get('gen9customgame');
  const original = format.playerCount;
  format.playerCount = 99;
  try {
    const verdict = compareStockProfile(Dex, profile);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.includes('cache:formats'));
  } finally {
    format.playerCount = original;
    clearRuntimeCaches();
  }
  assert.deepEqual(compareStockProfile(Dex, profile), {ok: true, reasons: []});
});

test('a constructed numeric mutation disables stock sharing and changes trivialPriorityKO', () => {
  const baseline = runPriorityBattle();
  assert.equal(baseline, 1);

  const move = Dex.moves.get('quickattack');
  const original = move.basePower;
  move.basePower = 0;
  try {
    assert.equal(compareStockProfile(Dex, profile).ok, false);
    assert.ok(compareStockProfile(Dex, profile).reasons.includes('cache:moves'));
    // This is the concrete unsoundness the guard prevents: sharing stock
    // rules would predict +1 while the parent now natively produces -1.
    const mutated = runPriorityBattle();
    assert.equal(mutated, -1);
  } finally {
    move.basePower = original;
    clearRuntimeCaches();
  }
  assert.deepEqual(compareStockProfile(Dex, profile), {ok: true, reasons: []});
});

test('a known native function copied into another raw definition is rejected', () => {
  const tackle = Dex.moves.get('tackle');
  const afterYou = Dex.moves.get('afteryou');
  const original = tackle.onHit;
  assert.equal(typeof original, 'undefined');
  assert.equal(typeof afterYou.onHit, 'function');
  tackle.onHit = afterYou.onHit;
  try {
    const verdict = compareStockProfile(Dex, profile);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some(reason => reason === 'cache:moves' || reason === 'all:moves'));
  } finally {
    delete tackle.onHit;
    clearRuntimeCaches();
  }
  assert.deepEqual(compareStockProfile(Dex, profile), {ok: true, reasons: []});
});

test('species numeric mutations, Map replacements, and allCache order are guarded', () => {
  const species = Dex.species.get('mew');
  const originalHP = species.baseStats.hp;
  species.baseStats.hp = 0;
  try {
    assert.equal(compareStockProfile(Dex, profile).ok, false);
  } finally {
    species.baseStats.hp = originalHP;
  }

  const moveCache = Dex.moves.moveCache;
  const originalMove = Dex.moves.get('tackle');
  const replacement = Object.assign(Object.create(Object.getPrototypeOf(originalMove)), originalMove, {basePower: 0});
  moveCache.set('tackle', replacement);
  try {
    assert.equal(compareStockProfile(Dex, profile).ok, false);
  } finally {
    moveCache.set('tackle', originalMove);
  }

  const all = Dex.moves.allCache;
  const first = all[0];
  const second = all[1];
  [all[0], all[1]] = [second, first];
  try {
    assert.equal(compareStockProfile(Dex, profile).ok, false);
  } finally {
    [all[0], all[1]] = [first, second];
  }
  const hiddenPowerIndices = all.reduce((indices, move, index) => {
    if (move.id === 'hiddenpower') indices.push(index);
    return indices;
  }, []);
  assert.ok(hiddenPowerIndices.length >= 2);
  const hiddenA = hiddenPowerIndices[0];
  const hiddenB = hiddenPowerIndices[1];
  [all[hiddenA], all[hiddenB]] = [all[hiddenB], all[hiddenA]];
  try {
    assert.equal(compareStockProfile(Dex, profile).ok, false);
  } finally {
    [all[hiddenA], all[hiddenB]] = [all[hiddenB], all[hiddenA]];
  }
  clearRuntimeCaches();
  assert.deepEqual(compareStockProfile(Dex, profile), {ok: true, reasons: []});
});

function runOneHPBattle() {
  const battle = startBattle(
    {species: 'Mew', moves: ['Tackle'], ability: 'Swarm'},
    {species: 'Blissey', moves: ['Splash'], ability: 'Soundproof'}
  );
  battle.p1.active[0].hp = 1;
  const target = battle.p2.active[0];
  target.maxhp = 1;
  target.hp = 1;
  battle.makeChoices('move 1', 'move 1');
  return {battle, target};
}

test('a copied known native callback disables sharing and native fallback observes it', () => {
  const soundproof = Dex.abilities.get('soundproof');
  const sturdy = Dex.abilities.get('sturdy');
  const original = soundproof.onDamage;
  const baseline = runOneHPBattle();
  assert.equal(baseline.target.hp, 0);
  assert.equal(baseline.target.fainted, true);
  // The battle's compiled custom Format ruleTable is runtime state. The
  // worker profile captured the same format before Battle setup, so this
  // exact format comparison conservatively chooses synchronous fallback.
  const formatVerdict = compareStockProfile(Dex, profile, {battle: baseline.battle});
  assert.equal(formatVerdict.ok, false);
  assert.ok(formatVerdict.reasons.length > 0);
  const initializedProfile = buildStockProfile({cacheKeys: {
    conditions: ['trickroom', 'mew'], formats: ['gen9customgame'],
  }, runtimeFormats: [baseline.battle.format]});
  assert.equal(compareStockProfile(Dex, initializedProfile, {battle: baseline.battle}).ok, true);
  const rules = baseline.battle.format.ruleTable;
  const oldTeamSize = rules.valueRules.get('maxteamsize');
  rules.valueRules.set('maxteamsize', '99');
  try {
    const changedFormat = compareStockProfile(Dex, initializedProfile, {battle: baseline.battle});
    assert.equal(changedFormat.ok, false);
    assert.ok(changedFormat.reasons.includes('format:runtime') || changedFormat.reasons.includes('cache:formats'));
  } finally {
    rules.valueRules.set('maxteamsize', oldTeamSize);
  }

  soundproof.onDamage = sturdy.onDamage;
  try {
    assert.equal(compareStockProfile(Dex, profile).ok, false);
    assert.ok(compareStockProfile(Dex, profile).reasons.some(reason =>
      reason === 'cache:abilities' || reason === 'all:abilities'
    ));
    const native = runOneHPBattle();
    // Sturdy's copied onDamage callback actually fires for hp=maxhp=1.
    // A worker that shared stock Soundproof would miss this and be wrong.
    assert.equal(native.target.hp, 1);
    assert.equal(native.target.fainted, false);
  } finally {
    if (original === undefined) delete soundproof.onDamage;
    else soundproof.onDamage = original;
    clearRuntimeCaches();
  }
  assert.deepEqual(compareStockProfile(Dex, profile), {ok: true, reasons: []});
});
