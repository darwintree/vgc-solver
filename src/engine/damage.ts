import {
  activeAbilitySpec,
  activeItemSpec,
  activeSpeciesId,
  activeStats,
  activeTypes,
  activeWeightHg,
  isGrounded,
  isItemEffectActive,
} from './state';
import type {
  DynamicState,
  MoveCategory,
  StaticBattleContext,
  StaticMoveData,
  WeatherId,
} from './types';

const BOOST_TABLE = [1, 1.5, 2, 2.5, 3, 3.5, 4];
const SUPREME_OVERLORD_MODS = [4096, 4506, 4915, 5325, 5734, 6144];

export function trunc(ctx: StaticBattleContext, num: number, bits = 0): number {
  if (!ctx.truncBits) return Math.trunc(num);
  if (bits) return (num >>> 0) % (2 ** bits);
  return num >>> 0;
}

/** Exact Showdown Gen 9 / Champions Battle#modify (4096-scaled pokeRound). */
export function pokeRound(
  ctx: StaticBattleContext,
  value: number,
  numerator: number,
  denominator = 1
): number {
  const modifier = trunc(ctx, numerator * 4096 / denominator);
  return trunc(ctx, (trunc(ctx, value * modifier) + 2048 - 1) / 4096);
}

export function clampInt(num: number, min: number, max?: number): number {
  let n = Math.floor(num);
  if (n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

export function applyBoostToStat(baseStat: number, boost: number): number {
  const clamped = boost > 6 ? 6 : boost < -6 ? -6 : boost;
  if (clamped >= 0) return Math.floor(baseStat * BOOST_TABLE[clamped]);
  return Math.floor(baseStat / BOOST_TABLE[-clamped]);
}

/** Returns active weather, suppressed to '' if any active Pokemon has Cloud Nine. */
export function effectiveFieldWeather(ctx: StaticBattleContext, state: DynamicState): WeatherId {
  if (!state.field.weather) return '';
  for (const s of [0, 1] as const) {
    for (const idx of state.sides[s].active) {
      if (idx < 0) continue;
      const p = state.sides[s].pokemon[idx];
      if (!p.fainted && p.abilityActive && !p.gastroAcid && activeAbilitySpec(ctx.sides[s].team[idx], p).cloudNine) {
        return '';
      }
    }
  }
  return state.field.weather;
}

/** Speed stat before Trick Room inversion (used by Gyro Ball / Electro Ball & effectiveSpeed). */
export function rawEffectiveSpeed(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number
): number {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  const stats = activeStats(sp, p);
  const ab = activeAbilitySpec(sp, p);
  const abActive = p.abilityActive && !p.gastroAcid;
  const weather = effectiveFieldWeather(ctx, state);

  let spe = applyBoostToStat(stats.spe, p.boosts[4]);

  if (abActive) {
    if (ab.speedDoubleWeather && weather === ab.speedDoubleWeather) {
      spe = pokeRound(ctx, spe, 2);
    }
    if (ab.speedDoubleTerrain && state.field.terrain === ab.speedDoubleTerrain) {
      spe = pokeRound(ctx, spe, 2);
    }
    if (ab.unburden && p.unburdenActive && !p.itemActive) {
      spe = pokeRound(ctx, spe, 2);
    }
    if (ab.quickFeet && p.status !== '') {
      spe = pokeRound(ctx, spe, 1.5);
    }
  }

  if (isItemEffectActive(state, sp, p)) {
    const it = activeItemSpec(ctx, sp, p);
    if (it.archetype === 'choice-scarf') spe = pokeRound(ctx, spe, 1.5);
    else if (it.archetype === 'iron-ball') spe = pokeRound(ctx, spe, 0.5);
  }

  if (p.status === 'par' && !(abActive && ab.quickFeet)) {
    spe = pokeRound(ctx, spe, 0.5);
  }

  if (state.sides[sideIdx].tailwindTurns > 0) {
    spe = pokeRound(ctx, spe, 2);
  }

  return spe;
}

export function effectiveSpeed(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number
): number {
  const spe = rawEffectiveSpeed(ctx, state, sideIdx, pokeIdx);
  if (state.field.trickRoomTurns > 0) {
    if (ctx.ruleset.trickRoomNegatesSpeed) {
      return -spe;
    }
    return trunc(ctx, 10000 - spe, 13);
  }
  return ctx.ruleset.trickRoomNegatesSpeed ? spe : trunc(ctx, spe, 13);
}

export function resolveMoveType(
  ctx: StaticBattleContext,
  state: DynamicState,
  atkSide: 0 | 1,
  atkIdx: number,
  move: StaticMoveData
): {type: string; ateBoosted: boolean} {
  const sp = ctx.sides[atkSide].team[atkIdx];
  const p = state.sides[atkSide].pokemon[atkIdx];
  const ab = activeAbilitySpec(sp, p);
  const abActive = p.abilityActive && !p.gastroAcid;
  let type = move.type;
  let ateBoosted = false;

  if (move.specialKind === 'weather-ball') {
    const w = effectiveFieldWeather(ctx, state);
    if (w === 'sun') type = 'Fire';
    else if (w === 'rain') type = 'Water';
    else if (w === 'sand') type = 'Rock';
    else if (w === 'snow') type = 'Ice';
  } else if (move.specialKind === 'terrain-pulse' && isGrounded(sp, p, state)) {
    if (state.field.terrain === 'electric') type = 'Electric';
    else if (state.field.terrain === 'grassy') type = 'Grass';
    else if (state.field.terrain === 'misty') type = 'Fairy';
    else if (state.field.terrain === 'psychic') type = 'Psychic';
  } else if (move.specialKind === 'raging-bull') {
    const sid = activeSpeciesId(sp, p);
    if (sid === 'taurospaldeacombat') type = 'Fighting';
    else if (sid === 'taurospaldeablaze') type = 'Fire';
    else if (sid === 'taurospaldeaaqua') type = 'Water';
  } else if (move.specialKind === 'aura-wheel') {
    type = activeSpeciesId(sp, p) === 'morpekohangry' ? 'Dark' : 'Electric';
  }

  if (abActive) {
    if (ab.ateType && type === 'Normal' && move.category !== 'Status' &&
        move.id !== 'technoblast' && move.id !== 'weatherball' && move.id !== 'terrainpulse') {
      type = ab.ateType;
      ateBoosted = true;
    } else if (ab.liquidVoice && move.sound) {
      type = 'Water';
    }
  }

  if (p.electrified && move.id !== 'struggle') {
    type = 'Electric';
    ateBoosted = false;
  }

  return {type, ateBoosted};
}

export function typeEffectiveness(
  ctx: StaticBattleContext,
  moveType: string,
  defenderTypes: readonly string[],
  scrappy = false,
  specialKind?: StaticMoveData['specialKind']
): {immune: boolean; mod: number} {
  if (moveType === '???') return {immune: false, mod: 0};
  const row = ctx.typeChart.get(moveType);
  if (!row) return {immune: false, mod: 0};
  let mod = 0;
  for (const dt of defenderTypes) {
    if (specialKind === 'freeze-dry' && dt === 'Water') {
      mod += 1;
      continue;
    }
    if (scrappy && dt === 'Ghost' && (moveType === 'Normal' || moveType === 'Fighting')) {
      continue;
    }
    const e = row.get(dt) ?? 0;
    if (e === -99) return {immune: true, mod: 0};
    mod += e;
  }
  if (specialKind === 'flying-press') {
    const flyRow = ctx.typeChart.get('Flying');
    if (flyRow) {
      for (const dt of defenderTypes) {
        const e = flyRow.get(dt) ?? 0;
        if (e === -99) return {immune: true, mod: 0};
        mod += e;
      }
    }
  }
  return {immune: false, mod: clampInt(mod, -6, 6)};
}

export function hasPinchBoost(
  ab: {pinchType?: string},
  moveType: string
): boolean {
  return !!ab.pinchType && ab.pinchType === moveType;
}

export interface DamageRollOptions {
  isCrit: boolean;
  isSpread: boolean;
  pinchActive: boolean;
  multiscaleActive: boolean;
  bypassProtect: boolean;
  resistBerryActive: boolean;
  analyticBoost?: boolean;
  fickleDouble?: boolean;
  basePowerOverride?: number;
  categoryOverride?: MoveCategory;
  contactOverride?: boolean;
  parentalBondSecondHit?: boolean;
  teraShellActive?: boolean;
}

export interface DamageRollResult {
  immune: boolean;
  typeMod: number;
  effectiveType: string;
  /** 16 equiprobable rolls (or 1 entry for fixed damage moves like Seismic Toss). */
  rolls: readonly number[];
}

export class DamageBatchCache {
  private readonly cache = new Map<string, DamageRollResult>();
  hits = 0;
  misses = 0;

  getOrCompute(
    ctx: StaticBattleContext,
    state: DynamicState,
    atkSide: 0 | 1,
    atkIdx: number,
    defSide: 0 | 1,
    defIdx: number,
    move: StaticMoveData,
    opts: DamageRollOptions
  ): DamageRollResult {
    const atkPoke = state.sides[atkSide].pokemon[atkIdx];
    const defPoke = state.sides[defSide].pokemon[defIdx];
    const atkStatic = ctx.sides[atkSide].team[atkIdx];
    const defStatic = ctx.sides[defSide].team[defIdx];
    const defTypes = activeTypes(defStatic, defPoke);
    const atkTypes = activeTypes(atkStatic, atkPoke);
    const effectiveCategory = opts.categoryOverride ?? move.category;
    const isPhys = effectiveCategory === 'Physical';
    const defScreen = isPhys
      ? (state.sides[defSide].reflectTurns > 0 || state.sides[defSide].auroraVeilTurns > 0)
      : (state.sides[defSide].lightScreenTurns > 0 || state.sides[defSide].auroraVeilTurns > 0);

    const dynamicSuffix =
      (move.specialKind === 'hp-scaled-bp' || move.specialKind === 'brine' || move.specialKind === 'flail' || move.specialKind === 'hard-press'
        ? `:${atkPoke.hp}:${defPoke.hp}` : '') +
      (move.specialKind === 'stored-power' ? `:${atkPoke.boosts.join(',')}` : '') +
      (move.specialKind === 'rage-fist' ? `:rf${atkPoke.timesAttacked}` : '') +
      (move.specialKind === 'last-respects' ? `:lr${state.sides[atkSide].pokemon.filter(p => p.fainted).length}` : '') +
      (move.specialKind === 'spit-up' ? `:su${atkPoke.stockpileLayers}` : '') +
      (move.specialKind === 'round' && state.sides[atkSide].roundUsedThisTurn ? ':rd2' : '') +
      (move.specialKind === 'gyro-ball' || move.specialKind === 'electro-ball'
        ? `:sp${atkPoke.boosts[4]},${defPoke.boosts[4]},${state.sides[atkSide].tailwindTurns > 0 ? 1 : 0}${state.sides[defSide].tailwindTurns > 0 ? 1 : 0}` : '') +
      (opts.basePowerOverride ? `:bp${opts.basePowerOverride}` : '') +
      (opts.categoryOverride ? `:cat${opts.categoryOverride[0]}` : '') +
      (opts.contactOverride !== undefined ? `:ct${opts.contactOverride ? 1 : 0}` : '') +
      (opts.analyticBoost ? ':an' : '') +
      (opts.fickleDouble ? ':fd' : '') +
      (opts.parentalBondSecondHit ? ':pb2' : '') +
      (opts.teraShellActive ? ':ts' : '') +
      (atkPoke.charged ? ':cg' : '') +
      (atkPoke.electrified ? ':el' : '') +
      (atkPoke.helpingHandCount ? `:hh${atkPoke.helpingHandCount}` : '') +
      (defPoke.glaiveRush ? ':gr' : '') +
      (defPoke.switchedInThisTurn ? ':sw' : '') +
      (defPoke.movedThisTurn ? ':mv' : '') +
      (defPoke.damagedThisTurn > 0 ? ':dt' : '') +
      (atkPoke.damagedThisTurn > 0 ? ':at' : '') +
      (atkPoke.statLoweredThisTurn ? ':sl' : '') +
      (atkPoke.lastMoveFailed ? ':lf' : '') +
      (atkPoke.formeId ? `:af${atkPoke.formeId}` : '') +
      (defPoke.formeId ? `:df${defPoke.formeId}` : '') +
      (atkPoke.abilityOverride !== null ? `:aa${atkPoke.abilityOverride}` : '') +
      (defPoke.abilityOverride !== null ? `:da${defPoke.abilityOverride}` : '') +
      (atkPoke.gastroAcid ? ':ag' : '') +
      (defPoke.gastroAcid ? ':dg' : '') +
      (atkPoke.itemOverride !== null ? `:ai${atkPoke.itemOverride}` : '') +
      (defPoke.itemOverride !== null ? `:di${defPoke.itemOverride}` : '') +
      (atkPoke.powerTrick ? ':apw' : '') +
      (defPoke.powerTrick ? ':dpw' : '') +
      (atkPoke.statOverride ? `:aso${atkPoke.statOverride.atk ?? ''},${atkPoke.statOverride.def ?? ''},${atkPoke.statOverride.spa ?? ''},${atkPoke.statOverride.spd ?? ''}` : '') +
      (defPoke.statOverride ? `:dso${defPoke.statOverride.atk ?? ''},${defPoke.statOverride.def ?? ''},${defPoke.statOverride.spa ?? ''},${defPoke.statOverride.spd ?? ''}` : '') +
      (atkPoke.transformed ? `:atf${atkPoke.transformed.speciesId}` : '') +
      (defPoke.transformed ? `:dtf${defPoke.transformed.speciesId}` : '') +
      (state.field.wonderRoomTurns > 0 ? ':wr' : '') +
      (state.field.magicRoomTurns > 0 ? ':mr' : '') +
      (state.field.gravityTurns > 0 ? ':gv' : '');

    const sig =
      `${atkSide}:${atkIdx}${atkPoke.megaEvolved ? 'M' : ''}>${defSide}:${defIdx}${defPoke.megaEvolved ? 'M' : ''}|${move.id}|` +
      `${opts.isCrit ? 1 : 0}${opts.isSpread ? 1 : 0}${opts.pinchActive ? 1 : 0}${opts.multiscaleActive ? 1 : 0}${opts.bypassProtect ? 1 : 0}${opts.resistBerryActive ? 1 : 0}|` +
      `${atkPoke.boosts[0]},${atkPoke.boosts[1]},${atkPoke.boosts[2]}|${defPoke.boosts[0]},${defPoke.boosts[1]},${defPoke.boosts[3]}|` +
      `${atkPoke.status}|${defPoke.status}|` +
      `${atkPoke.itemActive ? 1 : 0}${defPoke.itemActive ? 1 : 0}${atkPoke.flashFireActive ? 1 : 0}|` +
      `${defScreen ? 1 : 0}|${effectiveFieldWeather(ctx, state)}|${state.field.terrain}|` +
      `${atkTypes.join(',')}>${defTypes.join(',')}${dynamicSuffix}`;

    const cached = this.cache.get(sig);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const result = computeDamageRolls(ctx, state, atkSide, atkIdx, defSide, defIdx, move, opts);
    this.cache.set(sig, result);
    return result;
  }
}

function hasActiveFieldAbility(
  ctx: StaticBattleContext,
  state: DynamicState,
  check: (ab: ReturnType<typeof activeAbilitySpec>) => boolean
): boolean {
  for (const s of [0, 1] as const) {
    for (const idx of state.sides[s].active) {
      if (idx < 0) continue;
      const p = state.sides[s].pokemon[idx];
      if (!p.fainted && p.abilityActive && !p.gastroAcid && check(activeAbilitySpec(ctx.sides[s].team[idx], p))) {
        return true;
      }
    }
  }
  return false;
}

function countActiveSideAbility(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  excludeIdx: number,
  check: (ab: ReturnType<typeof activeAbilitySpec>) => boolean
): number {
  let count = 0;
  for (const idx of state.sides[sideIdx].active) {
    if (idx < 0 || idx === excludeIdx) continue;
    const p = state.sides[sideIdx].pokemon[idx];
    if (!p.fainted && p.abilityActive && !p.gastroAcid && check(activeAbilitySpec(ctx.sides[sideIdx].team[idx], p))) {
      count++;
    }
  }
  return count;
}

export function computeDamageRolls(
  ctx: StaticBattleContext,
  state: DynamicState,
  atkSide: 0 | 1,
  atkIdx: number,
  defSide: 0 | 1,
  defIdx: number,
  move: StaticMoveData,
  opts: DamageRollOptions
): DamageRollResult {
  const atkStatic = ctx.sides[atkSide].team[atkIdx];
  const defStatic = ctx.sides[defSide].team[defIdx];
  const atkPoke = state.sides[atkSide].pokemon[atkIdx];
  const defPoke = state.sides[defSide].pokemon[defIdx];
  const atkTypes = activeTypes(atkStatic, atkPoke);
  const defTypes = activeTypes(defStatic, defPoke);
  const atkStats = activeStats(atkStatic, atkPoke);
  const defStats = activeStats(defStatic, defPoke);
  const atkAb = activeAbilitySpec(atkStatic, atkPoke);
  const defAb = activeAbilitySpec(defStatic, defPoke);
  const atkAbActive = atkPoke.abilityActive && !atkPoke.gastroAcid;
  const moldBreaker = atkAbActive && !!atkAb.moldBreaker;
  const defAbActive = defPoke.abilityActive && !defPoke.gastroAcid && !moldBreaker;
  const weather = effectiveFieldWeather(ctx, state);
  const effectiveCategory = opts.categoryOverride ?? move.category;
  const baseContact = opts.contactOverride ?? move.contact;
  const makesContact = baseContact && !(atkAbActive && atkAb.longReach);
  const atkItemSpec = activeItemSpec(ctx, atkStatic, atkPoke);
  const defItemSpec = activeItemSpec(ctx, defStatic, defPoke);

  const {type: moveType, ateBoosted} = resolveMoveType(ctx, state, atkSide, atkIdx, move);

  // Type immunity & effectiveness check (including Freeze-Dry, Flying Press, Tera Shell)
  const eff = typeEffectiveness(
    ctx,
    moveType,
    defTypes,
    atkAbActive && !!atkAb.scrappy,
    move.specialKind
  );
  if (eff.immune) {
    return {immune: true, typeMod: 0, effectiveType: moveType, rolls: []};
  }
  const typeMod = opts.teraShellActive && defAbActive && defAb.teraShell ? -1 : eff.mod;

  // Fixed damage moves (Seismic Toss, Night Shade)
  if (move.fixedDamage !== null) {
    const dmg = move.fixedDamage === 'level' ? atkStatic.level : move.fixedDamage;
    return {immune: false, typeMod, effectiveType: moveType, rolls: [dmg]};
  }

  // Base power + special formula moves
  let basePower = opts.basePowerOverride ?? move.basePower;
  if (move.specialKind === 'facade' && atkPoke.status !== '') {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'hex' && defPoke.status !== '') {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'venoshock' && (defPoke.status === 'psn' || defPoke.status === 'tox')) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'acrobatics' && !atkPoke.itemActive) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'brine' && defPoke.hp * 2 <= defStatic.maxhp) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'weather-ball' && weather !== '') {
    basePower = 100;
  } else if (move.specialKind === 'terrain-pulse' && state.field.terrain !== '' && isGrounded(atkStatic, atkPoke, state)) {
    basePower = 100;
  } else if (move.specialKind === 'stored-power') {
    let totalPos = 0;
    for (let i = 0; i < 7; i++) if (atkPoke.boosts[i] > 0) totalPos += atkPoke.boosts[i];
    basePower = 20 + 20 * totalPos;
  } else if (move.specialKind === 'spit-up') {
    basePower = 100 * atkPoke.stockpileLayers;
  } else if (move.specialKind === 'round' && state.sides[atkSide].roundUsedThisTurn) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'hp-scaled-bp') {
    basePower = Math.max(1, Math.floor(150 * atkPoke.hp / atkStatic.maxhp));
  } else if (move.specialKind === 'weight-target') {
    const defW = activeWeightHg(defStatic, defPoke);
    basePower = defW >= 2000 ? 120 : defW >= 1000 ? 100 : defW >= 500 ? 80 : defW >= 250 ? 60 : defW >= 100 ? 40 : 20;
  } else if (move.specialKind === 'weight-ratio') {
    const ratio = Math.floor(activeWeightHg(atkStatic, atkPoke) / Math.max(1, activeWeightHg(defStatic, defPoke)));
    basePower = ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
  } else if (move.specialKind === 'gyro-ball') {
    const atkSpe = rawEffectiveSpeed(ctx, state, atkSide, atkIdx);
    const defSpe = rawEffectiveSpeed(ctx, state, defSide, defIdx);
    basePower = Math.min(150, Math.floor(25 * defSpe / Math.max(1, atkSpe)) + 1);
  } else if (move.specialKind === 'electro-ball') {
    const atkSpe = rawEffectiveSpeed(ctx, state, atkSide, atkIdx);
    const defSpe = rawEffectiveSpeed(ctx, state, defSide, defIdx);
    const ratio = Math.floor(atkSpe / Math.max(1, defSpe));
    basePower = ratio >= 4 ? 150 : ratio >= 3 ? 120 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 40;
  } else if (move.specialKind === 'flail') {
    const ratio = Math.max(1, Math.floor(48 * atkPoke.hp / atkStatic.maxhp));
    basePower = ratio <= 1 ? 200 : ratio <= 4 ? 150 : ratio <= 9 ? 100 : ratio <= 16 ? 80 : ratio <= 32 ? 40 : 20;
  } else if (move.specialKind === 'hard-press') {
    basePower = Math.max(1, Math.floor(Math.floor((100 * (100 * Math.floor(defPoke.hp * 4096 / defStatic.maxhp)) + 2048 - 1) / 4096) / 100));
  } else if (move.specialKind === 'last-respects') {
    const fainted = state.sides[atkSide].pokemon.filter(p => p.fainted).length;
    basePower = 50 + 50 * fainted;
  } else if (move.specialKind === 'rage-fist') {
    basePower = 50 + 50 * Math.min(6, atkPoke.timesAttacked);
  } else if (move.specialKind === 'payback' && (defPoke.movedThisTurn || defPoke.switchedInThisTurn)) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'avalanche' && atkPoke.damagedThisTurn > 0 && atkPoke.damagedBySide === defSide) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'assurance' && defPoke.damagedThisTurn > 0) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'lash-out' && atkPoke.statLoweredThisTurn) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'stomping-tantrum' && atkPoke.lastMoveFailed) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'fickle-beam' && opts.fickleDouble) {
    basePower = move.basePower * 2;
  } else if (move.specialKind === 'grav-apple' && state.field.gravityTurns > 0) {
    basePower = pokeRound(ctx, basePower, 1.5);
  } else if (move.specialKind === 'expanding-force' && state.field.terrain === 'psychic' && isGrounded(atkStatic, atkPoke, state)) {
    basePower = pokeRound(ctx, basePower, 1.5);
  } else if (move.specialKind === 'rising-voltage' && state.field.terrain === 'electric' && isGrounded(defStatic, defPoke, state)) {
    basePower = basePower * 2;
  } else if (move.id === 'mistyexplosion' && state.field.terrain === 'misty' && isGrounded(atkStatic, atkPoke, state)) {
    basePower = pokeRound(ctx, basePower, 1.5);
  }

  basePower = clampInt(basePower, 1);

  // BasePower modifiers (Solar Beam non-Sun penalty, Knock Off, Charge, Helping Hand, Abilities, Items, Terrain)
  const effectiveWeather = (atkAbActive && atkAb.megaSol) ? 'sun' : weather;
  if (move.specialKind === 'solar-beam' && effectiveWeather !== '' && effectiveWeather !== 'sun') {
    basePower = pokeRound(ctx, basePower, 0.5);
  }
  if (move.knockOff && defPoke.itemActive && defItemSpec.id !== '' && defItemSpec.removable) {
    basePower = pokeRound(ctx, basePower, 1.5);
  }
  if (atkPoke.charged && moveType === 'Electric') {
    basePower = pokeRound(ctx, basePower, 2);
  }
  for (let h = 0; h < atkPoke.helpingHandCount; h++) {
    basePower = pokeRound(ctx, basePower, 1.5);
  }
  if (ateBoosted) {
    basePower = pokeRound(ctx, basePower, 4915, 4096);
  }
  if (moveType === 'Fairy' && hasActiveFieldAbility(ctx, state, a => !!a.fairyAura)) {
    basePower = pokeRound(ctx, basePower, 5448, 4096);
  }
  if (moveType === 'Steel') {
    const ssCount = (atkAbActive && atkAb.steelySpirit ? 1 : 0) +
      countActiveSideAbility(ctx, state, atkSide, atkIdx, a => !!a.steelySpirit);
    for (let i = 0; i < ssCount; i++) basePower = pokeRound(ctx, basePower, 1.5);
  }
  if (atkAbActive) {
    if (atkAb.technician && basePower <= 60) basePower = pokeRound(ctx, basePower, 1.5);
    if (atkAb.toughClaws && makesContact) basePower = pokeRound(ctx, basePower, 5325, 4096);
    if (atkAb.sheerForce && move.secondaries.length > 0) basePower = pokeRound(ctx, basePower, 5325, 4096);
    if (atkAb.sharpness && move.slicing) basePower = pokeRound(ctx, basePower, 1.5);
    if (atkAb.strongJaw && move.bite) basePower = pokeRound(ctx, basePower, 1.5);
    if (atkAb.ironFist && move.punch) basePower = pokeRound(ctx, basePower, 4915, 4096);
    if (atkAb.megaLauncher && move.pulse) basePower = pokeRound(ctx, basePower, 1.5);
    if (atkAb.reckless && (move.recoil || move.specialKind === 'crash-recoil')) basePower = pokeRound(ctx, basePower, 4915, 4096);
    if (atkAb.punkRock && move.sound) basePower = pokeRound(ctx, basePower, 5325, 4096);
    if (atkAb.analytic && opts.analyticBoost) basePower = pokeRound(ctx, basePower, 5325, 4096);
    if (atkAb.rivalry && atkStatic.gender && defStatic.gender) {
      basePower = pokeRound(ctx, basePower, atkStatic.gender === defStatic.gender ? 1.25 : 0.75);
    }
    if (atkAb.supremeOverlord) {
      const fallen = Math.min(5, state.sides[atkSide].pokemon.filter(p => p.fainted).length);
      if (fallen > 0) basePower = pokeRound(ctx, basePower, SUPREME_OVERLORD_MODS[fallen], 4096);
    }
    if (atkAb.sandForce && weather === 'sand' &&
        (moveType === 'Rock' || moveType === 'Ground' || moveType === 'Steel')) {
      basePower = pokeRound(ctx, basePower, 5325, 4096);
    }
  }
  if (defAbActive && defAb.drySkin && moveType === 'Fire') {
    basePower = pokeRound(ctx, basePower, 5120, 4096);
  }
  if (isItemEffectActive(state, atkStatic, atkPoke)) {
    const it = atkItemSpec;
    if (it.archetype === 'type-boost' && it.affectedType === moveType) {
      basePower = pokeRound(ctx, basePower, 4915, 4096);
    } else if (it.archetype === 'muscle-band' && effectiveCategory === 'Physical') {
      basePower = pokeRound(ctx, basePower, 4505, 4096);
    } else if (it.archetype === 'wise-glasses' && effectiveCategory === 'Special') {
      basePower = pokeRound(ctx, basePower, 4505, 4096);
    } else if (it.archetype === 'normal-gem' && moveType === 'Normal') {
      basePower = pokeRound(ctx, basePower, 5325, 4096);
    }
  }
  // Terrain base power modifiers
  const atkGrounded = isGrounded(atkStatic, atkPoke, state);
  const defGrounded = isGrounded(defStatic, defPoke, state);
  if (atkGrounded) {
    if (state.field.terrain === 'electric' && moveType === 'Electric') basePower = pokeRound(ctx, basePower, 5325, 4096);
    else if (state.field.terrain === 'grassy' && moveType === 'Grass') basePower = pokeRound(ctx, basePower, 5325, 4096);
    else if (state.field.terrain === 'psychic' && moveType === 'Psychic') basePower = pokeRound(ctx, basePower, 5325, 4096);
  }
  if (defGrounded) {
    if (state.field.terrain === 'misty' && moveType === 'Dragon') basePower = pokeRound(ctx, basePower, 0.5);
    if (state.field.terrain === 'grassy' && (move.id === 'earthquake' || move.id === 'bulldoze')) {
      basePower = pokeRound(ctx, basePower, 0.5);
    }
  }
  basePower = clampInt(basePower, 1);

  // Offensive / Defensive stat selection (Body Press, Foul Play, Psyshock, Wonder Room, Unaware)
  const isPhys = effectiveCategory === 'Physical';
  const useDefForAtk = move.specialKind === 'body-press';
  const useTargetAtk = move.specialKind === 'foul-play';
  const targetPhysDef = isPhys || move.specialKind === 'psyshock';
  const wonderRoom = state.field.wonderRoomTurns > 0;
  const effTargetPhysDef = wonderRoom ? !targetPhysDef : targetPhysDef;

  let atkBoost = useTargetAtk
    ? defPoke.boosts[0]
    : useDefForAtk
      ? atkPoke.boosts[1]
      : atkPoke.boosts[isPhys ? 0 : 2];
  let defBoost = defPoke.boosts[targetPhysDef ? 1 : 3];

  if (defAbActive && defAb.unaware) atkBoost = 0;
  if (atkAbActive && atkAb.unaware) defBoost = 0;
  if (opts.isCrit) {
    if (atkBoost < 0) atkBoost = 0;
    if (defBoost > 0) defBoost = 0;
  }

  const rawAtkBase = useTargetAtk
    ? defStats.atk
    : useDefForAtk
      ? atkStats.def
      : (isPhys ? atkStats.atk : atkStats.spa);
  const rawDefBase = effTargetPhysDef ? defStats.def : defStats.spd;

  let attack = applyBoostToStat(rawAtkBase, atkBoost);
  let defense = applyBoostToStat(rawDefBase, defBoost);

  // ModifyAtk / ModifySpA (Abilities & Items)
  if (atkAbActive) {
    if (opts.pinchActive && hasPinchBoost(atkAb, moveType)) {
      attack = pokeRound(ctx, attack, 1.5);
    }
    if (atkAb.offenseTypeBoost && atkAb.offenseTypeBoost.type === moveType) {
      attack = pokeRound(ctx, attack, atkAb.offenseTypeBoost.mult);
    }
    if (atkAb.hugePower && isPhys) attack = pokeRound(ctx, attack, 2);
    if (atkAb.guts && isPhys && atkPoke.status !== '') attack = pokeRound(ctx, attack, 1.5);
    if (atkAb.hustle && isPhys) attack = pokeRound(ctx, attack, 1.5);
    if (atkAb.waterBubble && moveType === 'Water') attack = pokeRound(ctx, attack, 2);
    if (atkAb.solarPower && !isPhys && weather === 'sun') attack = pokeRound(ctx, attack, 1.5);
    if (atkAb.stakeout && defPoke.switchedInThisTurn) attack = pokeRound(ctx, attack, 2);
    if (atkAb.plusMinus && !isPhys && countActiveSideAbility(ctx, state, atkSide, atkIdx, a => !!a.plusMinus) > 0) {
      attack = pokeRound(ctx, attack, 1.5);
    }
    if (atkPoke.flashFireActive && moveType === 'Fire') attack = pokeRound(ctx, attack, 1.5);
  }
  if (isItemEffectActive(state, atkStatic, atkPoke) && atkItemSpec.archetype === 'light-ball' && activeSpeciesId(atkStatic, atkPoke) === 'pikachu') {
    attack = pokeRound(ctx, attack, 2);
  }
  if (defAbActive) {
    if (defAb.thickFat && (moveType === 'Fire' || moveType === 'Ice')) attack = pokeRound(ctx, attack, 0.5);
    if (defAb.heatproof && moveType === 'Fire') attack = pokeRound(ctx, attack, 0.5);
    if (defAb.waterBubble && moveType === 'Fire') attack = pokeRound(ctx, attack, 0.5);
    if (defAb.purifyingSalt && moveType === 'Ghost') attack = pokeRound(ctx, attack, 0.5);
    if (defAb.furCoat && targetPhysDef) defense = pokeRound(ctx, defense, 2);
    if (defAb.marvelScale && targetPhysDef && defPoke.status !== '') defense = pokeRound(ctx, defense, 1.5);
    if (defAb.grassPelt && targetPhysDef && state.field.terrain === 'grassy') defense = pokeRound(ctx, defense, 1.5);
  }

  // Weather defense boosts: Sandstorm 1.5x Rock SpD, Snow 1.5x Ice Def
  if (weather === 'sand' && !targetPhysDef && defTypes.includes('Rock')) {
    defense = pokeRound(ctx, defense, 1.5);
  }
  if (weather === 'snow' && targetPhysDef && defTypes.includes('Ice')) {
    defense = pokeRound(ctx, defense, 1.5);
  }

  // Base damage formula: int(int(int(2 * L / 5 + 2) * P * A / D) / 50) + 2
  const levelTerm = trunc(ctx, 2 * atkStatic.level / 5 + 2);
  let baseDamage = trunc(ctx, trunc(ctx, trunc(ctx, levelTerm * basePower * attack) / defense) / 50);
  baseDamage += 2;

  if (opts.isSpread) {
    baseDamage = pokeRound(ctx, baseDamage, 0.75);
  }

  if (effectiveWeather === 'sun') {
    if (moveType === 'Fire') baseDamage = pokeRound(ctx, baseDamage, 1.5);
    else if (moveType === 'Water') baseDamage = pokeRound(ctx, baseDamage, 0.5);
  } else if (effectiveWeather === 'rain') {
    if (moveType === 'Water') baseDamage = pokeRound(ctx, baseDamage, 1.5);
    else if (moveType === 'Fire') baseDamage = pokeRound(ctx, baseDamage, 0.5);
  }

  if (opts.isCrit) {
    baseDamage = trunc(ctx, baseDamage * 1.5);
  }

  const isSTAB = moveType !== '???' && atkTypes.includes(moveType);
  const stabMult = isSTAB ? (atkAbActive && atkAb.adaptability ? 2 : 1.5) : 1;
  const isBurnedPhys = atkPoke.status === 'brn' && isPhys &&
    !(atkAbActive && atkAb.guts) && move.specialKind !== 'facade';
  const hasLifeOrb = isItemEffectActive(state, atkStatic, atkPoke) && atkItemSpec.archetype === 'life-orb' && move.id !== 'struggle';
  const hasExpertBelt = isItemEffectActive(state, atkStatic, atkPoke) && atkItemSpec.archetype === 'expert-belt' && typeMod > 0;
  const hasScreen = !opts.isCrit && !(atkAbActive && atkAb.infiltrator) && (
    isPhys
      ? (state.sides[defSide].reflectTurns > 0 || state.sides[defSide].auroraVeilTurns > 0)
      : (state.sides[defSide].lightScreenTurns > 0 || state.sides[defSide].auroraVeilTurns > 0)
  );
  const friendGuardCount = !moldBreaker
    ? countActiveSideAbility(ctx, state, defSide, defIdx, a => !!a.friendGuard)
    : 0;

  // Compute exact 16 damage rolls (85%..100%)
  const rolls: number[] = new Array(16);
  for (let r = 0; r < 16; r++) {
    let d = trunc(ctx, trunc(ctx, baseDamage * (100 - r)) / 100);
    if (isSTAB) {
      d = pokeRound(ctx, d, stabMult);
    }
    if (typeMod > 0) {
      for (let i = 0; i < typeMod; i++) d *= 2;
    } else if (typeMod < 0) {
      for (let i = 0; i > typeMod; i--) d = trunc(ctx, d / 2);
    }
    if (isBurnedPhys) {
      d = pokeRound(ctx, d, 0.5);
    }

    // Final ModifyDamage chain
    if (opts.parentalBondSecondHit) {
      d = pokeRound(ctx, d, 0.25);
    }
    if (defPoke.glaiveRush) {
      d = pokeRound(ctx, d, 2);
    }
    if (hasScreen) {
      d = pokeRound(ctx, d, ctx.gameType === 'doubles' ? 2732 : 2048, 4096);
    }
    if (opts.multiscaleActive && defAbActive && defAb.multiscale) {
      d = pokeRound(ctx, d, 0.5);
    }
    if (defAbActive) {
      if (defAb.auraGuard && makesContact) d = pokeRound(ctx, d, 0.5);
      if (defAb.filter && typeMod > 0) d = pokeRound(ctx, d, 0.75);
      if (defAb.fluffy) {
        if (makesContact) d = pokeRound(ctx, d, 0.5);
        if (moveType === 'Fire') d = pokeRound(ctx, d, 2);
      }
      if (defAb.iceScales && effectiveCategory === 'Special') d = pokeRound(ctx, d, 0.5);
      if (defAb.punkRock && move.sound) d = pokeRound(ctx, d, 0.5);
    }
    for (let fg = 0; fg < friendGuardCount; fg++) {
      d = pokeRound(ctx, d, 0.75);
    }
    if (atkAbActive) {
      if (atkAb.sniper && opts.isCrit) d = pokeRound(ctx, d, 1.5);
      if (atkAb.tintedLens && typeMod < 0) d = pokeRound(ctx, d, 2);
    }
    if (hasExpertBelt) {
      d = pokeRound(ctx, d, 4915, 4096);
    }
    if (hasLifeOrb) {
      d = pokeRound(ctx, d, 5324, 4096);
    }
    if (opts.resistBerryActive) {
      d = pokeRound(ctx, d, 0.5);
      if (defPoke.abilityActive && !defPoke.gastroAcid && defAb.ripen) {
        d = pokeRound(ctx, d, 0.5);
      }
    }
    if (opts.bypassProtect && ctx.ruleset.protectBypassMultiplier !== 1) {
      d = pokeRound(ctx, d, ctx.ruleset.protectBypassMultiplier);
    }

    if (!d) d = 1;
    rolls[r] = trunc(ctx, d, 16);
  }

  return {immune: false, typeMod, effectiveType: moveType, rolls};
}
