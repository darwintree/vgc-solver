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
  'confusion', 'attract', 'magnetrise', 'lockon', 'stockpile', 'powertrick', 'powershift',
  'imprison', 'octolock', 'uproar', 'gastroacid', 'focuspunch', 'beakblast', 'electrify', 'fling',
]);

const ALT_FORMES_BY_BASE: Record<string, readonly string[]> = {
  palafin: ['palafinhero'],
  eiscue: ['eiscuenoice'],
  minior: ['miniormeteor'],
  aegislash: ['aegislashblade'],
  castform: ['castformsunny', 'castformrainy', 'castformsnowy'],
  morpeko: ['morpekohangry'],
  cramorant: ['cramorantgulping', 'cramorantgorging'],
};

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
      if (status !== 'fnt' && !SUPPORTED_STATUSES.has(status)) {
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

  const itemSpecCache = new Map<string, import('./effects/items').CompiledItemSpec>();
  const cacheItem = (id: string, spec: import('./effects/items').CompiledItemSpec) => {
    itemSpecCache.set(id, spec);
  };
  cacheItem('', compileItemSpec(battle.dex, ''));

  const compileForme = (speciesId: string, set: any): StaticMegaFormeData | null => {
    const ms = battle.dex.species.get(speciesId);
    if (!ms || !ms.exists) return null;
    const fStats = battle.spreadModify(ms.baseStats, set);
    const fAbName = ms.abilities[0] || '';
    const fAbSpec = compileAbilitySpec(fAbName);
    return {
      speciesId: toID(ms.id),
      name: ms.name,
      types: [...ms.types],
      weightkg: ms.weightkg || 1,
      stats: {
        atk: fStats.atk,
        def: fStats.def,
        spa: fStats.spa,
        spd: fStats.spd,
        spe: fStats.spe,
      },
      abilityId: fAbSpec.id,
      abilitySpec: fAbSpec,
    };
  };

  const compileSide = (side: Battle['p1'], id: 'p1' | 'p2'): StaticSideData => {
    const team: StaticPokemonData[] = side.pokemon.map(p => {
      const baseSpecies = p.species.id === 'mimikyubusted'
        ? battle.dex.species.get('mimikyu')
        : p.baseSpecies;
      const abilitySpec = compileAbilitySpec(p.baseAbility || p.ability);
      const itemSpec = compileItemSpec(battle.dex, p.item);
      cacheItem(itemSpec.id, itemSpec);

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
        const compiled = compileForme(canMegaSpeciesName, p.set);
        if (compiled) {
          featureMask |= FeatureBit.MEGA | compiled.abilitySpec.featureBits;
          megaForme = compiled;
        }
      }

      // Precompile alt formes for form-changing species (Palafin, Eiscue, Minior, Aegislash, Castform, Morpeko, Cramorant)
      const altFormes: Record<string, StaticMegaFormeData> = {};
      const baseFamily = toID(baseSpecies.baseSpecies || baseSpecies.id);
      const altIds = ALT_FORMES_BY_BASE[baseFamily];
      if (altIds) {
        const baseCompiled = compileForme(baseSpecies.id, p.set);
        if (baseCompiled) altFormes[baseCompiled.speciesId] = baseCompiled;
        for (const aid of altIds) {
          const compiled = compileForme(aid, p.set);
          if (compiled) altFormes[compiled.speciesId] = compiled;
        }
      }

      const moves = p.moveSlots.map(slot => {
        const compiled = compileMoveSpec(battle.dex, slot.id, slot.maxpp);
        featureMask |= compiled.featureBits;
        return compiled.move;
      });

      const baseStats = (p.species.isMega || toID(p.species.id) !== toID(baseSpecies.id))
        ? battle.spreadModify(baseSpecies.baseStats, p.set)
        : p.storedStats;

      const gender: 'M' | 'F' | '' = p.gender === 'M' || p.gender === 'F' ? p.gender : '';

      return {
        speciesId: toID(baseSpecies.id),
        name: p.name,
        level: p.level,
        gender,
        baseAtk: baseSpecies.baseStats.atk || 0,
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
        altFormes,
        moves,
      };
    });
    return {id, name: side.name, team};
  };

  const sides: [StaticSideData, StaticSideData] = [
    compileSide(battle.p1, 'p1'),
    compileSide(battle.p2, 'p2'),
  ];

  // Compute exact fine-grained reader bits so unused historical fields never split equivalent states
  const allTeamMoves = (s: 0 | 1) => sides[s].team.flatMap(p => p.moves);
  const allTeamAbilities = (s: 0 | 1) =>
    sides[s].team.flatMap(p => [p.abilitySpec, ...(p.megaForme ? [p.megaForme.abilitySpec] : [])]);
  const hasTransformAny = [0, 1].some(s =>
    allTeamMoves(s as 0 | 1).some(m => m.specialKind === 'transform' || m.specialKind === 'copycat') ||
    allTeamAbilities(s as 0 | 1).some(a => a.imposter)
  );
  for (const s of [0, 1] as const) {
    const opp: 0 | 1 = s === 0 ? 1 : 0;
    const moves = allTeamMoves(s);
    const abs = allTeamAbilities(s);
    if (moves.some(m => m.specialKind === 'copycat')) {
      featureMask |= FeatureBit.FIELD_LAST_MOVE | FeatureBit.LAST_MOVE_ID;
    }
    if (moves.some(m => m.specialKind === 'instruct' || m.specialKind === 'uproar')) {
      featureMask |= FeatureBit.LAST_MOVE_ID;
    }
    if (moves.some(m => m.specialKind === 'stomping-tantrum')) {
      featureMask |= FeatureBit.LAST_MOVE_FAILED;
    }
    if (moves.some(m => m.specialKind === 'recycle') || abs.some(a => a.harvest)) {
      featureMask |= FeatureBit.LAST_ITEM;
    }
    if (moves.some(m => m.specialKind === 'belch')) {
      featureMask |= FeatureBit.ATE_BERRY;
    }
    const readsOppLastMoveIdx =
      moves.some(m => m.specialKind === 'encore' || m.specialKind === 'disable' || m.specialKind === 'spite' || m.specialKind === 'torment') ||
      abs.some(a => a.cursedBody);
    if (readsOppLastMoveIdx) {
      featureMask |= opp === 0 ? FeatureBit.SIDE0_LAST_MOVE_IDX : FeatureBit.SIDE1_LAST_MOVE_IDX;
      if (hasTransformAny) {
        featureMask |= s === 0 ? FeatureBit.SIDE0_LAST_MOVE_IDX : FeatureBit.SIDE1_LAST_MOVE_IDX;
      }
    }
  }

  // Determine whether SpA (boosts[2]) and SpD (boosts[3]) can ever be observed
  // from co-located fail-closed optimization traits on moves, abilities, and items.
  const anyGlobalBoostReader = ([0, 1] as const).some(s =>
    allTeamMoves(s).some(m => m.optTraits.readsGlobalBoosts) ||
    allTeamAbilities(s).some(a => a.optTraits.readsGlobalBoosts) ||
    sides[s].team.some(p => p.itemSpec.optTraits.readsGlobalBoosts)
  );
  const sideHasSpecialMove = (s: 0 | 1) =>
    allTeamMoves(s).some(m => m.optTraits.canBeSpecial);
  const trackSpaBoost: [boolean, boolean] = [
    anyGlobalBoostReader || sideHasSpecialMove(0),
    anyGlobalBoostReader || sideHasSpecialMove(1),
  ];
  const trackSpdBoost: [boolean, boolean] = [
    anyGlobalBoostReader || sideHasSpecialMove(1),
    anyGlobalBoostReader || sideHasSpecialMove(0),
  ];

  const {move: struggleMove} = compileMoveSpec(battle.dex, 'struggle', 1);
  struggleMove.recoil = null;
  struggleMove.type = '???';

  return {
    dex: battle.dex,
    ruleset,
    gameType,
    activeCount,
    truncBits,
    featureMask,
    trackSpaBoost,
    trackSpdBoost,
    sides,
    typeChart: buildTypeChart(battle.dex),
    itemSpecCache,
    struggleMove,
  };
}
