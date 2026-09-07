import type {ID, PokemonSet} from '@pkmn/sim';
import assert from 'node:assert/strict';
import test from 'node:test';
import {Battle} from '@pkmn/sim';
import {FIXED_SEED} from '../src/branching-prng';
import {
  createBattle,
  enumerateTurn,
  snapshotBattle,
} from '../src/showdown-adapter';
import {assertSameDistribution, enumerateNative} from './helpers/distribution';

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
        formatid: 'gen9customgame' as ID,
        debug: true,
        strictChoices: true,
        seed: FIXED_SEED,
        p1: {name: 'P1', team: [set('Mew', ['Splash']), set('Snorlax', ['Splash'])] as PokemonSet[]},
        p2: {name: 'P2', team: [set('Mew', ['Seismic Toss'])] as PokemonSet[]},
      });
      battle.makeChoices('team 12', 'team 1');
      return battle;
    },
    'switch 2', 'move 1'
  );

  compareFixture(
    () => {
      const battle = new Battle({
        formatid: 'gen9doublescustomgame' as ID,
        debug: true,
        strictChoices: true,
        seed: FIXED_SEED,
        p1: {name: 'P1', team: [set('Mew', ['Seismic Toss']), set('Alakazam', ['Splash'])] as PokemonSet[]},
        p2: {name: 'P2', team: [set('Snorlax', ['Splash']), set('Slowbro', ['Splash'], {ivs: {spe: 0}})] as PokemonSet[]},
      });
      battle.makeChoices('team 12', 'team 12');
      return battle;
    },
    'move 1 2, move 1', 'move 1, move 1'
  );
});
