'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {createBattle, snapshotBattle, enumerateTurn} = require('../src/showdown-adapter');
const {createEventPlan, hasPossibleEvent, hasNoEventHandlers} = require('../src/event-plan');

test('event plan proves empty native events and preserves callback-bearing events', {concurrency: false}, () => {
  const battle = createBattle(
    {species: 'Mew', ability: 'Water Absorb', moves: ['Splash']},
    {species: 'Mew', ability: 'Synchronize', moves: ['Splash']}
  );
  const plan = createEventPlan(battle);
  assert.ok(plan);
  assert.equal(hasPossibleEvent(plan, battle, 'DefinitelyAbsent'), false);
  assert.equal(hasNoEventHandlers(
    battle, plan, 'DefinitelyAbsent', battle.p1.active[0], battle.p2.active[0]
  ), true);
  assert.equal(hasPossibleEvent(plan, battle, 'TryHit'), true);
  assert.equal(hasNoEventHandlers(
    battle, plan, 'TryHit', battle.p1.active[0], battle.p2.active[0]
  ), false);
});

test('unknown dynamic effect and custom event use native fallback', {concurrency: false}, () => {
  const battle = createBattle(
    {species: 'Mew', moves: ['Splash']},
    {species: 'Mew', moves: ['Splash']}
  );
  const plan = createEventPlan(battle);
  assert.ok(plan);
  battle.p1.active[0].addVolatile('substitute');
  assert.equal(hasPossibleEvent(plan, battle, 'DefinitelyAbsent'), false);
  battle.onEvent('DefinitelyAbsent', battle.format, () => {});
  assert.equal(hasPossibleEvent(plan, battle, 'DefinitelyAbsent'), null);

  const transition = enumerateTurn(
    snapshotBattle(createBattle(
      {species: 'Mew', moves: ['Splash']},
      {species: 'Mew', moves: ['Splash']}
    )),
    {command: 'move 1'}, {command: 'move 1'}, {eventPlan: plan}
  );
  assert.ok(transition.simulatorRuns > 0);
});

test('species and ability replacements use the audited base definitions', {concurrency: false}, () => {
  const battle = createBattle(
    {species: 'Mew', ability: 'Pressure', moves: ['Splash']},
    {species: 'Mew', ability: 'Pressure', moves: ['Splash']}
  );
  const plan = createEventPlan(battle);
  assert.ok(plan);
  battle.p1.active[0].baseSpecies = battle.dex.species.getByID('Ditto');
  battle.p1.active[0].ability = 'levitate';
  assert.equal(hasPossibleEvent(plan, battle, 'DefinitelyAbsent'), false);
});

test('rebuilds callback layout after a native function is copied to another effect', {concurrency: false}, () => {
  const battle = createBattle(
    {species: 'Mew', ability: 'Soundproof', moves: ['Splash']},
    {species: 'Mew', moves: ['Splash']}
  );
  const soundproof = battle.dex.abilities.getByID('soundproof');
  const sturdy = battle.dex.abilities.getByID('sturdy');
  const original = soundproof.onDamage;
  const firstPlan = createEventPlan(battle);
  assert.ok(firstPlan);
  assert.equal(hasPossibleEvent(firstPlan, battle, 'Damage'), false);
  soundproof.onDamage = sturdy.onDamage;
  try {
    // The copied callback remains in the native function whitelist, so the
    // broad audit accepts it even though the effect's callback layout changed.
    assert.equal(hasPossibleEvent(firstPlan, battle, 'Damage'), false);
    assert.equal(battle.findEventHandlers(
      battle.p1.active[0], 'Damage', battle.p2.active[0]
    ).length, 1);
    const secondPlan = createEventPlan(battle);
    assert.ok(secondPlan);
    assert.notEqual(secondPlan, firstPlan);
    assert.equal(hasPossibleEvent(secondPlan, battle, 'Damage'), true);
  } finally {
    if (original === undefined) delete soundproof.onDamage;
    else soundproof.onDamage = original;
  }
});
