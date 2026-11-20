import type {Battle} from '@pkmn/sim';
import {toID} from '@pkmn/sim';
import {compileAbilitySpec} from './effects/abilities';
import {compileItemSpec} from './effects/items';
import {compileMoveSpec, isMoveSupported} from './effects/moves';
import {detectRulesetFromBattle} from './ruleset';
import {
  FeatureBit,
  type EngineSupportReport,
  type GameType,
  type StaticBattleContext,
  type StaticMegaFormeData,
  type StaticPokemonData,
  type StaticSideData,
} from './types';

const SUPPORTED_STATUSES = new Set(['', 'par', 'brn', 'psn', 'tox', 'slp', 'frz']);
const SUPPORTED_VOLATILES = new Set([
  'stall', 'encore', 'mustrecharge', 'substitute', 'taunt', 'throatchop', 'choicelock',
  'disable', 'torment', 'leechseed', 'yawn', 'curse', 'perishsong', 'trapped', 'partiallytrapped',
  'aquaring', 'ingrain', 'smackdown', 'focusenergy', 'dragoncheer', 'charge', 'glaiverush',
  'syrupbomb', 'destinybond', 'noretreat', 'flashfire', 'unburden', 'twoTurnMove',
]);
const SUPPORTED_WEATHERS = new Set(['', 'sunnyday', 'raindance', 'sandstorm', 'snowscape', 'snow', 'hail']);
const SUPPORTED_TERRAINS = new Set(['', 'electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain']);
const SUPPORTED_SIDE_CONDS = new Set([
  'stealthrock', 'spikes', 'toxicspikes', 'stickyweb',
  'tailwind', 'reflect', 'lightscreen', 'auroraveil', 'safeguard',
]);
const SUPPORTED_PSEUDO_WEATHERS = new Set(['trickroom', 'gravity', 'fairylock', 'magicroom', 'wonderroom']);

function buildTypeChart(dex: Battle['dex']): Map<string, Map<string, number>> {
  const chart = new Map<string, Map<string, number>>();
  const allTypes = dex.types.all().map(t => t.name);
  for (const atkType of allTypes) {
    const row = new Map<string, number>();
    for (const defType of allTypes) {
      const defInfo = dex.types.get(defType);
      const code = defInfo.damageTaken[atkType];
      // Showdown damageTaken: 0 = neutral, 1 = super-effective (+1), 2 = resist (-1), 3 = immune (-99)
      if (code === 1) row.set(defType, 1);
      else if (code === 2) row.set(defType, -1);
      else if (code === 3) row.set(defType, -99);
      else row.set(defType, 0);
    }
    chart.set(atkType, row);
  }
  return chart;
}

/**
 * Audit whether a `@pkmn/sim` Battle (either Champions mod or base Gen 9) is 100%
 * covered by the compact engine's compiled item, ability, and move registries.
 */
export function canRunInEngine(battle: Battle): EngineSupportReport {
  const reasons: string[] = [];
  if (!battle) return {supported: false, reasons: ['Missing battle instance']};
  if (battle.gen !== 9) reasons.push(`Unsupported gen: ${battle.gen}`);
  if (battle.gameType !== 'singles' && battle.gameType !== 'doubles') {
    reasons.push(`Unsupported gameType: ${battle.gameType}`);
  }
  const mod = battle.dex?.currentMod;
  if (mod !== 'base' && mod !== 'champions' && mod !== 'championsregmb') {
    reasons.push(`Unsupported dex mod: ${mod}`);
  }
  if (!SUPPORTED_WEATHERS.has(toID(battle.field.weather || ''))) {
    reasons.push(`Unsupported weather: ${battle.field.weather}`);
  }
  if (!SUPPORTED_TERRAINS.has(toID(battle.field.terrain || ''))) {
    reasons.push(`Unsupported terrain: ${battle.field.terrain}`);
  }
  for (const pw of Object.keys(battle.field.pseudoWeather || {})) {
    if (!SUPPORTED_PSEUDO_WEATHERS.has(pw)) reasons.push(`Unsupported pseudoWeather: ${pw}`);
  }

  for (const side of battle.sides) {
    for (const sc of Object.keys(side.sideConditions || {})) {
      if (!SUPPORTED_SIDE_CONDS.has(sc)) {
        reasons.push(`Unsupported sideCondition on ${side.id}: ${sc}`);
      }
    }
    for (const pokemon of side.pokemon) {
      const abSpec = compileAbilitySpec(pokemon.ability);
      if (!abSpec.supported) {
        reasons.push(`Unsupported ability on ${pokemon.name}: ${pokemon.ability}`);
      }
      const itemSpec = compileItemSpec(battle.dex, pokemon.item);
      if (!itemSpec.supported) {
        reasons.push(`Unsupported item on ${pokemon.name}: ${pokemon.item}`);
      }
      // If the Pokemon can Mega Evolve, audit its Mega ability as well!
      if (itemSpec.archetype === 'mega-stone' && itemSpec.megaSpeciesId) {
        const megaSpecies = battle.dex.species.get(itemSpec.megaSpeciesId);
        const megaAb = megaSpecies?.abilities?.[0] || '';
        if (megaAb && !compileAbilitySpec(megaAb).supported) {
          reasons.push(`Unsupported Mega ability on ${megaSpecies.name}: ${megaAb}`);
        }
      }
      const status = toID(pokemon.status);
      if (!SUPPORTED_STATUSES.has(status)) {
        reasons.push(`Unsupported status on ${pokemon.name}: ${pokemon.status}`);
      }
      for (const vol of Object.keys(pokemon.volatiles || {})) {
        if (!SUPPORTED_VOLATILES.has(vol)) {
          reasons.push(`Unsupported volatile on ${pokemon.name}: ${vol}`);
        }
      }
      if ((pokemon as any).terastallized) {
        reasons.push(`Terastallization not yet supported on ${pokemon.name}`);
      }
      for (const slot of pokemon.moveSlots) {
        const mvCheck = isMoveSupported(battle.dex, slot.id);
        if (!mvCheck.supported) {
          reasons.push(`Unsupported move on ${pokemon.name}: ${mvCheck.reason || slot.move}`);
        }
      }
    }
  }

  return {supported: reasons.length === 0, reasons};
}

