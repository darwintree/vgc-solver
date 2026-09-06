'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {Battle} = require('@pkmn/sim');
const {createBattle} = require('../src/showdown-adapter');
const {installEmptyEventOptimization} = require('../src/empty-events');

function simpleBattle(left = 'Mew', right = 'Snorlax') {
  return createBattle(
    {species: left, level: 50, moves: ['Splash']},
    {species: right, level: 50, moves: ['Splash']}
  );
}

test('empty events skip speed-tie randomization on one battle only', () => {
  const battle = simpleBattle('Mew', 'Mew');
  const prototypeEachEvent = Battle.prototype.eachEvent;
  const seedBefore = battle.prng.getSeed();

  assert.equal(installEmptyEventOptimization(battle), true);
  battle.eachEvent('Update');
  battle.eachEvent('Weather');

  assert.notEqual(battle.eachEvent, prototypeEachEvent);
  assert.equal(Battle.prototype.eachEvent, prototypeEachEvent);
  assert.equal(battle.prng.getSeed(), seedBefore);
  assert.equal(installEmptyEventOptimization(battle), false);
});

test('a real handler preserves native speed order', () => {
  const battle = simpleBattle();
  const order = [];
  battle.onEvent('Update', battle.format, pokemon => order.push(pokemon.side.id));
  assert.equal(installEmptyEventOptimization(battle), true);

  battle.eachEvent('Update');

  assert.deepEqual(order, ['p1', 'p2']);
});

test('Weather still performs its required recursive Update event', () => {
  const battle = simpleBattle();
  const updates = [];
  battle.onEvent('Update', battle.format, pokemon => updates.push(pokemon.side.id));
  assert.equal(installEmptyEventOptimization(battle), true);

  battle.eachEvent('Weather');

  assert.deepEqual(updates, ['p1', 'p2']);
});

test('Weather handlers run before the recursive Update pass', () => {
  const battle = simpleBattle();
  const calls = [];
  battle.onEvent('Weather', battle.format, pokemon => calls.push(`weather:${pokemon.side.id}`));
  battle.onEvent('Update', battle.format, pokemon => calls.push(`update:${pokemon.side.id}`));
  assert.equal(installEmptyEventOptimization(battle), true);

  battle.eachEvent('Weather');

  assert.deepEqual(calls, ['weather:p1', 'weather:p2', 'update:p1', 'update:p2']);
});

test('stack limit and overridden native methods fall back safely', () => {
  const stackLimited = simpleBattle();
  assert.equal(installEmptyEventOptimization(stackLimited), true);
  stackLimited.eventDepth = 8;
  assert.throws(() => stackLimited.eachEvent('Update'), /Stack overflow/);

  const overridden = simpleBattle();
  overridden.findEventHandlers = overridden.findEventHandlers.bind(overridden);
  assert.equal(installEmptyEventOptimization(overridden), false);

  const runOverridden = simpleBattle();
  assert.equal(installEmptyEventOptimization(runOverridden), true);
  let runCalls = 0;
  runOverridden.runEvent = () => runCalls++;
  runOverridden.eachEvent('Update');
  assert.equal(runCalls, 2);

  const sortOverridden = simpleBattle();
  assert.equal(installEmptyEventOptimization(sortOverridden), true);
  let sortCalls = 0;
  sortOverridden.speedSort = () => sortCalls++;
  sortOverridden.eachEvent('Update');
  // one call sorts actives and one call comes from each runEvent invocation
  assert.equal(sortCalls, 3);
});
