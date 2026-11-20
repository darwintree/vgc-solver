import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {championsCases, championsConfigurations, createChampionsBattle} from '../src/champions-cases';

test('top-ten sweep covers distinct pairs and independent HP combinations exactly once', () => {
  const cases = championsCases();
  assert.equal(championsConfigurations.length, 10);
  assert.equal(cases.length, 405);
  assert.equal(new Set(cases.map(c => c.id)).size, 405);
  for (const c of cases) assert.ok(c.p1.rank < c.p2.rank);
  const pairs = new Map<string, Set<string>>();
  for (const c of cases) {
    const key = `${c.p1.id}/${c.p2.id}`;
    if (!pairs.has(key)) pairs.set(key, new Set());
    pairs.get(key)!.add(`${c.hp1}/${c.hp2}`);
  }
  assert.equal(pairs.size, 45);
  for (const combinations of pairs.values()) assert.equal(combinations.size, 9);
});

test('playable fixtures retain source configuration, equivalent stats, HP and native maximum PP', () => {
  const playable = championsCases().filter(c => !c.skipReasons.length);
  assert.equal(playable.length, 252);
  for (const c of playable) {
    const battle = createChampionsBattle(c);
    const isChampionsMod = battle.dex.currentMod === 'champions';
    for (const [side, config, percent] of [[battle.p1, c.p1, c.hp1], [battle.p2, c.p2, c.hp2]]) {
      const pokemon = side.active[0];
      assert.equal(pokemon.hp, Math.floor(pokemon.maxhp * percent / 100));
      assert.equal(pokemon.set.item, config.set.item);
      assert.equal(pokemon.set.nature, config.set.nature);
      assert.equal(pokemon.ability, battle.dex.abilities.get(config.set.ability).id);
      assert.equal(pokemon.moveSlots.length, 4);
      for (const [index, slot] of pokemon.moveSlots.entries()) {
        const move = battle.dex.moves.get(config.set.moves[index]);
        assert.equal(slot.id, move.id);
        assert.equal(slot.pp, slot.maxpp);
        if (isChampionsMod) {
          assert.ok(slot.maxpp >= move.pp && slot.maxpp <= Math.floor(move.pp * 8 / 5));
        } else {
          assert.equal(slot.maxpp, move.noPPBoosts ? move.pp : Math.floor(move.pp * 8 / 5));
        }
      }
      const fields = {hp: 'hp_points', atk: 'attack_points', def: 'defense_points',
        spa: 'sp_atk_points', spd: 'sp_def_points', spe: 'speed_points'};
      const points = config.data.rows.find(r => r.category === 'stat_points' && r.rank === 1);
      for (const [stat, field] of Object.entries(fields)) {
        const base = battle.dex.species.get(config.species).baseStats[stat];
        const beforeNature = Math.floor((2 * base + 31 + Math.floor(config.set.evs[stat] / 4)) / 2);
        assert.equal(beforeNature - Math.floor((2 * base + 31) / 2), Number(points[field]));
      }
    }
    battle.destroy();
  }
});

test('incomplete source configurations have explicit skips while Mega fixtures are playable', () => {
  for (const id of ['meowscarada', 'hippowdon']) {
    assert.ok(championsConfigurations.find(c => c.id === id).reasons.some(r => r.includes('Missing move')));
  }
  for (const id of ['gyarados', 'delphox', 'dragonite', 'metagross']) {
    assert.deepEqual(championsConfigurations.find(c => c.id === id).reasons, []);
  }
  for (const c of championsCases().filter(c => c.skipReasons.length)) {
    assert.throws(() => createChampionsBattle(c));
  }
});