export function compileContextFromBattle(battle: Battle): StaticBattleContext {
  const report = canRunInEngine(battle);
  if (!report.supported) {
    throw new Error(`Battle not supported by compact engine: ${report.reasons.join('; ')}`);
  }

  const ruleset = detectRulesetFromBattle(battle);
  const gameType: GameType = battle.gameType === 'doubles' ? 'doubles' : 'singles';
  const activeCount: 1 | 2 = gameType === 'doubles' ? 2 : 1;
  const truncBits = battle.trunc !== Math.trunc;

  let featureMask = FeatureBit.NONE;
  if (ruleset.megaEvolutionEnabled) featureMask |= FeatureBit.MEGA;

  const compileSide = (side: Battle['p1'], id: 'p1' | 'p2'): StaticSideData => {
    const team: StaticPokemonData[] = side.pokemon.map(p => {
      const baseSpecies = p.species.id === 'mimikyubusted'
        ? battle.dex.species.get('mimikyu')
        : p.baseSpecies;
      const abilitySpec = compileAbilitySpec(p.baseAbility || p.ability);
      const itemSpec = compileItemSpec(battle.dex, p.item);

      featureMask |= abilitySpec.featureBits | itemSpec.featureBits;

      // Compile Mega Evolution target forme using the battle's EXACT statModify (works for both Champions Stat Points and mainline EV/IV!)
      let megaForme: StaticMegaFormeData | null = null;
      const canMegaSpeciesName =
        (typeof p.canMegaEvo === 'string' ? p.canMegaEvo : null) ??
        (itemSpec.archetype === 'mega-stone' && itemSpec.megaSpeciesId &&
          (!itemSpec.megaEvolves || itemSpec.megaEvolves === toID(baseSpecies.id))
          ? itemSpec.megaSpeciesId
          : null);
      if (canMegaSpeciesName) {
        const ms = battle.dex.species.get(canMegaSpeciesName);
        if (ms && ms.exists) {
          const megaStats = battle.spreadModify(ms.baseStats, p.set);
          const megaAbilityName = ms.abilities[0] || '';
          const megaAbSpec = compileAbilitySpec(megaAbilityName);
          featureMask |= FeatureBit.MEGA | megaAbSpec.featureBits;
          megaForme = {
            speciesId: toID(ms.id),
            name: ms.name,
            types: [...ms.types],
            weightkg: ms.weightkg || 1,
            stats: {
              atk: megaStats.atk,
              def: megaStats.def,
              spa: megaStats.spa,
              spd: megaStats.spd,
              spe: megaStats.spe,
            },
            abilityId: megaAbSpec.id,
            abilitySpec: megaAbSpec,
          };
        }
      }

      const moves = p.moveSlots.map(slot => {
        const compiled = compileMoveSpec(battle.dex, slot.id, slot.maxpp);
        featureMask |= compiled.featureBits;
        return compiled.move;
      });

      const baseStats = p.species.isMega
        ? battle.spreadModify(baseSpecies.baseStats, p.set)
        : p.storedStats;

      return {
        speciesId: toID(baseSpecies.id),
        name: p.name,
        level: p.level,
        baseTypes: [...baseSpecies.types],
        weightkg: baseSpecies.weightkg || 1,
        maxhp: p.maxhp,
        stats: {
          atk: baseStats.atk,
          def: baseStats.def,
          spa: baseStats.spa,
          spd: baseStats.spd,
          spe: baseStats.spe,
        },
        abilityId: abilitySpec.id,
        abilitySpec,
        itemId: itemSpec.id,
        itemSpec,
        itemRemovable: itemSpec.removable,
        megaForme,
        moves,
      };
    });
    return {id, name: side.name, team};
  };

  const sides: [StaticSideData, StaticSideData] = [
    compileSide(battle.p1, 'p1'),
    compileSide(battle.p2, 'p2'),
  ];

  const {move: struggleMove} = compileMoveSpec(battle.dex, 'struggle', 1);
  struggleMove.recoil = null;
  struggleMove.type = '???';

  return {
    ruleset,
    gameType,
    activeCount,
    truncBits,
    featureMask,
    sides,
    typeChart: buildTypeChart(battle.dex),
    struggleMove,
  };
}
