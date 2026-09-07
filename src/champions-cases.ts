import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Dex} from '@pkmn/sim';
import {createBattle, refreshMoveRequest, setHP} from './showdown-adapter';

const snapshot = JSON.parse(readFileSync(resolve('fixtures/champions/singles-top10.json'), 'utf8'));
const statFields = {hp: 'hp_points', atk: 'attack_points', def: 'defense_points',
  spa: 'sp_atk_points', spd: 'sp_def_points', spe: 'speed_points'};
const hpPercentages = [25, 50, 100];

function configuration(entry) {
  const reasons: string[] = [];
  function ranked(category, count) {
    const rows = entry.data.rows.filter(row => row.category === category)
      .sort((a, b) => a.rank - b.rank);
    if (rows.slice(0, count).some((row, i) => row.rank !== i + 1) || rows.length < count) {
      reasons.push(`Missing ${category} ranks 1–${count}`);
    }
    return rows.slice(0, count);
  }
  const moves = ranked('move', 4).map(row => row.name);
  const item = ranked('held_item', 1)[0]?.name;
  const ability = ranked('ability', 1)[0]?.name;
  const nature = ranked('stat_alignment', 1)[0]?.name;
  const points = ranked('stat_points', 1)[0];
  const evs = {};
  for (const [stat, field] of Object.entries(statFields)) {
    const value = Number(points?.[field]);
    if (!Number.isInteger(value) || value < 0 || value > 32) reasons.push(`Invalid ${field}`);
    // At level 50, perfect IVs: 4 EVs give the first point, then 8 per point.
    evs[stat] = value === 0 ? 0 : value * 8 - 4;
  }
  for (const [kind, names] of [
    ['species', [entry.species]], ['moves', moves], ['items', [item]],
    ['abilities', [ability]], ['natures', [nature]],
  ] as const) {
    for (const name of names) {
      if (!name || !Dex[kind].get(name).exists) reasons.push(`Unsupported ${kind}: ${name}`);
    }
  }
  if (item && Dex.items.get(item).megaStone) {
    reasons.push(`Mega evolution actions are not implemented: ${item}`);
  }
  return {...entry, reasons, set: {species: entry.species, level: 50, item, ability, nature,
    moves, evs, ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31}}};
}

const championsConfigurations = snapshot.pokemon.map(configuration);
function championsCases() {
  const cases = [];
  for (let i = 0; i < championsConfigurations.length; i++) {
    for (let j = i + 1; j < championsConfigurations.length; j++) {
      const p1 = championsConfigurations[i];
      const p2 = championsConfigurations[j];
      for (const hp1 of hpPercentages) for (const hp2 of hpPercentages) {
        cases.push({id: `${p1.id}-${hp1}-vs-${p2.id}-${hp2}`, p1, p2, hp1, hp2,
          skipReasons: [...p1.reasons.map(r => `${p1.species}: ${r}`),
            ...p2.reasons.map(r => `${p2.species}: ${r}`)]});
      }
    }
  }
  return cases;
}

function createChampionsBattle(fixture) {
  if (fixture.skipReasons.length) throw new Error(fixture.skipReasons.join('; '));
  const battle = createBattle(structuredClone(fixture.p1.set), structuredClone(fixture.p2.set));
  for (const [side, percent] of [['p1', fixture.hp1], ['p2', fixture.hp2]] as const) {
    setHP(battle, side, Math.max(1, Math.floor(battle[side].active[0].maxhp * percent / 100)));
  }
  refreshMoveRequest(battle);
  return battle;
}

export {snapshot, championsConfigurations, championsCases, createChampionsBattle};
