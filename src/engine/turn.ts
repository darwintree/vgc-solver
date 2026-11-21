import {compileAbilitySpec} from './effects/abilities';
import {compileMoveSpec} from './effects/moves';
import {
  DamageBatchCache,
  applyBoostToStat,
  clampInt,
  effectiveFieldWeather,
  effectiveSpeed,
  hasPinchBoost,
  pokeRound,
  resolveMoveType,
  typeEffectiveness,
} from './damage';
import {
  activeAbilitySpec,
  activeItemId,
  activeItemSpec,
  activeMoves,
  activeSpeciesId,
  activeStats,
  activeTypes,
  canSlotMegaEvolve,
  canonicalStateKey,
  cloneState,
  expandStateHpDists,
  getHpEntries,
  getItemSpec,
  hpMax,
  hpMin,
  isGrounded,
  isItemEffectActive,
  isSideDefeated,
  legalBenchSwitches,
  setNormalizedHpDist,
  splitBranchByHpPredicate,
} from './state';
import {
  type BoostStat,
  type BranchPolicy,
  type DynamicState,
  type HpEntry,
  type MoveAction,
  type MoveCategory,
  type PendingQueuedAction,
  type PendingSwitchSlot,
  type SideAction,
  type StaticBattleContext,
  type StaticMoveData,
  type StaticPokemonData,
  type StatusId,
  type StepResult,
  type StepStats,
  type SwitchAction,
  type TerrainId,
  type WeatherId,
  type WeightedState,
} from './types';

const EPS = 1e-15;
const BOOST_INDEX: Record<BoostStat, number> = {
  atk: 0, def: 1, spa: 2, spd: 3, spe: 4, acc: 5, eva: 6,
};
const GEN9_CRIT_DENOM = [0, 24, 8, 2, 1];
const MULTIHIT_2_5: readonly {hits: number; prob: number}[] = [
  {hits: 2, prob: 7 / 20},
  {hits: 3, prob: 7 / 20},
  {hits: 4, prob: 3 / 20},
  {hits: 5, prob: 3 / 20},
];

interface ActiveBranch {
  state: DynamicState;
  probability: number;
  remainingActions: PendingQueuedAction[];
}

function createStats(): StepStats {
  return {
    forks: 0,
    merges: 0,
    damageBatchHits: 0,
    damageBatchMisses: 0,
    hpSplits: 0,
    peakBranches: 1,
  };
}

function sideHasActiveAbility(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  check: (ab: ReturnType<typeof activeAbilitySpec>) => boolean
): boolean {
  for (const idx of state.sides[sideIdx].active) {
    if (idx < 0) continue;
    const p = state.sides[sideIdx].pokemon[idx];
    if (!p.fainted && p.abilityActive && check(activeAbilitySpec(ctx.sides[sideIdx].team[idx], p))) {
      return true;
    }
  }
  return false;
}

function fieldHasActiveAbility(
  ctx: StaticBattleContext,
  state: DynamicState,
  check: (ab: ReturnType<typeof activeAbilitySpec>) => boolean
): boolean {
  return sideHasActiveAbility(ctx, state, 0, check) || sideHasActiveAbility(ctx, state, 1, check);
}

function isUnnerved(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1): boolean {
  const oppSide: 0 | 1 = sideIdx === 0 ? 1 : 0;
  return sideHasActiveAbility(ctx, state, oppSide, a => !!a.unnerve);
}

function pokeReadsExactDamage(sp: StaticPokemonData): boolean {
  for (let i = 0; i < sp.moves.length; i++) {
    const sk = sp.moves[i].specialKind;
    if (sk === 'counter' || sk === 'mirror-coat' || sk === 'metal-burst') return true;
  }
  return false;
}

function midTurnBranchKey(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  maskPoke?: {side: 0 | 1; idx: number}
): string {
  let k = canonicalStateKey(ctx, ab.state, undefined, false, maskPoke);
  for (let s = 0; s < 2; s++) {
    const side = ab.state.sides[s];
    if (side.wideGuard || side.quickGuard) k += `|WG${s}:${side.wideGuard ? 1 : 0}${side.quickGuard ? 1 : 0}`;
    for (const idx of side.active) {
      if (idx < 0) continue;
      const p = side.pokemon[idx];
      if (p.protecting || p.enduring || p.roosted || p.flinched || p.movedThisTurn || p.switchedInThisTurn ||
          p.helpingHandCount || p.redirectKind || p.damagedThisTurn || p.statLoweredThisTurn) {
        const dmgKey = p.damagedThisTurn > 0
          ? (pokeReadsExactDamage(ctx.sides[s].team[idx]) ? p.damagedThisTurn : 1)
          : 0;
        k += `|M${s}.${idx}:${p.protecting ? p.protectKind || 1 : 0}${p.enduring ? 1 : 0}${p.roosted ? 1 : 0}${p.flinched ? 1 : 0}${p.movedThisTurn ? 1 : 0}${p.switchedInThisTurn ? 1 : 0}:${p.helpingHandCount}:${p.redirectKind}:${dmgKey}:${p.damagedCategory}:${p.statLoweredThisTurn ? 1 : 0}`;
      }
    }
  }
  if (ab.remainingActions.length > 0) {
    k += '|Q:' + ab.remainingActions
      .map(a => `${a.side}.${a.action.slot}.${a.action.moveIndex}.${a.action.targetSide ?? ''}.${a.action.targetSlot ?? ''}.${a.subOrder}`)
      .join(',');
  }
  return k;
}

/**
 * Exact single-Pokemon marginal HP folding: merges branches whose non-HP state
 * and EVERY other Pokemon's HP distribution are bit-for-bit identical, combining
 * only `(side, idx)`'s HP distribution weighted by branch probability.
 * Preserves all cross-Pokemon joint couplings identically.
 */
function foldBranchesByPokeHp(
  ctx: StaticBattleContext,
  batch: ActiveBranch[],
  side: 0 | 1,
  idx: number,
  stats: StepStats
): ActiveBranch[] {
  if (batch.length <= 1) return batch;
  const maskPoke = {side, idx};
  const groups = new Map<string, ActiveBranch[]>();
  const passthrough: ActiveBranch[] = [];
  for (let i = 0; i < batch.length; i++) {
    const ab = batch[i];
    if (ab.probability <= EPS) continue;
    if (ab.state.phase.kind === 'ended') {
      passthrough.push(ab);
      continue;
    }
    const p = ab.state.sides[side].pokemon[idx];
    if (!p || p.fainted || p.hp <= 0) {
      passthrough.push(ab);
      continue;
    }
    const key = midTurnBranchKey(ctx, ab, maskPoke);
    let g = groups.get(key);
    if (!g) {
      g = [ab];
      groups.set(key, g);
    } else {
      g.push(ab);
    }
  }
  if (groups.size + passthrough.length === batch.length) return batch;
  const out: ActiveBranch[] = [...passthrough];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    let totalProb = 0;
    const hpMap = new Map<number, number>();
    for (let i = 0; i < g.length; i++) {
      const ab = g[i];
      totalProb += ab.probability;
      const entries = getHpEntries(ab.state.sides[side].pokemon[idx]);
      for (let j = 0; j < entries.length; j++) {
        const e = entries[j];
        hpMap.set(e.hp, (hpMap.get(e.hp) ?? 0) + ab.probability * e.prob);
      }
    }
    const target = g[0];
    target.probability = totalProb;
    const combined: HpEntry[] = [];
    for (const [hp, w] of hpMap) {
      combined.push({hp, prob: w / totalProb});
    }
    setNormalizedHpDist(target.state.sides[side].pokemon[idx], combined);
    stats.merges += g.length - 1;
    out.push(target);
  }
  return out;
}

function mergeActiveBranches(
  ctx: StaticBattleContext,
  batch: ActiveBranch[],
  stats: StepStats
): ActiveBranch[] {
  if (batch.length <= 1) return batch;
  const map = new Map<string, ActiveBranch>();
  for (const ab of batch) {
    if (ab.probability <= EPS) continue;
    const key = midTurnBranchKey(ctx, ab);
    const existing = map.get(key);
    if (existing) {
      existing.probability += ab.probability;
      stats.merges++;
    } else {
      map.set(key, ab);
    }
  }
  let out = [...map.values()];
  if (out.length > 1) {
    // Fold HP-only differences one active Pokemon at a time (exact in singles & doubles).
    for (let s = 0; s < 2 && out.length > 1; s++) {
      const sideIdx: 0 | 1 = s === 0 ? 0 : 1;
      const seenIdx = new Set<number>();
      for (let i = 0; i < out.length; i++) {
        const act = out[i].state.sides[sideIdx].active;
        for (let sl = 0; sl < act.length; sl++) {
          if (act[sl] >= 0) seenIdx.add(act[sl]);
        }
      }
      for (const idx of seenIdx) {
        if (out.length <= 1) break;
        out = foldBranchesByPokeHp(ctx, out, sideIdx, idx, stats);
      }
    }
  }
  if (out.length > stats.peakBranches) stats.peakBranches = out.length;
  return out;
}

interface DeferTracker {
  minProb: number;
  maxMass: number;
  minBranches: number;
  deferredMass: number;
}

function deferLowProbBranches(
  batch: ActiveBranch[],
  defer?: DeferTracker
): ActiveBranch[] {
  if (!defer || defer.minProb <= 0 || batch.length < defer.minBranches) return batch;
  if (defer.deferredMass >= defer.maxMass - EPS) return batch;
  let hasSmall = false;
  for (let i = 0; i < batch.length; i++) {
    if (batch[i].probability < defer.minProb) {
      hasSmall = true;
      break;
    }
  }
  if (!hasSmall) return batch;
  const small: ActiveBranch[] = [];
  const kept: ActiveBranch[] = [];
  for (let i = 0; i < batch.length; i++) {
    const ab = batch[i];
    if (ab.probability < defer.minProb) small.push(ab);
    else kept.push(ab);
  }
  if (small.length > 1) small.sort((a, b) => a.probability - b.probability);
  for (let i = 0; i < small.length; i++) {
    const ab = small[i];
    if (defer.deferredMass + ab.probability <= defer.maxMass + EPS) {
      defer.deferredMass += ab.probability;
    } else {
      kept.push(ab);
    }
  }
  return kept;
}

function deferLowProbEntries<T extends {ab: ActiveBranch}>(
  entries: T[],
  defer?: DeferTracker
): T[] {
  if (!defer || defer.minProb <= 0 || entries.length < defer.minBranches) return entries;
  if (defer.deferredMass >= defer.maxMass - EPS) return entries;
  let hasSmall = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].ab.probability < defer.minProb) {
      hasSmall = true;
      break;
    }
  }
  if (!hasSmall) return entries;
  const small: T[] = [];
  const kept: T[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.ab.probability < defer.minProb) small.push(e);
    else kept.push(e);
  }
  if (small.length > 1) small.sort((a, b) => a.ab.probability - b.ab.probability);
  for (let i = 0; i < small.length; i++) {
    const e = small[i];
    if (defer.deferredMass + e.ab.probability <= defer.maxMass + EPS) {
      defer.deferredMass += e.ab.probability;
    } else {
      kept.push(e);
    }
  }
  return kept;
}

function pickChoices<T>(
  choices: {item: T; prob: number}[],
  policy: BranchPolicy,
  stats: StepStats
): {item: T; prob: number}[] {
  const nonzero = choices.filter(c => c.prob > EPS);
  if (nonzero.length <= 1) return nonzero;
  if (policy.mode === 'compute') {
    const rng = policy.rng ?? Math.random;
    const u = rng();
    let acc = 0;
    for (let i = 0; i < nonzero.length; i++) {
      acc += nonzero[i].prob;
      if (u < acc || i === nonzero.length - 1) {
        return [{item: nonzero[i].item, prob: 1}];
      }
    }
  }
  stats.forks += nonzero.length - 1;
  return nonzero;
}

function checkEnded(state: DynamicState, preferWinner?: 0 | 1): boolean {
  const p1Dead = isSideDefeated(state.sides[0]);
  const p2Dead = isSideDefeated(state.sides[1]);
  if (!p1Dead && !p2Dead) return false;
  if (p1Dead && p2Dead) {
    state.phase = {kind: 'ended', winner: preferWinner !== undefined ? preferWinner : 2};
  } else if (p2Dead) {
    state.phase = {kind: 'ended', winner: 0};
  } else {
    state.phase = {kind: 'ended', winner: 1};
  }
  return true;
}

function getMoveForAction(
  ctx: StaticBattleContext,
  sideIdx: 0 | 1,
  pokeIdx: number,
  moveIndex: number,
  state?: DynamicState
): StaticMoveData {
  if (moveIndex < 0) return ctx.struggleMove;
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const moves = state ? activeMoves(sp, state.sides[sideIdx].pokemon[pokeIdx]) : sp.moves;
  return moves[moveIndex] ?? ctx.struggleMove;
}

function abilityFlags(ctx: StaticBattleContext, abilityId: string): Record<string, number> {
  if (!abilityId) return {};
  return ((ctx.dex.abilities.get(abilityId) as any)?.flags || {}) as Record<string, number>;
}

function setPokemonItem(state: DynamicState, sideIdx: 0 | 1, pokeIdx: number, itemId: string): void {
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  p.itemOverride = itemId;
  p.itemActive = itemId !== '';
  if (itemId !== '') p.unburdenActive = false;
}

function canRemoveItem(ctx: StaticBattleContext, state: DynamicState, targetSide: 0 | 1, targetIdx: number, byOpponent: boolean): boolean {
  const sp = ctx.sides[targetSide].team[targetIdx];
  const p = state.sides[targetSide].pokemon[targetIdx];
  const curId = activeItemId(sp, p);
  if (!curId) return false;
  const it = getItemSpec(ctx, curId);
  if (!it.removable) return false;
  if (byOpponent && p.abilityActive && !p.gastroAcid && activeAbilitySpec(sp, p).stickyHold) return false;
  return true;
}

function triggerSymbiosis(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1, pokeIdx: number): void {
  if (ctx.activeCount < 2) return;
  const receiver = state.sides[sideIdx].pokemon[pokeIdx];
  if (receiver.fainted || receiver.itemActive) return;
  const side = state.sides[sideIdx];
  for (const allyIdx of side.active) {
    if (allyIdx < 0 || allyIdx === pokeIdx) continue;
    const ally = side.pokemon[allyIdx];
    const allySp = ctx.sides[sideIdx].team[allyIdx];
    if (ally.fainted || !ally.abilityActive || ally.gastroAcid) continue;
    if (!activeAbilitySpec(allySp, ally).symbiosis) continue;
    const allyItem = activeItemId(allySp, ally);
    if (!allyItem || !canRemoveItem(ctx, state, sideIdx, allyIdx, false)) continue;
    setPokemonItem(state, sideIdx, allyIdx, '');
    setPokemonItem(state, sideIdx, pokeIdx, allyItem);
    return;
  }
}

function consumeItem(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number,
  isBerry = false,
  skipCudChew = false
): void {
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const curId = activeItemId(sp, p);
  if (!p.itemActive || !curId) return;
  p.lastItemId = curId;
  p.itemOverride = '';
  p.itemActive = false;
  const ab = activeAbilitySpec(sp, p);
  const abActive = p.abilityActive && !p.gastroAcid;
  if (abActive && ab.unburden) {
    p.unburdenActive = true;
  }
  if (isBerry) {
    p.ateBerry = true;
    if (abActive && ab.cudChew && !skipCudChew) {
      p.cudchewBerry = curId;
      p.cudchewTurns = 2;
    }
    if (!p.fainted && abActive && ab.cheekPouch) {
      applyHeal(ctx, state, sideIdx, pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 3)));
    }
  }
  triggerSymbiosis(ctx, state, sideIdx, pokeIdx);
}

/** Apply the immediate eating effect of a Berry (used by Stuff Cheeks, Bug Bite, Pluck, Teatime, Fling, Cud Chew). */
function eatBerryEffect(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number,
  berryId: string,
  fromCudChew = false,
  fromStealEat = false
): void {
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  if (p.fainted) return;
  const spec = getItemSpec(ctx, berryId);
  const ab = activeAbilitySpec(sp, p);
  const abActive = p.abilityActive && !p.gastroAcid;
  const ripenMult = abActive && ab.ripen ? 2 : 1;

  if (spec.archetype === 'sitrus-berry') {
    applyHeal(ctx, state, sideIdx, pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 4)) * ripenMult);
  } else if (spec.archetype === 'oran-berry') {
    applyHeal(ctx, state, sideIdx, pokeIdx, 10 * ripenMult);
  } else if (spec.archetype === 'status-berry') {
    const cures = spec.curesStatus;
    if (cures === 'confusion' || cures === 'any') {
      p.confusionTurns = 0;
    }
    if (cures === 'any' || (p.status !== '' && (cures === p.status || (cures === 'psn' && p.status === 'tox')))) {
      p.status = '';
      p.statusTurns = 0;
    }
  } else if (spec.archetype === 'leppa-berry') {
    const moves = activeMoves(sp, p);
    let targetMi = p.pp.findIndex((val, mi) => val === 0 && mi < moves.length);
    if (targetMi < 0) {
      targetMi = p.pp.findIndex((val, mi) => mi < moves.length && val < moves[mi].maxpp);
    }
    if (targetMi >= 0) {
      p.pp[targetMi] = Math.min(moves[targetMi].maxpp, p.pp[targetMi] + 10);
    }
  }

  p.ateBerry = true;
  if (abActive && ab.cheekPouch) {
    applyHeal(ctx, state, sideIdx, pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 3)));
  }
  if (!fromCudChew && !fromStealEat && abActive && ab.cudChew) {
    p.cudchewBerry = berryId;
    p.cudchewTurns = 2;
  }
}

function tryChangeAbility(
  ctx: StaticBattleContext,
  state: DynamicState,
  targetSide: 0 | 1,
  targetIdx: number,
  newAbilityId: string
): boolean {
  const sp = ctx.sides[targetSide].team[targetIdx];
  const p = state.sides[targetSide].pokemon[targetIdx];
  if (p.fainted) return false;
  const curAb = activeAbilitySpec(sp, p);
  if (curAb.id === newAbilityId) return false;
  const curFlags = abilityFlags(ctx, curAb.id);
  if (curFlags.cantsuppress) return false;
  p.abilityOverride = newAbilityId;
  p.abilityActive = !p.gastroAcid && newAbilityId !== '';
  return true;
}

function trySkillSwap(
  ctx: StaticBattleContext,
  state: DynamicState,
  s1: 0 | 1,
  i1: number,
  s2: 0 | 1,
  i2: number
): boolean {
  const sp1 = ctx.sides[s1].team[i1];
  const p1 = state.sides[s1].pokemon[i1];
  const sp2 = ctx.sides[s2].team[i2];
  const p2 = state.sides[s2].pokemon[i2];
  if (p1.fainted || p2.fainted) return false;
  const ab1 = activeAbilitySpec(sp1, p1).id;
  const ab2 = activeAbilitySpec(sp2, p2).id;
  if (!ab1 || !ab2 || ab1 === ab2) return false;
  const f1 = abilityFlags(ctx, ab1);
  const f2 = abilityFlags(ctx, ab2);
  if (f1.failskillswap || f2.failskillswap) return false;
  p1.abilityOverride = ab2;
  p2.abilityOverride = ab1;
  p1.abilityActive = !p1.gastroAcid;
  p2.abilityActive = !p2.gastroAcid;
  return true;
}

function tryTransformInto(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number,
  targetSide: 0 | 1,
  targetIdx: number
): boolean {
  const src = state.sides[sideIdx].pokemon[pokeIdx];
  const dst = state.sides[targetSide].pokemon[targetIdx];
  const dstSp = ctx.sides[targetSide].team[targetIdx];
  if (src.fainted || dst.fainted || src.transformed || dst.transformed) return false;
  if (dst.substituteHp > 0 || dst.illusionActive) return false;
  const dstAb = activeAbilitySpec(dstSp, dst);
  const dstStats = activeStats(dstSp, dst);
  const dstMoves = activeMoves(dstSp, dst);
  src.savedPp = src.pp.slice();
  src.pp = dstMoves.map(m => (m.id === 'revivalblessing' ? 1 : 5));
  src.boosts = [dst.boosts[0], dst.boosts[1], dst.boosts[2], dst.boosts[3], dst.boosts[4], dst.boosts[5], dst.boosts[6]];
  src.types = null;
  src.abilityOverride = null;
  src.transformed = {
    speciesId: activeSpeciesId(dstSp, dst),
    types: [...activeTypes(dstSp, dst)],
    weightkg: dstSp.weightkg,
    stats: {...dstStats},
    abilityId: dstAb.id,
    moves: dstMoves,
    sourceSide: targetSide,
    sourceIdx: targetIdx,
  };
  src.abilityActive = !src.gastroAcid && dstAb.id !== '';
  return true;
}

function applyWeatherFormes(ctx: StaticBattleContext, state: DynamicState): void {
  const w = effectiveFieldWeather(ctx, state);
  for (const s of [0, 1] as const) {
    for (const idx of state.sides[s].active) {
      if (idx < 0) continue;
      const sp = ctx.sides[s].team[idx];
      const p = state.sides[s].pokemon[idx];
      if (p.fainted || !p.abilityActive || p.gastroAcid || p.transformed) continue;
      const ab = activeAbilitySpec(sp, p);
      if (ab.forecast && sp.speciesId === 'castform') {
        const nextForme = w === 'sun' ? 'castformsunny' : w === 'rain' ? 'castformrainy' : w === 'snow' ? 'castformsnowy' : null;
        if (nextForme && sp.altFormes[nextForme]) {
          p.formeId = nextForme;
          p.types = null;
        } else if (!nextForme) {
          p.formeId = null;
          p.types = null;
        }
      }
      if (ab.iceFace && sp.speciesId === 'eiscue' && w === 'snow' && p.formeId === 'eiscuenoice') {
        p.formeId = null;
      }
    }
  }
}

function applyTerrainFormes(ctx: StaticBattleContext, state: DynamicState): void {
  const t = state.field.terrain;
  for (const s of [0, 1] as const) {
    for (const idx of state.sides[s].active) {
      if (idx < 0) continue;
      const sp = ctx.sides[s].team[idx];
      const p = state.sides[s].pokemon[idx];
      if (p.fainted || !p.abilityActive || p.gastroAcid) continue;
      if (activeAbilitySpec(sp, p).mimicry) {
        if (t === 'electric') p.types = ['Electric'];
        else if (t === 'grassy') p.types = ['Grass'];
        else if (t === 'misty') p.types = ['Fairy'];
        else if (t === 'psychic') p.types = ['Psychic'];
        else p.types = null;
      }
    }
  }
}

function checkShieldsDown(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1, pokeIdx: number): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || p.transformed || !p.abilityActive || p.gastroAcid) return;
  if (!activeAbilitySpec(sp, p).shieldsDown) return;
  if (!sp.speciesId.startsWith('minior')) return;
  const aboveHalf = p.hp * 2 > sp.maxhp;
  if (aboveHalf && sp.altFormes['miniormeteor']) {
    p.formeId = 'miniormeteor';
  } else if (!aboveHalf) {
    p.formeId = null;
  }
}

function maybeTriggerWhiteHerb(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1, pokeIdx: number): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || !isItemEffectActive(state, sp, p) || activeItemSpec(ctx, sp, p).archetype !== 'white-herb') return;
  let anyNeg = false;
  for (let i = 0; i < 7; i++) {
    if (p.boosts[i] < 0) {
      p.boosts[i] = 0;
      anyNeg = true;
    }
  }
  if (anyNeg) consumeItem(ctx, state, sideIdx, pokeIdx);
}

function maybeTriggerStatusBerry(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1, pokeIdx: number): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || !isItemEffectActive(state, sp, p) || isUnnerved(ctx, state, sideIdx)) return;
  const it = activeItemSpec(ctx, sp, p);
  if (it.archetype !== 'status-berry') return;
  const cures = it.curesStatus;
  const curesConf = (cures === 'confusion' || cures === 'any') && p.confusionTurns > 0;
  const curesStat = p.status !== '' && (cures === 'any' || cures === p.status || (cures === 'psn' && p.status === 'tox'));
  if (curesConf || curesStat) {
    if (curesConf) p.confusionTurns = 0;
    if (curesStat) {
      p.status = '';
      p.statusTurns = 0;
    }
    consumeItem(ctx, state, sideIdx, pokeIdx, true);
  }
}

function maybeTriggerTerrainSeed(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1, pokeIdx: number): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || !isItemEffectActive(state, sp, p)) return;
  const it = activeItemSpec(ctx, sp, p);
  if (it.archetype !== 'terrain-seed' || state.field.terrain !== it.seedTerrain || !it.seedStat) return;
  const idx = BOOST_INDEX[it.seedStat];
  if (p.boosts[idx] < 6) {
    p.boosts[idx] = clampInt(p.boosts[idx] + 1, -6, 6);
    consumeItem(ctx, state, sideIdx, pokeIdx);
  }
}

function applyStatBoost(
  ctx: StaticBattleContext,
  state: DynamicState,
  targetSide: 0 | 1,
  targetIdx: number,
  stat: BoostStat,
  rawDelta: number,
  fromOpponent: boolean,
  moldBreaker = false,
  sourceSide?: 0 | 1,
  sourceIdx?: number,
  allowOpportunist = true
): boolean {
  const p = state.sides[targetSide].pokemon[targetIdx];
  if (p.fainted) return false;
  const sp = ctx.sides[targetSide].team[targetIdx];
  const ab = activeAbilitySpec(sp, p);
  const abActive = p.abilityActive && !moldBreaker;

  let delta = abActive && ab.contrary ? -rawDelta : rawDelta;
  if (abActive && ab.id === 'simple') delta *= 2;
  if (fromOpponent && delta < 0) {
    // Flower Veil protects side's Grass types from opponent stat drops
    if (activeTypes(sp, p).includes('Grass') && !moldBreaker &&
        sideHasActiveAbility(ctx, state, targetSide, a => !!a.flowerVeil)) {
      return false;
    }
    if (abActive) {
      if (ab.clearBody) return false;
      if (ab.hyperCutter && stat === 'atk') return false;
      if (ab.bigPecks && stat === 'def') return false;
      if (ab.mirrorArmor && sourceSide !== undefined && sourceIdx !== undefined && sourceSide !== targetSide) {
        applyStatBoost(ctx, state, sourceSide, sourceIdx, stat, delta, true, false);
        return false;
      }
    }
  }

  const idx = BOOST_INDEX[stat];
  const prev = p.boosts[idx];
  const next = clampInt(prev + delta, -6, 6);
  if (next === prev) return false;
  p.boosts[idx] = next;

  if (delta < 0) {
    p.statLoweredThisTurn = true;
  }

  if (fromOpponent && delta < 0 && p.abilityActive) {
    if (ab.defiant) applyStatBoost(ctx, state, targetSide, targetIdx, 'atk', 2, false);
    if (ab.competitive) applyStatBoost(ctx, state, targetSide, targetIdx, 'spa', 2, false);
  }

  // Opportunist: active opposing Pokemon with Opportunist copies positive stat raises
  if (allowOpportunist && delta > 0) {
    const oppSide: 0 | 1 = targetSide === 0 ? 1 : 0;
    for (const oIdx of state.sides[oppSide].active) {
      if (oIdx < 0) continue;
      const op = state.sides[oppSide].pokemon[oIdx];
      if (!op.fainted && op.abilityActive && activeAbilitySpec(ctx.sides[oppSide].team[oIdx], op).opportunist) {
        applyStatBoost(ctx, state, oppSide, oIdx, stat, delta, false, false, undefined, undefined, false);
      }
    }
  }

  maybeTriggerWhiteHerb(ctx, state, targetSide, targetIdx);
  return true;
}

function setWeather(
  ctx: StaticBattleContext,
  state: DynamicState,
  weather: WeatherId,
  sourceSide: 0 | 1,
  sourceIdx: number
): void {
  if (!weather || state.field.weather === weather) return;
  const sp = ctx.sides[sourceSide].team[sourceIdx];
  const p = state.sides[sourceSide].pokemon[sourceIdx];
  const it = activeItemSpec(ctx, sp, p);
  const extended = isItemEffectActive(state, sp, p) && it.archetype === 'weather-rock' && it.extendedWeather === weather;
  state.field.weather = weather;
  state.field.weatherTurns = extended ? 8 : 5;
  applyWeatherFormes(ctx, state);
}

function setTerrain(
  ctx: StaticBattleContext,
  state: DynamicState,
  terrain: TerrainId,
  sourceSide: 0 | 1,
  sourceIdx: number
): void {
  if (!terrain || state.field.terrain === terrain) return;
  const sp = ctx.sides[sourceSide].team[sourceIdx];
  const p = state.sides[sourceSide].pokemon[sourceIdx];
  const extended = isItemEffectActive(state, sp, p) && activeItemSpec(ctx, sp, p).archetype === 'terrain-extender';
  state.field.terrain = terrain;
  state.field.terrainTurns = extended ? 8 : 5;
  applyTerrainFormes(ctx, state);
  for (const s of [0, 1] as const) {
    for (const idx of state.sides[s].active) {
      if (idx >= 0) maybeTriggerTerrainSeed(ctx, state, s, idx);
    }
  }
}

function applyFixedDamageWithThresholds(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  sideIdx: 0 | 1,
  pokeIdx: number,
  damage: number,
  checkSitrus: boolean,
  policy: BranchPolicy,
  stats: StepStats,
  isIndirect = false
): ActiveBranch[] {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = ab.state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || damage <= 0) return [ab];
  if (isIndirect && p.abilityActive && activeAbilitySpec(sp, p).magicGuard) return [ab];

  const entries = getHpEntries(p);
  const nextEntries: HpEntry[] = entries.map(e => ({
    hp: Math.max(0, e.hp - damage),
    prob: e.prob,
  }));
  setNormalizedHpDist(p, nextEntries);

  const koSplit = splitBranchByHpPredicate(
    {state: ab.state, probability: ab.probability},
    sideIdx,
    pokeIdx,
    hp => hp === 0
  );
  if (koSplit.didSplit) stats.hpSplits++;

  const out: ActiveBranch[] = [];
  if (koSplit.matched) {
    const pk = koSplit.matched.state.sides[sideIdx].pokemon[pokeIdx];
    pk.fainted = true;
    pk.hp = 0;
    pk.hpDist = null;
    pk.substituteHp = 0;
    out.push({
      state: koSplit.matched.state,
      probability: koSplit.matched.probability,
      remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
    });
  }
  if (koSplit.unmatched) {
    const alive: ActiveBranch = {
      state: koSplit.unmatched.state,
      probability: koSplit.unmatched.probability,
      remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
    };
    if (checkSitrus) {
      out.push(...maybeTriggerSitrus(ctx, alive, sideIdx, pokeIdx, stats));
    } else {
      out.push(alive);
    }
  }

  if (policy.mode === 'compute' && out.length > 1) {
    const total = out.reduce((s, x) => s + x.probability, 0);
    const chosen = pickChoices(
      out.map(x => ({item: x, prob: x.probability / total})),
      policy,
      stats
    )[0];
    chosen.item.probability = ab.probability;
    return [chosen.item];
  }
  return out;
}

function maybeTriggerSitrus(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  sideIdx: 0 | 1,
  pokeIdx: number,
  stats: StepStats
): ActiveBranch[] {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = ab.state.sides[sideIdx].pokemon[pokeIdx];
  const isSitrus = sp.itemSpec.archetype === 'sitrus-berry';
  const isOran = sp.itemSpec.archetype === 'oran-berry';
  if (p.fainted || !isItemEffectActive(ab.state, sp, p) || (!isSitrus && !isOran) || isUnnerved(ctx, ab.state, sideIdx)) {
    return [ab];
  }
  const threshold = Math.floor(sp.maxhp / 2);
  if (hpMin(p) > threshold) return [ab];

  const split = splitBranchByHpPredicate(
    {state: ab.state, probability: ab.probability},
    sideIdx,
    pokeIdx,
    hp => hp <= threshold
  );
  if (split.didSplit) stats.hpSplits++;

  const ripenMult = p.abilityActive && activeAbilitySpec(sp, p).ripen ? 2 : 1;
  const healAmt = (isSitrus ? Math.max(1, Math.trunc(sp.maxhp / 4)) : 10) * ripenMult;
  const out: ActiveBranch[] = [];
  if (split.matched) {
    const pk = split.matched.state.sides[sideIdx].pokemon[pokeIdx];
    const healed = getHpEntries(pk).map(e => ({
      hp: Math.min(sp.maxhp, e.hp + healAmt),
      prob: e.prob,
    }));
    setNormalizedHpDist(pk, healed);
    consumeItem(ctx, split.matched.state, sideIdx, pokeIdx, true);
    out.push({
      state: split.matched.state,
      probability: split.matched.probability,
      remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
    });
  }
  if (split.unmatched) {
    out.push({
      state: split.unmatched.state,
      probability: split.unmatched.probability,
      remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
    });
  }
  return out;
}

function applyHeal(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number,
  amount: number
): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || amount <= 0) return;
  const healed = getHpEntries(p).map(e => ({
    hp: Math.min(sp.maxhp, e.hp + amount),
    prob: e.prob,
  }));
  setNormalizedHpDist(p, healed);
}

function triggerEntryAbilities(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  pokeIdx: number
): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  if (p.fainted || !p.abilityActive || p.gastroAcid) return;
  const ab = activeAbilitySpec(sp, p);
  const oppSideIdx: 0 | 1 = sideIdx === 0 ? 1 : 0;

  if (ab.illusion) {
    const hasDisguise = state.sides[sideIdx].pokemon.some((mate, i) => i !== pokeIdx && !mate.fainted);
    p.illusionActive = hasDisguise;
  }
  if (ab.imposter && !p.transformed) {
    const mySlot = state.sides[sideIdx].active.indexOf(pokeIdx);
    const oppActive = state.sides[oppSideIdx].active;
    const oppSlot = Math.max(0, oppActive.length - 1 - Math.max(0, mySlot));
    const oppIdx = oppActive[oppSlot];
    if (oppIdx !== undefined && oppIdx >= 0 && tryTransformInto(ctx, state, sideIdx, pokeIdx, oppSideIdx, oppIdx)) {
      triggerEntryAbilities(ctx, state, sideIdx, pokeIdx);
      return;
    }
  }
  if (ab.forecast || ab.iceFace) {
    applyWeatherFormes(ctx, state);
  }
  if (ab.mimicry) {
    applyTerrainFormes(ctx, state);
  }
  if (ab.shieldsDown) {
    checkShieldsDown(ctx, state, sideIdx, pokeIdx);
  }
  if (ab.setsWeather) {
    setWeather(ctx, state, ab.setsWeather, sideIdx, pokeIdx);
  }
  if (ab.setsTerrain) {
    setTerrain(ctx, state, ab.setsTerrain, sideIdx, pokeIdx);
  }
  if (ab.embodyAspectStat) {
    applyStatBoost(ctx, state, sideIdx, pokeIdx, ab.embodyAspectStat, 1, false);
  }
  if (ab.screenCleaner) {
    for (const s of [0, 1] as const) {
      state.sides[s].reflectTurns = 0;
      state.sides[s].lightScreenTurns = 0;
      state.sides[s].auroraVeilTurns = 0;
    }
  }
  if (ab.curiousMedicine) {
    for (const aIdx of state.sides[sideIdx].active) {
      if (aIdx >= 0 && aIdx !== pokeIdx && !state.sides[sideIdx].pokemon[aIdx].fainted) {
        state.sides[sideIdx].pokemon[aIdx].boosts = [0, 0, 0, 0, 0, 0, 0];
      }
    }
  }
  if (ab.hospitality) {
    for (const aIdx of state.sides[sideIdx].active) {
      if (aIdx >= 0 && aIdx !== pokeIdx && !state.sides[sideIdx].pokemon[aIdx].fainted) {
        const allySp = ctx.sides[sideIdx].team[aIdx];
        applyHeal(ctx, state, sideIdx, aIdx, Math.max(1, Math.trunc(allySp.maxhp / 4)));
      }
    }
  }
  if (ab.supersweetSyrup && !p.abilityUsed) {
    p.abilityUsed = true;
    for (const oppIdx of state.sides[oppSideIdx].active) {
      if (oppIdx < 0) continue;
      const oppPoke = state.sides[oppSideIdx].pokemon[oppIdx];
      if (!oppPoke.fainted && oppPoke.substituteHp === 0) {
        applyStatBoost(ctx, state, oppSideIdx, oppIdx, 'eva', -1, true, false, sideIdx, pokeIdx);
      }
    }
  }
  if (ab.intimidate) {
    for (const oppIdx of state.sides[oppSideIdx].active) {
      if (oppIdx < 0) continue;
      const oppPoke = state.sides[oppSideIdx].pokemon[oppIdx];
      if (oppPoke.fainted || oppPoke.substituteHp > 0) continue;
      const oppAb = activeAbilitySpec(ctx.sides[oppSideIdx].team[oppIdx], oppPoke);
      if (oppPoke.abilityActive && !oppPoke.gastroAcid && oppAb.guardDog) {
        applyStatBoost(ctx, state, oppSideIdx, oppIdx, 'atk', 1, false);
        continue;
      }
      if (oppPoke.abilityActive && !oppPoke.gastroAcid && (oppAb.innerFocus || oppAb.oblivious || oppAb.ownTempo || oppAb.scrappy)) {
        continue;
      }
      applyStatBoost(ctx, state, oppSideIdx, oppIdx, 'atk', -1, true, false, sideIdx, pokeIdx);
      if (oppPoke.abilityActive && !oppPoke.gastroAcid && oppAb.rattled) {
        applyStatBoost(ctx, state, oppSideIdx, oppIdx, 'spe', 1, false);
      }
    }
  }
  maybeTriggerTerrainSeed(ctx, state, sideIdx, pokeIdx);
}

function triggerEntryAbilitiesBranching(
  ctx: StaticBattleContext,
  abBranch: ActiveBranch,
  sideIdx: 0 | 1,
  pokeIdx: number,
  policy: BranchPolicy,
  stats: StepStats
): ActiveBranch[] {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = abBranch.state.sides[sideIdx].pokemon[pokeIdx];
  if (!p.fainted && p.abilityActive && !p.gastroAcid && activeAbilitySpec(sp, p).trace) {
    const oppSide: 0 | 1 = sideIdx === 0 ? 1 : 0;
    const candidates: string[] = [];
    for (const oIdx of abBranch.state.sides[oppSide].active) {
      if (oIdx < 0) continue;
      const op = abBranch.state.sides[oppSide].pokemon[oIdx];
      if (op.fainted) continue;
      const oAbId = activeAbilitySpec(ctx.sides[oppSide].team[oIdx], op).id;
      if (oAbId && !abilityFlags(ctx, oAbId).notrace) {
        candidates.push(oAbId);
      }
    }
    if (candidates.length > 0) {
      const prob = 1 / candidates.length;
      const choices = pickChoices(candidates.map(c => ({item: c, prob})), policy, stats);
      return choices.map(c => {
        const st = choices.length === 1 ? abBranch.state : cloneState(abBranch.state);
        const tp = st.sides[sideIdx].pokemon[pokeIdx];
        tp.abilityOverride = c.item;
        triggerEntryAbilities(ctx, st, sideIdx, pokeIdx);
        return {
          state: st,
          probability: abBranch.probability * c.prob,
          remainingActions: abBranch.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
      });
    }
  }
  triggerEntryAbilities(ctx, abBranch.state, sideIdx, pokeIdx);
  return [abBranch];
}

function resetOnSwitchOut(ctx: StaticBattleContext, state: DynamicState, sideIdx: 0 | 1, pokeIdx: number): void {
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  const p = state.sides[sideIdx].pokemon[pokeIdx];
  const ab = activeAbilitySpec(sp, p);
  const abActive = p.abilityActive && !p.gastroAcid;

  if (abActive && !p.fainted && ab.zeroToHero && sp.speciesId === 'palafin' && p.formeId !== 'palafinhero' && sp.altFormes['palafinhero']) {
    p.formeId = 'palafinhero';
  }
  // Revert non-persistent battle formes on switch-out (keep Palafin-Hero and Eiscue-Noice!)
  if (p.formeId && p.formeId !== 'palafinhero' && p.formeId !== 'eiscuenoice') {
    p.formeId = null;
  }
  if (p.transformed) {
    if (p.savedPp) p.pp = p.savedPp;
    p.transformed = null;
    p.savedPp = null;
  }

  p.boosts = [0, 0, 0, 0, 0, 0, 0];
  p.abilityOverride = null;
  p.gastroAcid = false;
  p.abilityActive = sp.abilityId !== '' || (p.megaEvolved && !!sp.megaForme?.abilityId);
  p.illusionActive = false;
  p.cudchewBerry = '';
  p.cudchewTurns = 0;
  p.confusionTurns = 0;
  p.attractSide = -1;
  p.attractSlot = -1;
  p.magnetRiseTurns = 0;
  p.lockOnTurns = 0;
  p.lockOnSide = -1;
  p.lockOnSlot = -1;
  p.stockpileLayers = 0;
  p.stockpileDef = 0;
  p.stockpileSpd = 0;
  p.powerTrick = false;
  p.statOverride = null;
  p.usedMovesMask = 0;
  p.imprison = false;
  p.octolockSide = -1;
  p.octolockSlot = -1;
  p.uproarTurns = 0;
  p.protectStreak = 0;
  p.protecting = false;
  p.protectKind = '';
  p.enduring = false;
  p.roosted = false;
  p.flinched = false;
  p.mustRecharge = false;
  p.encoreMoveIdx = -1;
  p.encoreTurns = 0;
  p.tauntTurns = 0;
  p.throatChopTurns = 0;
  p.choiceLockedMoveIdx = -1;
  p.disabledMoveIdx = -1;
  p.disabledTurns = 0;
  p.tormented = false;
  p.leechSeedSlot = -1;
  p.yawnTurns = 0;
  p.cursed = false;
  p.perishTurns = 0;
  p.trapped = false;
  p.partialTrapTurns = 0;
  p.aquaRing = false;
  p.ingrain = false;
  p.smackedDown = false;
  p.focusEnergy = false;
  p.dragonCheer = 0;
  p.charged = false;
  p.glaiveRush = false;
  p.syrupBombTurns = 0;
  p.destinyBond = false;
  p.noRetreatUsed = false;
  p.chargingMoveIdx = -1;
  p.lockedMoveIdx = -1;
  p.lockedMoveDuration = 0;
  p.lockedMoveTrueDuration = 0;
  p.invulnerable = '';
  p.substituteHp = 0;
  p.proteanUsed = false;
  p.flashFireActive = false;
  p.unburdenActive = false;
  p.activeTurns = 0;
  p.lastMoveIdx = -1;
  p.lastMoveId = '';
  p.lastMoveFailed = false;
  p.types = null;
  if (abActive && !p.fainted) {
    if (ab.naturalCure) {
      p.status = '';
      p.statusTurns = 0;
    }
    if (ab.regenerator) {
      applyHeal(ctx, state, sideIdx, pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 3)));
    }
  }
}

function performSwitchIn(
  ctx: StaticBattleContext,
  batch: ActiveBranch[],
  sideIdx: 0 | 1,
  slot: number,
  benchIndex: number,
  policy: BranchPolicy,
  stats: StepStats,
  switchMeta?: PendingSwitchSlot
): ActiveBranch[] {
  const nextBatch: ActiveBranch[] = [];
  for (const ab of batch) {
    const side = ab.state.sides[sideIdx];
    const sp = ctx.sides[sideIdx].team[benchIndex];

    // Special case: Revival Blessing revives a fainted bench Pokemon at 50% HP without switching active out
    if (switchMeta?.revive) {
      const target = side.pokemon[benchIndex];
      if (target && target.fainted) {
        target.fainted = false;
        target.hp = Math.max(1, Math.floor(sp.maxhp / 2));
        target.hpDist = null;
        target.status = '';
        target.statusTurns = 0;
      }
      nextBatch.push(ab);
      continue;
    }

    // Cancel any queued move action for the slot that is switching out
    ab.remainingActions = ab.remainingActions.filter(
      ra => !(ra.side === sideIdx && ra.action.slot === slot)
    );

    const prevIdx = side.active[slot];
    let batonState: {
      boosts: [number, number, number, number, number, number, number];
      substituteHp: number;
      leechSeedSlot: number;
      focusEnergy: boolean;
      magnetRiseTurns: number;
      aquaRing: boolean;
      ingrain: boolean;
      powerTrick: boolean;
      perishTurns: number;
      gastroAcid: boolean;
      confusionTurns: number;
      trapped: boolean;
    } | null = null;
    if (switchMeta?.batonPass && prevIdx >= 0 && prevIdx !== benchIndex) {
      const prev = side.pokemon[prevIdx];
      batonState = {
        boosts: [prev.boosts[0], prev.boosts[1], prev.boosts[2], prev.boosts[3], prev.boosts[4], prev.boosts[5], prev.boosts[6]],
        substituteHp: prev.substituteHp,
        leechSeedSlot: prev.leechSeedSlot,
        focusEnergy: prev.focusEnergy,
        magnetRiseTurns: prev.magnetRiseTurns,
        aquaRing: prev.aquaRing,
        ingrain: prev.ingrain,
        powerTrick: prev.powerTrick,
        perishTurns: prev.perishTurns,
        gastroAcid: prev.gastroAcid,
        confusionTurns: prev.confusionTurns,
        trapped: prev.trapped,
      };
    }

    if (prevIdx >= 0 && prevIdx !== benchIndex) {
      resetOnSwitchOut(ctx, ab.state, sideIdx, prevIdx);
    }
    side.active[slot] = benchIndex;
    const incoming = side.pokemon[benchIndex];
    incoming.switchedInThisTurn = true;
    incoming.activeTurns = 0;

    if (batonState) {
      incoming.boosts = batonState.boosts;
      incoming.substituteHp = batonState.substituteHp;
      incoming.leechSeedSlot = batonState.leechSeedSlot;
      incoming.focusEnergy = batonState.focusEnergy;
      incoming.magnetRiseTurns = batonState.magnetRiseTurns;
      incoming.aquaRing = batonState.aquaRing;
      incoming.ingrain = batonState.ingrain;
      incoming.powerTrick = batonState.powerTrick;
      incoming.perishTurns = batonState.perishTurns;
      incoming.confusionTurns = batonState.confusionTurns;
      incoming.trapped = batonState.trapped;
      if (batonState.gastroAcid && !abilityFlags(ctx, activeAbilitySpec(sp, incoming).id).cantsuppress) {
        incoming.gastroAcid = true;
        incoming.abilityActive = false;
      }
    }
    if (switchMeta?.shedTailHp && switchMeta.shedTailHp > 0) {
      incoming.substituteHp = switchMeta.shedTailHp;
    }

    let branches: ActiveBranch[] = [ab];
    const grounded = isGrounded(sp, incoming, ab.state);

    // 0. Healing Wish slot condition
    if (side.healingWish[slot] && !incoming.fainted && (incoming.hp < sp.maxhp || incoming.status !== '')) {
      incoming.hp = sp.maxhp;
      incoming.hpDist = null;
      incoming.status = '';
      incoming.statusTurns = 0;
      side.healingWish[slot] = false;
    }

    // 1. Stealth Rock
    if (side.stealthRock && !incoming.fainted) {
      const eff = typeEffectiveness(ctx, 'Rock', activeTypes(sp, incoming));
      if (!eff.immune) {
        const srDamage = Math.max(1, Math.trunc(sp.maxhp * (2 ** eff.mod) / 8));
        const afterSR: ActiveBranch[] = [];
        for (const b of branches) {
          afterSR.push(...applyFixedDamageWithThresholds(ctx, b, sideIdx, benchIndex, srDamage, true, policy, stats, true));
        }
        branches = afterSR;
      }
    }

    // 2. Spikes (grounded only: 1/8, 1/6, 1/4)
    if (side.spikes > 0 && grounded) {
      const denom = side.spikes === 1 ? 8 : side.spikes === 2 ? 6 : 4;
      const spkDamage = Math.max(1, Math.trunc(sp.maxhp / denom));
      const afterSpk: ActiveBranch[] = [];
      for (const b of branches) {
        if (!b.state.sides[sideIdx].pokemon[benchIndex].fainted) {
          afterSpk.push(...applyFixedDamageWithThresholds(ctx, b, sideIdx, benchIndex, spkDamage, true, policy, stats, true));
        } else {
          afterSpk.push(b);
        }
      }
      branches = afterSpk;
    }

    // 3. Toxic Spikes & Sticky Web (grounded only) + Entry Abilities (with Trace branching)
    const afterEntry: ActiveBranch[] = [];
    for (const b of branches) {
      const inc = b.state.sides[sideIdx].pokemon[benchIndex];
      if (inc.fainted) {
        afterEntry.push(b);
        continue;
      }
      const incTypes = activeTypes(sp, inc);
      if (b.state.sides[sideIdx].toxicSpikes > 0 && grounded) {
        if (incTypes.includes('Poison')) {
          b.state.sides[sideIdx].toxicSpikes = 0;
        } else if (!incTypes.includes('Steel') && inc.status === '') {
          const st: StatusId = b.state.sides[sideIdx].toxicSpikes >= 2 ? 'tox' : 'psn';
          if (canApplyStatus(ctx, b.state, sideIdx, benchIndex, st)) {
            inc.status = st;
            inc.statusTurns = 0;
            maybeTriggerStatusBerry(ctx, b.state, sideIdx, benchIndex);
          }
        }
      }
      if (b.state.sides[sideIdx].stickyWeb && grounded) {
        applyStatBoost(ctx, b.state, sideIdx, benchIndex, 'spe', -1, true);
      }
      afterEntry.push(...triggerEntryAbilitiesBranching(ctx, b, sideIdx, benchIndex, policy, stats));
    }

    nextBatch.push(...afterEntry);
  }
  return mergeActiveBranches(ctx, nextBatch, stats);
}

function resolveTargets(
  ctx: StaticBattleContext,
  state: DynamicState,
  atkSide: 0 | 1,
  atkSlot: number,
  action: MoveAction,
  move: StaticMoveData
): {side: 0 | 1; slot: number; pokeIdx: number}[] {
  const oppSide: 0 | 1 = atkSide === 0 ? 1 : 0;
  const targets: {side: 0 | 1; slot: number; pokeIdx: number}[] = [];

  const isAlive = (s: 0 | 1, sl: number) => {
    const idx = state.sides[s].active[sl];
    return idx >= 0 && !state.sides[s].pokemon[idx].fainted;
  };

  if (move.target === 'self' || move.target === 'allySide') {
    const idx = state.sides[atkSide].active[atkSlot];
    if (idx >= 0 && !state.sides[atkSide].pokemon[idx].fainted) {
      targets.push({side: atkSide, slot: atkSlot, pokeIdx: idx});
    }
    return targets;
  }

  if (move.target === 'foeSide') return targets;

  if (move.target === 'allAdjacentFoes' || move.target === 'allAdjacent') {
    for (let sl = 0; sl < ctx.activeCount; sl++) {
      if (isAlive(oppSide, sl)) {
        targets.push({side: oppSide, slot: sl, pokeIdx: state.sides[oppSide].active[sl]});
      }
    }
    if (move.target === 'allAdjacent' && ctx.activeCount === 2) {
      const allySlot = atkSlot === 0 ? 1 : 0;
      if (isAlive(atkSide, allySlot)) {
        targets.push({side: atkSide, slot: allySlot, pokeIdx: state.sides[atkSide].active[allySlot]});
      }
    }
    if (targets.length > 1) {
      targets.sort((a, b) =>
        effectiveSpeed(ctx, state, b.side, b.pokeIdx) - effectiveSpeed(ctx, state, a.side, a.pokeIdx)
      );
    }
    return targets;
  }

  // Single-target redirection in doubles: Follow Me / Rage Powder / Lightning Rod / Storm Drain
  const preferredSide = action.targetSide ?? oppSide;
  const preferredSlot = action.targetSlot ?? 0;
  const atkIdx = state.sides[atkSide].active[atkSlot];
  const atkStatic = atkIdx >= 0 ? ctx.sides[atkSide].team[atkIdx] : null;
  const atkPoke = atkIdx >= 0 ? state.sides[atkSide].pokemon[atkIdx] : null;
  const atkAb = atkStatic && atkPoke ? activeAbilitySpec(atkStatic, atkPoke) : null;
  const ignoreRedirect = !!(atkPoke?.abilityActive && atkAb?.stalwart);

  if (ctx.activeCount === 2 && preferredSide === oppSide && !ignoreRedirect) {
    const atkImmunePowder = !!(
      atkStatic && atkPoke && (
        activeTypes(atkStatic, atkPoke).includes('Grass') ||
        (atkPoke.abilityActive && atkAb?.overcoat) ||
        (isItemEffectActive(state, atkStatic, atkPoke) && atkStatic.itemSpec.archetype === 'safety-goggles')
      )
    );
    for (let sl = 0; sl < ctx.activeCount; sl++) {
      if (!isAlive(oppSide, sl)) continue;
      const oIdx = state.sides[oppSide].active[sl];
      const op = state.sides[oppSide].pokemon[oIdx];
      if (op.redirectKind === 'followme' || (op.redirectKind === 'ragepowder' && !atkImmunePowder)) {
        targets.push({side: oppSide, slot: sl, pokeIdx: oIdx});
        return targets;
      }
    }
  }

  if (isAlive(preferredSide, preferredSlot)) {
    targets.push({
      side: preferredSide,
      slot: preferredSlot,
      pokeIdx: state.sides[preferredSide].active[preferredSlot],
    });
    return targets;
  }

  if (preferredSide === oppSide) {
    for (let sl = 0; sl < ctx.activeCount; sl++) {
      if (sl !== preferredSlot && isAlive(oppSide, sl)) {
        targets.push({side: oppSide, slot: sl, pokeIdx: state.sides[oppSide].active[sl]});
        return targets;
      }
    }
  }
  return targets;
}

function accuracyProbability(
  ctx: StaticBattleContext,
  state: DynamicState,
  atkSide: 0 | 1,
  atkIdx: number,
  defSide: 0 | 1,
  defIdx: number,
  move: StaticMoveData
): number {
  const atkStatic = ctx.sides[atkSide].team[atkIdx];
  const defStatic = ctx.sides[defSide].team[defIdx];
  const atkPoke = state.sides[atkSide].pokemon[atkIdx];
  const defPoke = state.sides[defSide].pokemon[defIdx];
  const atkAb = activeAbilitySpec(atkStatic, atkPoke);
  const defAb = activeAbilitySpec(defStatic, defPoke);
  const atkAbActive = atkPoke.abilityActive && !atkPoke.gastroAcid;
  const defAbActive = defPoke.abilityActive && !defPoke.gastroAcid;
  const moldBreaker = atkAbActive && !!atkAb.moldBreaker;

  if ((atkAbActive && atkAb.noGuard) || (defAbActive && defAb.noGuard) || defPoke.glaiveRush) {
    return 1;
  }
  const defSlot = state.sides[defSide].active.indexOf(defIdx);
  if (atkPoke.lockOnTurns > 0 && atkPoke.lockOnSide === defSide && atkPoke.lockOnSlot === defSlot) {
    return 1;
  }
  if (move.accuracy === true) return 1;
  // Toxic always hits when used by a Poison-type
  if (move.id === 'toxic' && activeTypes(atkStatic, atkPoke).includes('Poison')) return 1;

  const weather = effectiveFieldWeather(ctx, state);
  const effWeather = (atkAbActive && atkAb.megaSol) ? 'sun' : weather;

  // Weather-dependent accuracy (Thunder / Hurricane / Blizzard)
  let acc = move.accuracy;
  if (move.specialKind === 'weather-acc-rain') {
    if (effWeather === 'rain') return 1;
    if (effWeather === 'sun') acc = 50;
  } else if (move.specialKind === 'weather-acc-snow') {
    if (effWeather === 'snow') return 1;
  }

  if (state.field.gravityTurns > 0) {
    acc = pokeRound(ctx, acc, 5, 3);
  }
  if (atkAbActive) {
    if (atkAb.compoundEyes) acc = pokeRound(ctx, acc, 5325, 4096);
    if (atkAb.hustle && move.category === 'Physical') acc = pokeRound(ctx, acc, 3277, 4096);
  }
  if (defAbActive && !moldBreaker) {
    if (defAb.evasionWeather && weather === defAb.evasionWeather) {
      acc = pokeRound(ctx, acc, 3277, 4096);
    }
    if (defAb.tangledFeet && defPoke.confusionTurns > 0) {
      acc = pokeRound(ctx, acc, 0.5);
    }
  }
  if (isItemEffectActive(state, atkStatic, atkPoke) && activeItemSpec(ctx, atkStatic, atkPoke).archetype === 'wide-lens') {
    acc = pokeRound(ctx, acc, 4505, 4096);
  }
  if (isItemEffectActive(state, defStatic, defPoke) && activeItemSpec(ctx, defStatic, defPoke).archetype === 'bright-powder') {
    acc = pokeRound(ctx, acc, 3686, 4096);
  }

  const stage = clampInt(atkPoke.boosts[5] - defPoke.boosts[6], -6, 6);
  if (stage > 0) acc = Math.floor(acc * (stage + 3) / 3);
  else if (stage < 0) acc = Math.floor(acc * 3 / (3 - stage));
  if (acc >= 100) return 1;
  if (acc <= 0) return 0;
  return acc / 100;
}

function canApplyStatus(
  ctx: StaticBattleContext,
  state: DynamicState,
  targetSide: 0 | 1,
  targetIdx: number,
  status: StatusId,
  moldBreaker = false,
  corrosion = false,
  fromOpponent = true
): boolean {
  if (!status) return false;
  const sp = ctx.sides[targetSide].team[targetIdx];
  const p = state.sides[targetSide].pokemon[targetIdx];
  if (p.fainted || p.status !== '') return false;
  if (fromOpponent && state.sides[targetSide].safeguardTurns > 0) return false;

  // Uproar prevents sleep for all Pokemon on the field
  if (status === 'slp') {
    for (const s of [0, 1] as const) {
      for (const idx of state.sides[s].active) {
        if (idx >= 0 && !state.sides[s].pokemon[idx].fainted && state.sides[s].pokemon[idx].uproarTurns > 0) {
          return false;
        }
      }
    }
  }

  const types = activeTypes(sp, p);
  if (status === 'par' && types.includes('Electric')) return false;
  if (status === 'brn' && types.includes('Fire')) return false;
  if ((status === 'psn' || status === 'tox') && !corrosion && (types.includes('Poison') || types.includes('Steel'))) return false;
  if (status === 'frz' && types.includes('Ice')) return false;

  const grounded = isGrounded(sp, p, state);
  if (grounded && state.field.terrain === 'misty') return false;
  if (grounded && state.field.terrain === 'electric' && status === 'slp') return false;

  if (!moldBreaker) {
    if (status === 'slp' && sideHasActiveAbility(ctx, state, targetSide, a => !!a.sweetVeil)) return false;
    if (fromOpponent && types.includes('Grass') && sideHasActiveAbility(ctx, state, targetSide, a => !!a.flowerVeil)) return false;
  }

  const ab = activeAbilitySpec(sp, p);
  if (p.abilityActive && !p.gastroAcid) {
    if (ab.shieldsDown && activeSpeciesId(sp, p) === 'miniormeteor' && !p.transformed) return false;
  }
  if (p.abilityActive && !p.gastroAcid && !moldBreaker) {
    if (ab.leafGuard && effectiveFieldWeather(ctx, state) === 'sun') return false;
    if (ab.statusImmune) {
      if (ab.statusImmune === 'all') return false;
      if (ab.statusImmune === status || (ab.statusImmune === 'psn' && status === 'tox')) return false;
    }
  }
  return true;
}

function inflictStatusWithBranching(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  targetSide: 0 | 1,
  targetIdx: number,
  status: StatusId,
  policy: BranchPolicy,
  stats: StepStats,
  moldBreaker = false,
  sourceSide?: 0 | 1,
  sourceIdx?: number,
  corrosion = false
): ActiveBranch[] {
  const fromOpp = sourceSide !== undefined ? sourceSide !== targetSide : true;
  if (!canApplyStatus(ctx, ab.state, targetSide, targetIdx, status, moldBreaker, corrosion, fromOpp)) return [ab];

  if (status === 'slp') {
    const sp = ctx.sides[targetSide].team[targetIdx];
    const p = ab.state.sides[targetSide].pokemon[targetIdx];
    const it = activeItemSpec(ctx, sp, p);
    const willCure = isItemEffectActive(ab.state, sp, p) && !isUnnerved(ctx, ab.state, targetSide) &&
      it.archetype === 'status-berry' &&
      (it.curesStatus === 'any' || it.curesStatus === 'slp');
    if (willCure) {
      consumeItem(ctx, ab.state, targetSide, targetIdx, true);
      return [ab];
    }
    const choices = pickChoices(
      ctx.ruleset.sleepDurationWeights.map(w => ({item: w.turns, prob: w.prob})),
      policy,
      stats
    );
    return choices.map(c => {
      const st = choices.length === 1 ? ab.state : cloneState(ab.state);
      const dp = st.sides[targetSide].pokemon[targetIdx];
      dp.status = 'slp';
      dp.statusTurns = c.item;
      return {
        state: st,
        probability: ab.probability * c.prob,
        remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
      };
    });
  }

  const dp = ab.state.sides[targetSide].pokemon[targetIdx];
  const defStatic = ctx.sides[targetSide].team[targetIdx];
  const defAb = activeAbilitySpec(defStatic, dp);
  dp.status = status;
  dp.statusTurns = status === 'frz' ? ctx.ruleset.freezeMaxTurns : 0;
  maybeTriggerStatusBerry(ctx, ab.state, targetSide, targetIdx);

  // Synchronize: reflect brn/par/psn/tox inflicted by opponent back onto opponent
  if (fromOpp && sourceSide !== undefined && sourceIdx !== undefined &&
      dp.abilityActive && !dp.gastroAcid && defAb.synchronize &&
      (status === 'brn' || status === 'par' || status === 'psn' || status === 'tox')) {
    return inflictStatusWithBranching(ctx, ab, sourceSide, sourceIdx, status, policy, stats, false);
  }
  return [ab];
}

function inflictConfusionWithBranching(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  targetSide: 0 | 1,
  targetIdx: number,
  policy: BranchPolicy,
  stats: StepStats,
  moldBreaker = false
): ActiveBranch[] {
  const sp = ctx.sides[targetSide].team[targetIdx];
  const dp = ab.state.sides[targetSide].pokemon[targetIdx];
  if (dp.fainted || dp.confusionTurns > 0) return [ab];
  if (ab.state.sides[targetSide].safeguardTurns > 0) return [ab];
  if (isGrounded(sp, dp, ab.state) && ab.state.field.terrain === 'misty') return [ab];
  const defAb = activeAbilitySpec(sp, dp);
  if (dp.abilityActive && !dp.gastroAcid && !moldBreaker && defAb.ownTempo) return [ab];

  // Persim / Lum Berry immediately cures confusion without branching duration
  const it = activeItemSpec(ctx, sp, dp);
  if (isItemEffectActive(ab.state, sp, dp) && !isUnnerved(ctx, ab.state, targetSide) &&
      it.archetype === 'status-berry' && (it.curesStatus === 'confusion' || it.curesStatus === 'any')) {
    consumeItem(ctx, ab.state, targetSide, targetIdx, true);
    return [ab];
  }

  // Gen 9 / Champions confusion lasts 2..5 turns (uniform 1/4 each; time starts at 2..5)
  const choices = pickChoices(
    [2, 3, 4, 5].map(t => ({item: t, prob: 0.25})),
    policy,
    stats
  );
  return choices.map(c => {
    const st = choices.length === 1 ? ab.state : cloneState(ab.state);
    st.sides[targetSide].pokemon[targetIdx].confusionTurns = c.item;
    return {
      state: st,
      probability: ab.probability * c.prob,
      remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
    };
  });
}

function triggerReceiverOnAllyFaint(
  ctx: StaticBattleContext,
  state: DynamicState,
  faintedSide: 0 | 1,
  faintedIdx: number
): void {
  if (ctx.activeCount < 2) return;
  const fSp = ctx.sides[faintedSide].team[faintedIdx];
  const fPoke = state.sides[faintedSide].pokemon[faintedIdx];
  const fAbId = activeAbilitySpec(fSp, fPoke).id;
  if (!fAbId || abilityFlags(ctx, fAbId).noreceiver) return;
  for (const aIdx of state.sides[faintedSide].active) {
    if (aIdx < 0 || aIdx === faintedIdx) continue;
    const ally = state.sides[faintedSide].pokemon[aIdx];
    const allySp = ctx.sides[faintedSide].team[aIdx];
    if (!ally.fainted && ally.abilityActive && !ally.gastroAcid && activeAbilitySpec(allySp, ally).receiver) {
      ally.abilityOverride = fAbId;
      triggerEntryAbilities(ctx, state, faintedSide, aIdx);
    }
  }
}

function awardKOAbilities(
  ctx: StaticBattleContext,
  state: DynamicState,
  atkSide: 0 | 1,
  atkIdx: number,
  faintedSide?: 0 | 1,
  faintedIdx?: number
): void {
  if (faintedSide !== undefined && faintedIdx !== undefined) {
    triggerReceiverOnAllyFaint(ctx, state, faintedSide, faintedIdx);
  }
  const atkStatic = ctx.sides[atkSide].team[atkIdx];
  const atk = state.sides[atkSide].pokemon[atkIdx];
  if (atk.fainted || !atk.abilityActive || atk.gastroAcid) return;
  const ab = activeAbilitySpec(atkStatic, atk);
  if (ab.moxie) {
    applyStatBoost(ctx, state, atkSide, atkIdx, 'atk', 1, false);
  }
  if (ab.battleBond && !atk.bondTriggered && !atk.transformed &&
      activeSpeciesId(atkStatic, atk) === 'greninjabond') {
    const oppSide: 0 | 1 = atkSide === 0 ? 1 : 0;
    if (state.sides[oppSide].pokemon.some(p => !p.fainted)) {
      applyStatBoost(ctx, state, atkSide, atkIdx, 'atk', 1, false);
      applyStatBoost(ctx, state, atkSide, atkIdx, 'spa', 1, false);
      applyStatBoost(ctx, state, atkSide, atkIdx, 'spe', 1, false);
      atk.bondTriggered = true;
    }
  }
  if (ab.eelevate) {
    // Champions Eelevate: +1 to highest raw stat (excluding HP) on KO
    const stats = activeStats(atkStatic, atk);
    const entries: [BoostStat, number][] = [
      ['atk', stats.atk], ['def', stats.def], ['spa', stats.spa], ['spd', stats.spd], ['spe', stats.spe],
    ];
    let best: BoostStat = 'atk';
    let bestVal = -1;
    for (const [stat, val] of entries) {
      if (val > bestVal) {
        bestVal = val;
        best = stat;
      }
    }
    applyStatBoost(ctx, state, atkSide, atkIdx, best, 1, false);
  }
}

interface HitExecutionOpts {
  isSpread: boolean;
  isFinalHit: boolean;
  bypassProtect: boolean;
  targetSlot: number;
  moveIndex?: number;
  analyticBoost?: boolean;
  fickleDouble?: boolean;
  basePowerOverride?: number;
  categoryOverride?: MoveCategory;
  contactOverride?: boolean;
  flingItemId?: string;
  parentalBondSecondHit?: boolean;
  runSecondariesOnEveryHit?: boolean;
}

function executeSingleHitOnTarget(
  ctx: StaticBattleContext,
  batch: ActiveBranch[],
  atkSide: 0 | 1,
  atkIdx: number,
  targetSide: 0 | 1,
  targetIdx: number,
  move: StaticMoveData,
  hitOpts: HitExecutionOpts,
  damageCache: DamageBatchCache,
  policy: BranchPolicy,
  stats: StepStats,
  defer?: DeferTracker
): {branches: ActiveBranch[]; anyHitLanded: boolean} {
  const {isSpread, isFinalHit, bypassProtect, targetSlot} = hitOpts;
  let current = batch;
  let anyHitLanded = false;
  const atkStatic = ctx.sides[atkSide].team[atkIdx];
  const defStatic = ctx.sides[targetSide].team[targetIdx];

  // 1. Disguise absorb check (first damaging hit breaks Disguise, deals 1/8 chip, 0 direct damage)
  const afterDisguise: ActiveBranch[] = [];
  const needNormalDamage: ActiveBranch[] = [];
  for (const ab of current) {
    const atk = ab.state.sides[atkSide].pokemon[atkIdx];
    const def = ab.state.sides[targetSide].pokemon[targetIdx];
    if (atk.fainted || def.fainted) {
      afterDisguise.push(ab);
      continue;
    }
    const atkAb = activeAbilitySpec(atkStatic, atk);
    const defAb = activeAbilitySpec(defStatic, def);
    const moldBreaker = atk.abilityActive && !!atkAb.moldBreaker;
    const hitSub = def.substituteHp > 0 && !move.bypassSub && !(atk.abilityActive && atkAb.infiltrator);

    if (!hitSub && !moldBreaker && def.abilityActive && !def.gastroAcid && defAb.disguise && !def.disguiseBusted) {
      anyHitLanded = true;
      def.disguiseBusted = true;
      const chip = Math.max(1, Math.trunc(defStatic.maxhp / 8));
      const chipped = applyFixedDamageWithThresholds(ctx, ab, targetSide, targetIdx, chip, true, policy, stats);
      if ((isFinalHit || hitOpts.runSecondariesOnEveryHit) && (move.secondaries.length > 0 || move.specialKind === 'tri-attack') && !(atk.abilityActive && !atk.gastroAcid && atkAb.sheerForce)) {
        for (const c of chipped) {
          afterDisguise.push(...applySecondaries(ctx, c, atkSide, atkIdx, targetSide, targetIdx, move, policy, stats));
        }
      } else {
        afterDisguise.push(...chipped);
      }
      continue;
    }
    // Ice Face: Eiscue absorbs 1 Physical hit (0 damage, no recoil chip) and shifts to Eiscue-Noice
    const effCat = hitOpts.categoryOverride ?? move.category;
    if (!hitSub && !moldBreaker && def.abilityActive && !def.gastroAcid && defAb.iceFace &&
        effCat === 'Physical' && activeSpeciesId(defStatic, def) === 'eiscue' && defStatic.altFormes['eiscuenoice']) {
      anyHitLanded = true;
      def.formeId = 'eiscuenoice';
      if ((isFinalHit || hitOpts.runSecondariesOnEveryHit) && (move.secondaries.length > 0 || move.specialKind === 'tri-attack') && !(atk.abilityActive && !atk.gastroAcid && atkAb.sheerForce)) {
        afterDisguise.push(...applySecondaries(ctx, ab, atkSide, atkIdx, targetSide, targetIdx, move, policy, stats));
      } else {
        afterDisguise.push(ab);
      }
      continue;
    }
    needNormalDamage.push(ab);
  }

  if (needNormalDamage.length === 0) {
    return {branches: afterDisguise, anyHitLanded};
  }

  // 2. Pinch ability split on attacker + Multiscale / Tera Shell full-HP split on defender
  let afterThresholds: {ab: ActiveBranch; pinchActive: boolean; multiscaleActive: boolean; teraShellActive: boolean}[] = [];
  const pinchThreshold = Math.floor(atkStatic.maxhp / 3);
  for (const ab of needNormalDamage) {
    const atk = ab.state.sides[atkSide].pokemon[atkIdx];
    const atkAb = activeAbilitySpec(atkStatic, atk);
    const {type: moveType} = resolveMoveType(ctx, ab.state, atkSide, atkIdx, move);
    const hasPinch = atk.abilityActive && hasPinchBoost(atkAb, moveType);

    let sub: {ab: ActiveBranch; pinchActive: boolean}[] = [];
    if (hasPinch) {
      const split = splitBranchByHpPredicate(
        {state: ab.state, probability: ab.probability},
        atkSide,
        atkIdx,
        hp => hp <= pinchThreshold
      );
      if (split.didSplit) stats.hpSplits++;
      if (split.matched) {
        sub.push({
          ab: {state: split.matched.state, probability: split.matched.probability, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          pinchActive: true,
        });
      }
      if (split.unmatched) {
        sub.push({
          ab: {state: split.unmatched.state, probability: split.unmatched.probability, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          pinchActive: false,
        });
      }
    } else {
      sub.push({ab, pinchActive: false});
    }

    for (const s of sub) {
      const def = s.ab.state.sides[targetSide].pokemon[targetIdx];
      const defAb = activeAbilitySpec(defStatic, def);
      const moldBreaker = atk.abilityActive && !!atkAb.moldBreaker;
      if (def.abilityActive && !moldBreaker && (defAb.multiscale || defAb.teraShell)) {
        const mSplit = splitBranchByHpPredicate(
          {state: s.ab.state, probability: s.ab.probability},
          targetSide,
          targetIdx,
          hp => hp === defStatic.maxhp
        );
        if (mSplit.didSplit) stats.hpSplits++;
        if (mSplit.matched) {
          afterThresholds.push({
            ab: {state: mSplit.matched.state, probability: mSplit.matched.probability, remainingActions: s.ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
            pinchActive: s.pinchActive,
            multiscaleActive: !!defAb.multiscale,
            teraShellActive: !!defAb.teraShell,
          });
        }
        if (mSplit.unmatched) {
          afterThresholds.push({
            ab: {state: mSplit.unmatched.state, probability: mSplit.unmatched.probability, remainingActions: s.ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
            pinchActive: s.pinchActive,
            multiscaleActive: false,
            teraShellActive: false,
          });
        }
      } else {
        afterThresholds.push({ab: s.ab, pinchActive: s.pinchActive, multiscaleActive: false, teraShellActive: false});
      }
    }
  }

  // 3. Crit fork
  const afterCrit: {ab: ActiveBranch; pinchActive: boolean; multiscaleActive: boolean; teraShellActive: boolean; isCrit: boolean}[] = [];
  for (const entry of afterThresholds) {
    const atk = entry.ab.state.sides[atkSide].pokemon[atkIdx];
    const def = entry.ab.state.sides[targetSide].pokemon[targetIdx];
    const atkAb = activeAbilitySpec(atkStatic, atk);
    const defAb = activeAbilitySpec(defStatic, def);
    const moldBreaker = atk.abilityActive && !!atkAb.moldBreaker;

    let critRatio = move.fixedDamage !== null || move.specialKind === 'half-hp' || move.specialKind === 'endeavor' ||
      move.specialKind === 'final-gambit' || move.specialKind === 'ohko' || move.specialKind === 'counter' ||
      move.specialKind === 'mirror-coat' || move.specialKind === 'metal-burst'
      ? 0
      : move.critRatio;
    if (critRatio > 0) {
      if (atk.focusEnergy) critRatio += 2;
      if (atk.dragonCheer > 0) critRatio += atk.dragonCheer;
      if (atk.abilityActive && atkAb.superLuck) critRatio++;
      if (isItemEffectActive(entry.ab.state, atkStatic, atk) && atkStatic.itemSpec.archetype === 'scope-lens') critRatio++;
      if (atk.abilityActive && atkAb.merciless && (def.status === 'psn' || def.status === 'tox')) critRatio = 4;
      if (def.abilityActive && !moldBreaker && defAb.battleArmor) critRatio = 0;
    }
    const critDenom = GEN9_CRIT_DENOM[clampInt(critRatio, 0, 4)];
    if (critDenom === 0) {
      afterCrit.push({...entry, isCrit: false});
    } else if (critDenom === 1) {
      afterCrit.push({...entry, isCrit: true});
    } else {
      const critProb = 1 / critDenom;
      const choices = pickChoices(
        [
          {item: false, prob: 1 - critProb},
          {item: true, prob: critProb},
        ],
        policy,
        stats
      );
      for (const c of choices) {
        const st = choices.length === 1 ? entry.ab.state : cloneState(entry.ab.state);
        afterCrit.push({
          ab: {
            state: st,
            probability: entry.ab.probability * c.prob,
            remainingActions: entry.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
          },
          pinchActive: entry.pinchActive,
          multiscaleActive: entry.multiscaleActive,
          teraShellActive: entry.teraShellActive,
          isCrit: c.item,
        });
      }
    }
  }

  // 4. Batched 16-roll damage lookup + Substitute / Focus Sash / Sturdy / Resist Berry / KO / Hit triggers
  const activeCrit = deferLowProbEntries(afterCrit, defer);
  const hasJointCoupling = move.recoil !== null || move.drain !== null;
  const afterDamage: ActiveBranch[] = [];

  for (const entry of activeCrit) {
    const {ab, pinchActive, multiscaleActive, teraShellActive, isCrit} = entry;
    const atk = ab.state.sides[atkSide].pokemon[atkIdx];
    const def = ab.state.sides[targetSide].pokemon[targetIdx];
    const atkAb = activeAbilitySpec(atkStatic, atk);
    const defAb = activeAbilitySpec(defStatic, def);
    const moldBreaker = atk.abilityActive && !!atkAb.moldBreaker;

    // Check Resist Berry applicability
    const {type: effMoveType} = resolveMoveType(ctx, ab.state, atkSide, atkIdx, move);
    const effCheck = typeEffectiveness(ctx, effMoveType, activeTypes(defStatic, def), atk.abilityActive && !!atkAb.scrappy, move.specialKind);
    if (effCheck.immune) {
      afterDamage.push(ab);
      continue;
    }
    const effTypeMod = teraShellActive && def.abilityActive && !moldBreaker && defAb.teraShell ? -1 : effCheck.mod;
    const defItemSpecNow = activeItemSpec(ctx, defStatic, def);
    const resistBerryActive =
      isItemEffectActive(ab.state, defStatic, def) &&
      !isUnnerved(ctx, ab.state, targetSide) &&
      defItemSpecNow.archetype === 'resist-berry' &&
      defItemSpecNow.affectedType === effMoveType &&
      (effTypeMod > 0 || effMoveType === 'Normal');

    // Special direct HP moves (Super Fang / Endeavor / Final Gambit / OHKO / Counter / Mirror Coat / Metal Burst)
    let rolls: readonly number[];
    if (move.specialKind === 'ohko') {
      rolls = [defStatic.maxhp];
    } else if (move.specialKind === 'counter') {
      if (atk.damagedThisTurn <= 0 || atk.damagedCategory !== 'Physical') {
        afterDamage.push(ab);
        continue;
      }
      rolls = [atk.damagedThisTurn * 2];
    } else if (move.specialKind === 'mirror-coat') {
      if (atk.damagedThisTurn <= 0 || atk.damagedCategory !== 'Special') {
        afterDamage.push(ab);
        continue;
      }
      rolls = [atk.damagedThisTurn * 2];
    } else if (move.specialKind === 'metal-burst') {
      if (atk.damagedThisTurn <= 0) {
        afterDamage.push(ab);
        continue;
      }
      rolls = [Math.max(1, Math.floor(atk.damagedThisTurn * 1.5))];
    } else if (move.specialKind === 'half-hp') {
      rolls = [Math.max(1, Math.floor(def.hp / 2))];
    } else if (move.specialKind === 'endeavor') {
      if (def.hp <= atk.hp) {
        afterDamage.push(ab);
        continue;
      }
      rolls = [def.hp - atk.hp];
    } else if (move.specialKind === 'final-gambit') {
      rolls = [atk.hp];
    } else {
      const dmgRes = damageCache.getOrCompute(
        ctx,
        ab.state,
        atkSide,
        atkIdx,
        targetSide,
        targetIdx,
        move,
        {
          isCrit,
          isSpread,
          pinchActive,
          multiscaleActive,
          bypassProtect,
          resistBerryActive,
          analyticBoost: hitOpts.analyticBoost,
          fickleDouble: hitOpts.fickleDouble,
          basePowerOverride: hitOpts.basePowerOverride,
          categoryOverride: hitOpts.categoryOverride,
          contactOverride: hitOpts.contactOverride,
          parentalBondSecondHit: hitOpts.parentalBondSecondHit,
          teraShellActive,
        }
      );
      if (dmgRes.immune || dmgRes.rolls.length === 0) {
        afterDamage.push(ab);
        continue;
      }
      rolls = dmgRes.rolls;
    }

    anyHitLanded = true;
    const rollProb = 1 / rolls.length;

    // Consume Charge once Electric attack hits
    if (atk.charged && effMoveType === 'Electric' && isFinalHit) {
      atk.charged = false;
    }

    // Consume resist berry & Normal Gem once triggered
    if (resistBerryActive) consumeItem(ctx, ab.state, targetSide, targetIdx, true);
    if (isItemEffectActive(ab.state, atkStatic, atk) && activeItemSpec(ctx, atkStatic, atk).archetype === 'normal-gem' && effMoveType === 'Normal') {
      consumeItem(ctx, ab.state, atkSide, atkIdx);
    }

    // Substitute absorbs damage if active and not bypassed
    const hitSub = def.substituteHp > 0 && !move.bypassSub && !(atk.abilityActive && atkAb.infiltrator);
    if (hitSub) {
      const grouped = new Map<number, number>();
      for (const d of rolls) {
        const rem = Math.max(0, def.substituteHp - d);
        grouped.set(rem, (grouped.get(rem) ?? 0) + rollProb);
      }
      const choices = pickChoices([...grouped.entries()].map(([rem, prob]) => ({item: rem, prob})), policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? ab.state : cloneState(ab.state);
        st.sides[targetSide].pokemon[targetIdx].substituteHp = c.item;
        // Ceaseless Edge / Stone Axe / Ice Spinner / Steel Roller trigger even on Sub!
        if (isFinalHit) {
          if (move.specialKind === 'ceaseless-edge') {
            st.sides[targetSide].spikes = Math.min(3, st.sides[targetSide].spikes + 1);
          } else if (move.specialKind === 'stone-axe') {
            st.sides[targetSide].stealthRock = true;
          } else if (move.specialKind === 'ice-spinner' || move.specialKind === 'steel-roller') {
            st.field.terrain = '';
            st.field.terrainTurns = 0;
          }
        }
        afterDamage.push({
          state: st,
          probability: ab.probability * c.prob,
          remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}})),
        });
      }
      continue;
    }

    // Track pre-hit HP for Berserk, Emergency Exit & Innards Out
    const defPreHpMax = hpMax(def);
    const berserkEligible = def.abilityActive && !def.gastroAcid && !moldBreaker && !!defAb.berserk && defPreHpMax > Math.floor(defStatic.maxhp / 2);
    const emergencyExitEligible = def.abilityActive && !def.gastroAcid && !moldBreaker && !!defAb.emergencyExit && defPreHpMax > Math.floor(defStatic.maxhp / 2) && legalBenchSwitches(ab.state.sides[targetSide]).length > 0;
    const halfThresholdEligible = berserkEligible || emergencyExitEligible;
    const innardsEligible = def.abilityActive && !def.gastroAcid && !moldBreaker && !!defAb.innardsOut;
    const preHpForInnards = def.hp;

    // Focus Sash / Sturdy check (survive fatal hit from full HP at 1 HP)
    const hasSash = isItemEffectActive(ab.state, defStatic, def) && activeItemSpec(ctx, defStatic, def).archetype === 'focus-sash';
    const hasSturdy = def.abilityActive && !def.gastroAcid && !moldBreaker && !!defAb.sturdy;
    const canSurviveAt1 = (hasSash || hasSturdy) && hpMax(def) === defStatic.maxhp;

    const preDamageBranches: {ab: ActiveBranch; atFullHp: boolean; wasAboveHalf: boolean}[] = [];
    if (canSurviveAt1) {
      const sashSplit = splitBranchByHpPredicate(
        {state: ab.state, probability: ab.probability},
        targetSide,
        targetIdx,
        hp => hp === defStatic.maxhp
      );
      if (sashSplit.didSplit) stats.hpSplits++;
      if (sashSplit.matched) {
        preDamageBranches.push({
          ab: {state: sashSplit.matched.state, probability: sashSplit.matched.probability, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          atFullHp: true,
          wasAboveHalf: true,
        });
      }
      if (sashSplit.unmatched) {
        preDamageBranches.push({
          ab: {state: sashSplit.unmatched.state, probability: sashSplit.unmatched.probability, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          atFullHp: false,
          wasAboveHalf: hpMin(sashSplit.unmatched.state.sides[targetSide].pokemon[targetIdx]) > Math.floor(defStatic.maxhp / 2),
        });
      }
    } else if (halfThresholdEligible && hpMin(def) <= Math.floor(defStatic.maxhp / 2)) {
      const half = Math.floor(defStatic.maxhp / 2);
      const bSplit = splitBranchByHpPredicate({state: ab.state, probability: ab.probability}, targetSide, targetIdx, hp => hp > half);
      if (bSplit.didSplit) stats.hpSplits++;
      if (bSplit.matched) {
        preDamageBranches.push({
          ab: {state: bSplit.matched.state, probability: bSplit.matched.probability, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          atFullHp: false,
          wasAboveHalf: true,
        });
      }
      if (bSplit.unmatched) {
        preDamageBranches.push({
          ab: {state: bSplit.unmatched.state, probability: bSplit.unmatched.probability, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          atFullHp: false,
          wasAboveHalf: false,
        });
      }
    } else {
      preDamageBranches.push({ab, atFullHp: false, wasAboveHalf: hpMin(def) > Math.floor(defStatic.maxhp / 2)});
    }

    const liquidOoze = def.abilityActive && !moldBreaker && !!defAb.liquidOoze;

    for (const pre of preDamageBranches) {
      const targetBranches: ActiveBranch[] = [];
      const targetPoke = pre.ab.state.sides[targetSide].pokemon[targetIdx];
      const rockHead = atk.abilityActive && !!atkAb.rockHead;

      if (hasJointCoupling) {
        const defReadsExactDamage = pokeReadsExactDamage(defStatic);
        const hpEntries = getHpEntries(targetPoke);
        const atkPoke = pre.ab.state.sides[atkSide].pokemon[atkIdx];
        const maxPossibleHeal = !atkPoke.fainted ? Math.max(0, atkStatic.maxhp - hpMin(atkPoke)) : 0;

        if (!defReadsExactDamage && policy.mode !== 'compute') {
          const grouped = new Map<string, {
            atkDelta: number;
            sashUsed: boolean;
            isKo: boolean;
            dealt: number;
            prob: number;
            defHpMap: Map<number, number>;
          }>();
          for (const he of hpEntries) {
            for (const d of rolls) {
              let dealt = Math.min(he.hp, d);
              let newDefHp = he.hp - dealt;
              let sashUsed = false;
              if ((pre.atFullHp || targetPoke.enduring) && d >= he.hp && (targetPoke.enduring || he.hp === defStatic.maxhp)) {
                dealt = he.hp - 1;
                newDefHp = 1;
                sashUsed = !targetPoke.enduring && !hasSturdy && hasSash;
              }
              let atkDelta = 0;
              if (move.recoil && !rockHead) {
                atkDelta = -Math.max(1, Math.round(dealt * move.recoil[0] / move.recoil[1]));
              } else if (move.drain) {
                let heal = Math.max(1, Math.round(dealt * move.drain[0] / move.drain[1]));
                if (isItemEffectActive(pre.ab.state, atkStatic, atk) && atkStatic.itemSpec.archetype === 'big-root') {
                  heal = pokeRound(ctx, heal, 5324, 4096);
                }
                atkDelta = liquidOoze ? -heal : Math.min(maxPossibleHeal, heal);
              }
              const isKo = newDefHp <= 0;
              const gKey = `${atkDelta}:${sashUsed ? 1 : 0}:${isKo ? 1 : 0}`;
              const p = he.prob * rollProb;
              let prev = grouped.get(gKey);
              if (!prev) {
                prev = {atkDelta, sashUsed, isKo, dealt, prob: p, defHpMap: new Map([[newDefHp, p]])};
                grouped.set(gKey, prev);
              } else {
                prev.prob += p;
                if (dealt > prev.dealt) prev.dealt = dealt;
                prev.defHpMap.set(newDefHp, (prev.defHpMap.get(newDefHp) ?? 0) + p);
              }
            }
          }
          const groups = [...grouped.values()];
          const choices = pickChoices(
            groups.map(g => ({item: g, prob: g.prob})),
            policy,
            stats
          );
          for (const c of choices) {
            const st = choices.length === 1 ? pre.ab.state : cloneState(pre.ab.state);
            const dp = st.sides[targetSide].pokemon[targetIdx];
            if (c.item.isKo) {
              dp.hp = 0;
              dp.hpDist = null;
              dp.fainted = true;
            } else {
              dp.fainted = false;
              const entries: HpEntry[] = [];
              for (const [hp, w] of c.item.defHpMap) {
                entries.push({hp, prob: w / c.item.prob});
              }
              setNormalizedHpDist(dp, entries);
            }
            dp.damagedThisTurn = c.item.dealt;
            dp.damagedCategory = move.category === 'Physical' ? 'Physical' : 'Special';
            dp.damagedBySide = atkSide;
            dp.damagedBySlot = targetSlot;
            dp.timesAttacked++;
            if (c.item.sashUsed) consumeItem(ctx, st, targetSide, targetIdx);
            let sub: ActiveBranch[] = [{
              state: st,
              probability: pre.ab.probability * c.prob,
              remainingActions: pre.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
            }];
            if (c.item.atkDelta < 0) {
              sub = applyFixedDamageWithThresholds(ctx, sub[0], atkSide, atkIdx, -c.item.atkDelta, true, policy, stats, liquidOoze);
            } else if (c.item.atkDelta > 0) {
              applyHeal(ctx, st, atkSide, atkIdx, c.item.atkDelta);
            }
            targetBranches.push(...sub);
          }
        } else {
          const grouped = new Map<string, {newDefHp: number; dealt: number; atkDelta: number; prob: number; sashUsed: boolean}>();
          for (const he of hpEntries) {
            for (const d of rolls) {
              let dealt = Math.min(he.hp, d);
              let newDefHp = he.hp - dealt;
              let sashUsed = false;
              if ((pre.atFullHp || targetPoke.enduring) && d >= he.hp && (targetPoke.enduring || he.hp === defStatic.maxhp)) {
                dealt = he.hp - 1;
                newDefHp = 1;
                sashUsed = !targetPoke.enduring && !hasSturdy && hasSash;
              }
              let atkDelta = 0;
              if (move.recoil && !rockHead) {
                atkDelta = -Math.max(1, Math.round(dealt * move.recoil[0] / move.recoil[1]));
              } else if (move.drain) {
                let heal = Math.max(1, Math.round(dealt * move.drain[0] / move.drain[1]));
                if (isItemEffectActive(pre.ab.state, atkStatic, atk) && atkStatic.itemSpec.archetype === 'big-root') {
                  heal = pokeRound(ctx, heal, 5324, 4096);
                }
                atkDelta = liquidOoze ? -heal : heal;
              }
              const gKey = `${newDefHp}:${atkDelta}:${sashUsed ? 1 : 0}`;
              const prev = grouped.get(gKey);
              const p = he.prob * rollProb;
              if (prev) prev.prob += p;
              else grouped.set(gKey, {newDefHp, dealt, atkDelta, prob: p, sashUsed});
            }
          }
          const choices = pickChoices(
            [...grouped.values()].map(g => ({item: g, prob: g.prob})),
            policy,
            stats
          );
          for (const c of choices) {
            const st = cloneState(pre.ab.state);
            const dp = st.sides[targetSide].pokemon[targetIdx];
            dp.hp = c.item.newDefHp;
            dp.hpDist = null;
            dp.fainted = dp.hp <= 0;
            dp.damagedThisTurn = c.item.dealt;
            dp.damagedCategory = move.category === 'Physical' ? 'Physical' : 'Special';
            dp.damagedBySide = atkSide;
            dp.damagedBySlot = targetSlot;
            dp.timesAttacked++;
            if (c.item.sashUsed) consumeItem(ctx, st, targetSide, targetIdx);
            let sub: ActiveBranch[] = [{
              state: st,
              probability: pre.ab.probability * c.prob,
              remainingActions: pre.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
            }];
            if (c.item.atkDelta < 0) {
              sub = applyFixedDamageWithThresholds(ctx, sub[0], atkSide, atkIdx, -c.item.atkDelta, true, policy, stats, liquidOoze);
            } else if (c.item.atkDelta > 0) {
              applyHeal(ctx, st, atkSide, atkIdx, c.item.atkDelta);
            }
            targetBranches.push(...sub);
          }
        }
      } else if (pre.atFullHp) {
        const normalEntries: HpEntry[] = [];
        let normalProb = 0;
        let sashProb = 0;
        for (const d of rolls) {
          if (d >= defStatic.maxhp) {
            sashProb += rollProb;
          } else {
            normalEntries.push({hp: defStatic.maxhp - d, prob: rollProb});
            normalProb += rollProb;
          }
        }
        const choices: {item: 'sash' | 'normal'; prob: number}[] = [];
        if (normalProb > EPS) choices.push({item: 'normal', prob: normalProb});
        if (sashProb > EPS) choices.push({item: 'sash', prob: sashProb});
        const picked = pickChoices(choices, policy, stats);
        for (const c of picked) {
          const st = picked.length === 1 ? pre.ab.state : cloneState(pre.ab.state);
          const dp = st.sides[targetSide].pokemon[targetIdx];
          dp.timesAttacked++;
          dp.damagedCategory = move.category === 'Physical' ? 'Physical' : 'Special';
          dp.damagedBySide = atkSide;
          dp.damagedBySlot = targetSlot;
          if (c.item === 'sash') {
            dp.damagedThisTurn = defStatic.maxhp - 1;
            dp.hp = 1;
            dp.hpDist = null;
            dp.fainted = false;
            if (!hasSturdy && hasSash) consumeItem(ctx, st, targetSide, targetIdx);
          } else {
            dp.damagedThisTurn = rolls[rolls.length - 1];
            setNormalizedHpDist(dp, normalEntries);
          }
          targetBranches.push({
            state: st,
            probability: pre.ab.probability * c.prob,
            remainingActions: pre.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
          });
        }
      } else {
        // If Counter/Mirror Coat/Metal Burst could read exact damage, track per-roll damage when defender has one of those moves
        const defReadsExactDamage = defStatic.moves.some(m =>
          m.specialKind === 'counter' || m.specialKind === 'mirror-coat' || m.specialKind === 'metal-burst'
        );
        const hpEntries = getHpEntries(targetPoke);
        const minHp = targetPoke.enduring ? 1 : 0;
        if (defReadsExactDamage && policy.mode !== 'compute' && rolls.length > 1) {
          const grouped = new Map<string, {newHp: number; dealt: number; prob: number}>();
          for (const he of hpEntries) {
            for (const d of rolls) {
              const newHp = Math.max(minHp, he.hp - d);
              const dealt = he.hp - newHp;
              const gk = `${newHp}:${dealt}`;
              const prev = grouped.get(gk);
              const pr = he.prob * rollProb;
              if (prev) prev.prob += pr;
              else grouped.set(gk, {newHp, dealt, prob: pr});
            }
          }
          for (const g of grouped.values()) {
            const st = cloneState(pre.ab.state);
            const dp = st.sides[targetSide].pokemon[targetIdx];
            dp.hp = g.newHp;
            dp.hpDist = null;
            dp.fainted = g.newHp <= 0;
            dp.timesAttacked++;
            dp.damagedThisTurn = g.dealt;
            dp.damagedCategory = move.category === 'Physical' ? 'Physical' : 'Special';
            dp.damagedBySide = atkSide;
            dp.damagedBySlot = targetSlot;
            targetBranches.push({
              state: st,
              probability: pre.ab.probability * g.prob,
              remainingActions: pre.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
            });
          }
        } else {
          const nextEntries: HpEntry[] = [];
          if (policy.mode === 'compute') {
            const rng = policy.rng ?? Math.random;
            const rIdx = Math.min(rolls.length - 1, Math.floor(rng() * rolls.length));
            const d = rolls[rIdx];
            for (const he of hpEntries) {
              nextEntries.push({hp: Math.max(minHp, he.hp - d), prob: he.prob});
            }
            targetPoke.damagedThisTurn = Math.min(targetPoke.hp, d);
          } else {
            for (const he of hpEntries) {
              for (const d of rolls) {
                nextEntries.push({hp: Math.max(minHp, he.hp - d), prob: he.prob * rollProb});
              }
            }
            targetPoke.damagedThisTurn = rolls[0];
          }
          targetPoke.timesAttacked++;
          targetPoke.damagedCategory = move.category === 'Physical' ? 'Physical' : 'Special';
          targetPoke.damagedBySide = atkSide;
          targetPoke.damagedBySlot = targetSlot;
          setNormalizedHpDist(targetPoke, nextEntries);
          targetBranches.push(pre.ab);
        }
      }

      // Split KO vs surviving, then apply hit triggers
      for (const tb of targetBranches) {
        const koSplit = splitBranchByHpPredicate(
          {state: tb.state, probability: tb.probability},
          targetSide,
          targetIdx,
          hp => hp === 0
        );
        if (koSplit.didSplit) stats.hpSplits++;

        const postKo: ActiveBranch[] = [];
        if (koSplit.matched) {
          const pk = koSplit.matched.state.sides[targetSide].pokemon[targetIdx];
          const wasDestinyBond = pk.destinyBond;
          pk.fainted = true;
          pk.hp = 0;
          pk.hpDist = null;
          let koBranches: ActiveBranch[] = [{
            state: koSplit.matched.state,
            probability: koSplit.matched.probability,
            remainingActions: tb.remainingActions.map(a => ({...a, action: {...a.action}})),
          }];

          // On-hit side/field effects that still trigger on KO (Ceaseless Edge, Stone Axe, Ice Spinner, Steel Roller, Toxic Debris)
          for (const b of koBranches) {
            if (isFinalHit) {
              if (move.specialKind === 'ceaseless-edge') b.state.sides[targetSide].spikes = Math.min(3, b.state.sides[targetSide].spikes + 1);
              else if (move.specialKind === 'stone-axe') b.state.sides[targetSide].stealthRock = true;
              else if (move.specialKind === 'ice-spinner' || move.specialKind === 'steel-roller') {
                b.state.field.terrain = '';
                b.state.field.terrainTurns = 0;
              }
            }
            const dAbKo = activeAbilitySpec(defStatic, b.state.sides[targetSide].pokemon[targetIdx]);
            if (b.state.sides[targetSide].pokemon[targetIdx].abilityActive && dAbKo.toxicDebris && move.category === 'Physical') {
              b.state.sides[atkSide].toxicSpikes = Math.min(2, b.state.sides[atkSide].toxicSpikes + 1);
            }
          }

          // Contact damage on KO (Rough Skin / Iron Barbs + Rocky Helmet + Aftermath + Beak Blast + Cute Charm + Mummy + Wandering Spirit)
          koBranches = applyContactPunish(ctx, koBranches, atkSide, atkIdx, targetSide, targetIdx, move, true, policy, stats, hitOpts.contactOverride);

          // Innards Out: deals remaining HP before hit to attacker
          if (innardsEligible && preHpForInnards > 0) {
            const nextIo: ActiveBranch[] = [];
            for (const b of koBranches) {
              const out = applyFixedDamageWithThresholds(ctx, b, atkSide, atkIdx, preHpForInnards, true, policy, stats, true);
              for (const r of out) {
                checkEnded(r.state, targetSide);
                nextIo.push(r);
              }
            }
            koBranches = nextIo;
          }

          // Destiny Bond: takes attacker down with it
          if (wasDestinyBond && targetSide !== atkSide) {
            for (const b of koBranches) {
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              if (!ap.fainted) {
                ap.hp = 0;
                ap.hpDist = null;
                ap.fainted = true;
                checkEnded(b.state, targetSide);
              }
            }
          }

          // Cursed Body triggers 30% disable even when defender is KO'd!
          {
            const nextCbKo: ActiveBranch[] = [];
            for (const b of koBranches) {
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              const dAb = activeAbilitySpec(defStatic, dp);
              const moveIdx = hitOpts.moveIndex ?? ap.lastMoveIdx;
              const aromaBlocked = sideHasActiveAbility(ctx, b.state, atkSide, a => !!a.aromaVeil);
              if (dp.abilityActive && !dp.gastroAcid && dAb.cursedBody && !ap.fainted &&
                  ap.disabledTurns === 0 && moveIdx >= 0 && move.id !== 'struggle' && !aromaBlocked) {
                const choices = pickChoices([{item: false, prob: 0.7}, {item: true, prob: 0.3}], policy, stats);
                for (const c of choices) {
                  const st = choices.length === 1 ? b.state : cloneState(b.state);
                  if (c.item) {
                    st.sides[atkSide].pokemon[atkIdx].disabledMoveIdx = moveIdx;
                    st.sides[atkSide].pokemon[atkIdx].disabledTurns = 4;
                  }
                  nextCbKo.push({state: st, probability: b.probability * c.prob, remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}}))});
                }
              } else {
                nextCbKo.push(b);
              }
            }
            koBranches = nextCbKo;
          }

          // KO attacker rewards (Moxie, Battle Bond, Eelevate, Fell Stinger +3 Atk, Receiver on ally faint)
          for (const b of koBranches) {
            b.state.sides[targetSide].pokemon[targetIdx].illusionActive = false;
            awardKOAbilities(ctx, b.state, atkSide, atkIdx, targetSide, targetIdx);
            if (move.specialKind === 'fell-stinger' && !b.state.sides[atkSide].pokemon[atkIdx].fainted) {
              applyStatBoost(ctx, b.state, atkSide, atkIdx, 'atk', 3, false);
            }
          }
          postKo.push(...koBranches);
        }

        if (koSplit.unmatched) {
          let surv: ActiveBranch[] = [{
            state: koSplit.unmatched.state,
            probability: koSplit.unmatched.probability,
            remainingActions: tb.remainingActions.map(a => ({...a, action: {...a.action}})),
          }];

          // Clear Illusion & break Focus Punch focus on any damaging hit
          for (const b of surv) {
            const dp = b.state.sides[targetSide].pokemon[targetIdx];
            dp.illusionActive = false;
            if (dp.focusPunchReady) dp.focusPunchLost = true;
          }

          // Pop Air Balloon on damaging hit
          for (const b of surv) {
            const dp = b.state.sides[targetSide].pokemon[targetIdx];
            if (dp.itemActive && isItemEffectActive(b.state, defStatic, dp) && activeItemSpec(ctx, defStatic, dp).archetype === 'air-balloon') {
              consumeItem(ctx, b.state, targetSide, targetIdx);
            }
          }

          // Defender onDamagingHit abilities (Stamina, Weak Armor, Justified, Anger Point, Electromorphosis, Rattled, Thermal Exchange, Sand Spit, Seed Sower, Toxic Debris)
          const effCatNow = hitOpts.categoryOverride ?? move.category;
          for (const b of surv) {
            const dp = b.state.sides[targetSide].pokemon[targetIdx];
            if (!dp.abilityActive || dp.gastroAcid) continue;
            const dAb = activeAbilitySpec(defStatic, dp);
            if (dAb.stamina) applyStatBoost(ctx, b.state, targetSide, targetIdx, 'def', 1, false);
            if (dAb.weakArmor && effCatNow === 'Physical') {
              applyStatBoost(ctx, b.state, targetSide, targetIdx, 'def', -1, false);
              applyStatBoost(ctx, b.state, targetSide, targetIdx, 'spe', 2, false);
            }
            if (dAb.justified && effMoveType === 'Dark') {
              applyStatBoost(ctx, b.state, targetSide, targetIdx, 'atk', 1, false);
            }
            if (dAb.angerPoint && isCrit) {
              dp.boosts[0] = 6;
            }
            if (dAb.electromorphosis) {
              dp.charged = true;
            }
            if (dAb.rattled && (effMoveType === 'Bug' || effMoveType === 'Dark' || effMoveType === 'Ghost')) {
              applyStatBoost(ctx, b.state, targetSide, targetIdx, 'spe', 1, false);
            }
            if (dAb.thermalExchange && effMoveType === 'Fire') {
              applyStatBoost(ctx, b.state, targetSide, targetIdx, 'atk', 1, false);
            }
            if (dAb.sandSpit) setWeather(ctx, b.state, 'sand', targetSide, targetIdx);
            if (dAb.seedSower) setTerrain(ctx, b.state, 'grassy', targetSide, targetIdx);
            if (dAb.toxicDebris && effCatNow === 'Physical') {
              b.state.sides[atkSide].toxicSpikes = Math.min(2, b.state.sides[atkSide].toxicSpikes + 1);
            }
          }

          // Gulp Missile: Cramorant in Gulping/Gorging spits prey (1/4 maxHP + Def -1 or Paralyze) and reverts
          {
            const nextGm: ActiveBranch[] = [];
            for (const b of surv) {
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              const dSpId = activeSpeciesId(defStatic, dp);
              if (!ap.fainted && !dp.invulnerable && dp.abilityActive && !dp.gastroAcid &&
                  activeAbilitySpec(defStatic, dp).gulpMissile &&
                  (dSpId === 'cramorantgulping' || dSpId === 'cramorantgorging')) {
                dp.formeId = null;
                const gmDmg = Math.max(1, Math.trunc(atkStatic.maxhp / 4));
                const chipped = applyFixedDamageWithThresholds(ctx, b, atkSide, atkIdx, gmDmg, true, policy, stats, true);
                for (const c of chipped) {
                  if (!c.state.sides[atkSide].pokemon[atkIdx].fainted) {
                    if (dSpId === 'cramorantgulping') {
                      applyStatBoost(ctx, c.state, atkSide, atkIdx, 'def', -1, true, false, targetSide, targetIdx);
                      nextGm.push(c);
                    } else {
                      nextGm.push(...inflictStatusWithBranching(ctx, c, atkSide, atkIdx, 'par', policy, stats, false, targetSide, targetIdx));
                    }
                  } else {
                    checkEnded(c.state, targetSide);
                    nextGm.push(c);
                  }
                }
              } else {
                nextGm.push(b);
              }
            }
            surv = nextGm;
          }

          // Berserk & Emergency Exit: if defender was > 50% HP before hit and is now <= 50% HP!
          if (halfThresholdEligible && pre.wasAboveHalf) {
            const half = Math.floor(defStatic.maxhp / 2);
            const nextHalf: ActiveBranch[] = [];
            for (const b of surv) {
              const split = splitBranchByHpPredicate({state: b.state, probability: b.probability}, targetSide, targetIdx, hp => hp <= half);
              if (split.didSplit) stats.hpSplits++;
              if (split.matched) {
                if (berserkEligible) {
                  applyStatBoost(ctx, split.matched.state, targetSide, targetIdx, 'spa', 1, false);
                }
                if (emergencyExitEligible) {
                  split.matched.state.sides[targetSide].pokemon[targetIdx].emergencyExitTriggered = true;
                }
                nextHalf.push({state: split.matched.state, probability: split.matched.probability, remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}}))});
              }
              if (split.unmatched) {
                nextHalf.push({state: split.unmatched.state, probability: split.unmatched.probability, remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}}))});
              }
            }
            surv = nextHalf;
          }

          // Cursed Body: 30% chance on damaging hit to Disable attacker's move for 4 turns
          {
            const nextCb: ActiveBranch[] = [];
            for (const b of surv) {
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              const dAb = activeAbilitySpec(defStatic, dp);
              const moveIdx = hitOpts.moveIndex ?? ap.lastMoveIdx;
              const aromaBlocked = sideHasActiveAbility(ctx, b.state, atkSide, a => !!a.aromaVeil);
              if (dp.abilityActive && !dp.gastroAcid && dAb.cursedBody && !ap.fainted &&
                  ap.disabledTurns === 0 && moveIdx >= 0 && move.id !== 'struggle' && !aromaBlocked) {
                const choices = pickChoices([{item: false, prob: 0.7}, {item: true, prob: 0.3}], policy, stats);
                for (const c of choices) {
                  const st = choices.length === 1 ? b.state : cloneState(b.state);
                  if (c.item) {
                    st.sides[atkSide].pokemon[atkIdx].disabledMoveIdx = moveIdx;
                    st.sides[atkSide].pokemon[atkIdx].disabledTurns = 4;
                  }
                  nextCb.push({state: st, probability: b.probability * c.prob, remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}}))});
                }
              } else {
                nextCb.push(b);
              }
            }
            surv = nextCb;
          }

          // Champions Spicy Spray (burns attacker on any damaging hit)
          if (defAb.spicyspray) {
            const nextSp: ActiveBranch[] = [];
            for (const b of surv) {
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              if (dp.abilityActive && !dp.gastroAcid) {
                nextSp.push(...inflictStatusWithBranching(ctx, b, atkSide, atkIdx, 'brn', policy, stats, false, targetSide, targetIdx));
              } else {
                nextSp.push(b);
              }
            }
            surv = nextSp;
          }

          // Contact punish (Rough Skin / Iron Barbs, Rocky Helmet, Beak Blast, Gooey, Static/Flame Body/Poison Point, Effect Spore, Cute Charm, Mummy, Wandering Spirit, Pickpocket)
          surv = applyContactPunish(ctx, surv, atkSide, atkIdx, targetSide, targetIdx, move, false, policy, stats, hitOpts.contactOverride);

          // Knock Off removes removable item (unless Sticky Hold)
          if (move.knockOff) {
            for (const b of surv) {
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              if (!ap.fainted && !dp.fainted && canRemoveItem(ctx, b.state, targetSide, targetIdx, !moldBreaker)) {
                consumeItem(ctx, b.state, targetSide, targetIdx);
              }
            }
          }

          // Thief / Covet / Magician steal target's item if attacker has no item
          if (isFinalHit && (move.specialKind === 'steal-item' || (atk.abilityActive && !atk.gastroAcid && atkAb.magician && move.specialKind !== 'fling'))) {
            for (const b of surv) {
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              if (!ap.fainted && !dp.fainted && !ap.itemActive && canRemoveItem(ctx, b.state, targetSide, targetIdx, !moldBreaker)) {
                const stolen = activeItemId(defStatic, dp);
                setPokemonItem(b.state, targetSide, targetIdx, '');
                setPokemonItem(b.state, atkSide, atkIdx, stolen);
              }
            }
          }

          // Bug Bite / Pluck: steal and immediately eat target's Berry
          if (move.specialKind === 'steal-berry') {
            for (const b of surv) {
              const ap = b.state.sides[atkSide].pokemon[atkIdx];
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              if (!ap.fainted && !dp.fainted && canRemoveItem(ctx, b.state, targetSide, targetIdx, !moldBreaker)) {
                const targetItem = activeItemSpec(ctx, defStatic, dp);
                if (targetItem.isBerry) {
                  setPokemonItem(b.state, targetSide, targetIdx, '');
                  eatBerryEffect(ctx, b.state, atkSide, atkIdx, targetItem.id, false, true);
                }
              }
            }
          }

          // Fling on-hit item effect (status, flinch, or target eats flung Berry)
          if (move.specialKind === 'fling' && hitOpts.flingItemId) {
            const fSpec = getItemSpec(ctx, hitOpts.flingItemId);
            const nextFl: ActiveBranch[] = [];
            for (const b of surv) {
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              if (dp.fainted) {
                nextFl.push(b);
                continue;
              }
              if (fSpec.isBerry) {
                eatBerryEffect(ctx, b.state, targetSide, targetIdx, fSpec.id);
                nextFl.push(b);
              } else if (fSpec.flingStatus) {
                nextFl.push(...inflictStatusWithBranching(ctx, b, targetSide, targetIdx, fSpec.flingStatus, policy, stats, moldBreaker, atkSide, atkIdx));
              } else if (fSpec.flingVolatile === 'flinch') {
                const dAb = activeAbilitySpec(defStatic, dp);
                if (!dp.movedThisTurn && !(dp.abilityActive && !dp.gastroAcid && !moldBreaker && dAb.innerFocus) && !dp.focusPunchReady) {
                  dp.flinched = true;
                }
                nextFl.push(b);
              } else {
                nextFl.push(b);
              }
            }
            surv = nextFl;
          }

          // Move-specific on-hit effects (Sparkling Aria, Throat Chop, Clear Smog, Ceaseless Edge, Stone Axe, Ice Spinner, Steel Roller, Smack Down, Syrup Bomb, Partial Trap, Jaw Lock)
          for (const b of surv) {
            const dp = b.state.sides[targetSide].pokemon[targetIdx];
            if (dp.fainted) continue;
            if (move.curesBurn && dp.status === 'brn') {
              dp.status = '';
              dp.statusTurns = 0;
            }
            if (move.specialKind === 'throat-chop') dp.throatChopTurns = 2;
            if (move.specialKind === 'clear-smog') dp.boosts = [0, 0, 0, 0, 0, 0, 0];
            if (move.specialKind === 'smack-down') dp.smackedDown = true;
            if (move.specialKind === 'syrup-bomb') dp.syrupBombTurns = 3;
            if (move.id === 'jawlock') {
              dp.trapped = true;
              b.state.sides[atkSide].pokemon[atkIdx].trapped = true;
            }
            if (isFinalHit) {
              if (move.specialKind === 'ceaseless-edge') b.state.sides[targetSide].spikes = Math.min(3, b.state.sides[targetSide].spikes + 1);
              else if (move.specialKind === 'stone-axe') b.state.sides[targetSide].stealthRock = true;
              else if (move.specialKind === 'ice-spinner' || move.specialKind === 'steel-roller') {
                b.state.field.terrain = '';
                b.state.field.terrainTurns = 0;
                applyTerrainFormes(ctx, b.state);
              }
            }
          }

          // Partially trapped moves (Wrap, Bind, Fire Spin, Whirlpool, Sand Tomb, Infestation, Snap Trap): 50% 4 turns, 50% 5 turns
          if (move.specialKind === 'partial-trap' && isFinalHit) {
            const nextPt: ActiveBranch[] = [];
            for (const b of surv) {
              const dp = b.state.sides[targetSide].pokemon[targetIdx];
              if (!dp.fainted && dp.partialTrapTurns === 0) {
                const choices = pickChoices([{item: 4, prob: 0.5}, {item: 5, prob: 0.5}], policy, stats);
                for (const c of choices) {
                  const st = choices.length === 1 ? b.state : cloneState(b.state);
                  st.sides[targetSide].pokemon[targetIdx].partialTrapTurns = c.item;
                  nextPt.push({state: st, probability: b.probability * c.prob, remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}}))});
                }
              } else {
                nextPt.push(b);
              }
            }
            surv = nextPt;
          }

          // Sitrus / Oran Berry check (runs after each hit, including mid-multihit!)
          const afterSitrus: ActiveBranch[] = [];
          for (const b of surv) {
            afterSitrus.push(...maybeTriggerSitrus(ctx, b, targetSide, targetIdx, stats));
          }
          surv = afterSitrus;

          // Secondary effects + Tri Attack + Poison Touch + Stench (suppressed by Sheer Force or defender Shield Dust)
          const sheerForce = atk.abilityActive && !atk.gastroAcid && !!atkAb.sheerForce && (move.secondaries.length > 0 || move.specialKind === 'tri-attack');
          const shieldDust = def.abilityActive && !def.gastroAcid && !moldBreaker && !!defAb.shieldDust;
          if ((isFinalHit || hitOpts.runSecondariesOnEveryHit) && !sheerForce && !shieldDust) {
            const afterSec: ActiveBranch[] = [];
            for (const b of surv) {
              afterSec.push(...applySecondaries(ctx, b, atkSide, atkIdx, targetSide, targetIdx, move, policy, stats));
            }
            surv = afterSec;
          }

          postKo.push(...surv);
        }

        afterDamage.push(...postKo);
      }
    }
  }

  return {
    branches: deferLowProbBranches(mergeActiveBranches(ctx, [...afterDisguise, ...afterDamage], stats), defer),
    anyHitLanded,
  };
}

function applyContactPunish(
  ctx: StaticBattleContext,
  batch: ActiveBranch[],
  atkSide: 0 | 1,
  atkIdx: number,
  targetSide: 0 | 1,
  targetIdx: number,
  move: StaticMoveData,
  targetFainted: boolean,
  policy: BranchPolicy,
  stats: StepStats,
  contactOverride?: boolean
): ActiveBranch[] {
  const makesContact = contactOverride ?? move.contact;
  if (!makesContact) return batch;
  const atkStatic = ctx.sides[atkSide].team[atkIdx];
  const defStatic = ctx.sides[targetSide].team[targetIdx];
  let cur = batch;

  // Long Reach prevents contact!
  const firstAtk = cur[0]?.state.sides[atkSide].pokemon[atkIdx];
  if (firstAtk && firstAtk.abilityActive && !firstAtk.gastroAcid && activeAbilitySpec(atkStatic, firstAtk).longReach) {
    return batch;
  }

  // Beak Blast heating burn on contact
  {
    const nextBb: ActiveBranch[] = [];
    for (const b of cur) {
      const dp = b.state.sides[targetSide].pokemon[targetIdx];
      if (dp.beakBlastHeating && !b.state.sides[atkSide].pokemon[atkIdx].fainted) {
        nextBb.push(...inflictStatusWithBranching(ctx, b, atkSide, atkIdx, 'brn', policy, stats, false, targetSide, targetIdx));
      } else {
        nextBb.push(b);
      }
    }
    cur = nextBb;
  }

  // Rough Skin / Iron Barbs (1/8)
  const nextRs: ActiveBranch[] = [];
  for (const b of cur) {
    const dp = b.state.sides[targetSide].pokemon[targetIdx];
    const dAb = activeAbilitySpec(defStatic, dp);
    if (dp.abilityActive && !dp.gastroAcid && dAb.roughSkin) {
      const dmg = Math.max(1, Math.trunc(atkStatic.maxhp / 8));
      const out = applyFixedDamageWithThresholds(ctx, b, atkSide, atkIdx, dmg, true, policy, stats, true);
      for (const r of out) {
        if (targetFainted) checkEnded(r.state, targetSide);
        nextRs.push(r);
      }
    } else {
      nextRs.push(b);
    }
  }
  cur = nextRs;

  // Aftermath (1/4 on KO if no active Damp)
  if (targetFainted) {
    const nextAm: ActiveBranch[] = [];
    for (const b of cur) {
      const dp = b.state.sides[targetSide].pokemon[targetIdx];
      const dAb = activeAbilitySpec(defStatic, dp);
      if (dp.abilityActive && !dp.gastroAcid && dAb.aftermath && !fieldHasActiveAbility(ctx, b.state, a => !!a.damp)) {
        const dmg = Math.max(1, Math.trunc(atkStatic.maxhp / 4));
        const out = applyFixedDamageWithThresholds(ctx, b, atkSide, atkIdx, dmg, true, policy, stats, true);
        for (const r of out) {
          checkEnded(r.state, targetSide);
          nextAm.push(r);
        }
      } else {
        nextAm.push(b);
      }
    }
    cur = nextAm;
  }

  // Rocky Helmet (1/6)
  {
    const nextRh: ActiveBranch[] = [];
    for (const b of cur) {
      const dp = b.state.sides[targetSide].pokemon[targetIdx];
      if (isItemEffectActive(b.state, defStatic, dp) && activeItemSpec(ctx, defStatic, dp).archetype === 'rocky-helmet') {
        const dmg = Math.max(1, Math.trunc(atkStatic.maxhp / 6));
        const out = applyFixedDamageWithThresholds(ctx, b, atkSide, atkIdx, dmg, true, policy, stats, true);
        for (const r of out) {
          if (targetFainted) checkEnded(r.state, targetSide);
          nextRh.push(r);
        }
      } else {
        nextRh.push(b);
      }
    }
    cur = nextRh;
  }

  // Gooey (-1 Speed on contact), Mummy (overwrite attacker ability), Wandering Spirit (Skill Swap)
  for (const b of cur) {
    const dp = b.state.sides[targetSide].pokemon[targetIdx];
    const ap = b.state.sides[atkSide].pokemon[atkIdx];
    if (ap.fainted || !dp.abilityActive || dp.gastroAcid) continue;
    const dAb = activeAbilitySpec(defStatic, dp);
    if (dAb.gooey) {
      applyStatBoost(ctx, b.state, atkSide, atkIdx, 'spe', -1, true, false, targetSide, targetIdx);
    }
    if (dAb.mummy) {
      tryChangeAbility(ctx, b.state, atkSide, atkIdx, 'mummy');
    }
    if (dAb.wanderingSpirit) {
      trySkillSwap(ctx, b.state, atkSide, atkIdx, targetSide, targetIdx);
    }
  }

  // Pickpocket: defender without item steals attacker's item on contact hit (if surviving and not switching)
  if (!targetFainted) {
    for (const b of cur) {
      const dp = b.state.sides[targetSide].pokemon[targetIdx];
      const ap = b.state.sides[atkSide].pokemon[atkIdx];
      if (dp.fainted || ap.fainted || dp.itemActive || !dp.abilityActive || dp.gastroAcid) continue;
      if (activeAbilitySpec(defStatic, dp).pickpocket && canRemoveItem(ctx, b.state, atkSide, atkIdx, true)) {
        const stolen = activeItemId(atkStatic, ap);
        setPokemonItem(b.state, atkSide, atkIdx, '');
        setPokemonItem(b.state, targetSide, targetIdx, stolen);
      }
    }
  }

  // Cute Charm (30% Attract on contact if opposite gender and not Oblivious / Aroma Veil)
  {
    const nextCc: ActiveBranch[] = [];
    for (const b of cur) {
      const dp = b.state.sides[targetSide].pokemon[targetIdx];
      const ap = b.state.sides[atkSide].pokemon[atkIdx];
      const dAb = activeAbilitySpec(defStatic, dp);
      const aAb = activeAbilitySpec(atkStatic, ap);
      const oppositeGender = !!atkStatic.gender && !!defStatic.gender && atkStatic.gender !== defStatic.gender;
      const immune = (ap.abilityActive && !ap.gastroAcid && aAb.oblivious) ||
        sideHasActiveAbility(ctx, b.state, atkSide, a => !!a.aromaVeil);
      if (!targetFainted && !dp.fainted && !ap.fainted && dp.abilityActive && !dp.gastroAcid &&
          dAb.cuteCharm && oppositeGender && !immune && ap.attractSide < 0) {
        const tSlot = b.state.sides[targetSide].active.indexOf(targetIdx);
        const choices = pickChoices([{item: false, prob: 0.7}, {item: true, prob: 0.3}], policy, stats);
        for (const c of choices) {
          const st = choices.length === 1 ? b.state : cloneState(b.state);
          if (c.item) {
            st.sides[atkSide].pokemon[atkIdx].attractSide = targetSide;
            st.sides[atkSide].pokemon[atkIdx].attractSlot = tSlot;
          }
          nextCc.push({state: st, probability: b.probability * c.prob, remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}}))});
        }
      } else {
        nextCc.push(b);
      }
    }
    cur = nextCc;
  }

  // Contact status abilities (Static, Flame Body, Poison Point: 30%)
  const nextCs: ActiveBranch[] = [];
  for (const b of cur) {
    const dp = b.state.sides[targetSide].pokemon[targetIdx];
    const dAb = activeAbilitySpec(defStatic, dp);
    if (dp.abilityActive && !dp.gastroAcid && dAb.contactStatus &&
        canApplyStatus(ctx, b.state, atkSide, atkIdx, dAb.contactStatus.status)) {
      const pProc = dAb.contactStatus.chance / 100;
      const choices = pickChoices([{item: false, prob: 1 - pProc}, {item: true, prob: pProc}], policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? b.state : cloneState(b.state);
        const br: ActiveBranch = {
          state: st,
          probability: b.probability * c.prob,
          remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
        if (c.item) {
          nextCs.push(...inflictStatusWithBranching(ctx, br, atkSide, atkIdx, dAb.contactStatus.status, policy, stats, false, targetSide, targetIdx));
        } else {
          nextCs.push(br);
        }
      }
    } else {
      nextCs.push(b);
    }
  }
  cur = nextCs;

  // Effect Spore (11% slp, 10% par, 9% psn; blocked by Grass / Overcoat / Safety Goggles)
  const nextEs: ActiveBranch[] = [];
  for (const b of cur) {
    const dp = b.state.sides[targetSide].pokemon[targetIdx];
    const ap = b.state.sides[atkSide].pokemon[atkIdx];
    const dAb = activeAbilitySpec(defStatic, dp);
    const aAb = activeAbilitySpec(atkStatic, ap);
    const powderImmune = activeTypes(atkStatic, ap).includes('Grass') ||
      (ap.abilityActive && !ap.gastroAcid && aAb.overcoat) ||
      (isItemEffectActive(b.state, atkStatic, ap) && activeItemSpec(ctx, atkStatic, ap).archetype === 'safety-goggles');
    if (dp.abilityActive && !dp.gastroAcid && dAb.effectSpore && !ap.fainted && !powderImmune && ap.status === '') {
      const pSlp = canApplyStatus(ctx, b.state, atkSide, atkIdx, 'slp') ? 0.11 : 0;
      const pPar = canApplyStatus(ctx, b.state, atkSide, atkIdx, 'par') ? 0.10 : 0;
      const pPsn = canApplyStatus(ctx, b.state, atkSide, atkIdx, 'psn') ? 0.09 : 0;
      const pNone = Math.max(0, 1 - pSlp - pPar - pPsn);
      const opts: {item: StatusId; prob: number}[] = [];
      if (pNone > EPS) opts.push({item: '', prob: pNone});
      if (pSlp > EPS) opts.push({item: 'slp', prob: pSlp});
      if (pPar > EPS) opts.push({item: 'par', prob: pPar});
      if (pPsn > EPS) opts.push({item: 'psn', prob: pPsn});
      const choices = pickChoices(opts, policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? b.state : cloneState(b.state);
        const br: ActiveBranch = {
          state: st,
          probability: b.probability * c.prob,
          remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
        if (c.item) {
          nextEs.push(...inflictStatusWithBranching(ctx, br, atkSide, atkIdx, c.item, policy, stats, false, targetSide, targetIdx));
        } else {
          nextEs.push(br);
        }
      }
    } else {
      nextEs.push(b);
    }
  }
  return nextEs;
}

function applySecondaries(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  atkSide: 0 | 1,
  atkIdx: number,
  targetSide: 0 | 1,
  targetIdx: number,
  move: StaticMoveData,
  policy: BranchPolicy,
  stats: StepStats
): ActiveBranch[] {
  const atkStatic = ctx.sides[atkSide].team[atkIdx];
  const atkPoke0 = ab.state.sides[atkSide].pokemon[atkIdx];
  const atkAb = activeAbilitySpec(atkStatic, atkPoke0);
  const atkAbActive = atkPoke0.abilityActive && !atkPoke0.gastroAcid;
  const sereneGrace = atkAbActive && !!atkAb.sereneGrace;
  const moldBreaker = atkAbActive && !!atkAb.moldBreaker;
  const corrosion = atkAbActive && !!atkAb.corrosion;
  const makesContact = move.contact && !(atkAbActive && atkAb.longReach);

  let branches: ActiveBranch[] = [ab];

  // Tri Attack special secondary: 20% (40% Serene Grace) split equally into 1/3 brn, 1/3 par, 1/3 frz
  if (move.specialKind === 'tri-attack') {
    const nextTri: ActiveBranch[] = [];
    const totalP = sereneGrace ? 0.4 : 0.2;
    for (const b of branches) {
      const def = b.state.sides[targetSide].pokemon[targetIdx];
      if (def.fainted || def.status !== '') {
        nextTri.push(b);
        continue;
      }
      const pBrn = canApplyStatus(ctx, b.state, targetSide, targetIdx, 'brn', moldBreaker) ? totalP / 3 : 0;
      const pPar = canApplyStatus(ctx, b.state, targetSide, targetIdx, 'par', moldBreaker) ? totalP / 3 : 0;
      const pFrz = canApplyStatus(ctx, b.state, targetSide, targetIdx, 'frz', moldBreaker) ? totalP / 3 : 0;
      const pNone = Math.max(0, 1 - pBrn - pPar - pFrz);
      const opts: {item: StatusId; prob: number}[] = [];
      if (pNone > EPS) opts.push({item: '', prob: pNone});
      if (pBrn > EPS) opts.push({item: 'brn', prob: pBrn});
      if (pPar > EPS) opts.push({item: 'par', prob: pPar});
      if (pFrz > EPS) opts.push({item: 'frz', prob: pFrz});
      const choices = pickChoices(opts, policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? b.state : cloneState(b.state);
        const br: ActiveBranch = {
          state: st,
          probability: b.probability * c.prob,
          remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
        if (c.item) {
          nextTri.push(...inflictStatusWithBranching(ctx, br, targetSide, targetIdx, c.item, policy, stats, moldBreaker, atkSide, atkIdx));
        } else {
          nextTri.push(br);
        }
      }
    }
    branches = nextTri;
  }

  // Standard move secondaries + Poison Touch (30% psn on contact) + Stench (10% flinch if no flinch secondary)
  const extraSecondaries = [...move.secondaries];
  if (atkAbActive && atkAb.poisonTouch && makesContact) {
    extraSecondaries.push({chance: 30, status: 'psn'});
  }
  if (atkAbActive && atkAb.stench && !move.secondaries.some(s => s.volatileStatus === 'flinch')) {
    extraSecondaries.push({chance: 10, volatileStatus: 'flinch'});
  }

  for (const sec of extraSecondaries) {
    const next: ActiveBranch[] = [];
    for (const b of branches) {
      const def = b.state.sides[targetSide].pokemon[targetIdx];
      const atk = b.state.sides[atkSide].pokemon[atkIdx];
      if (def.fainted) {
        next.push(b);
        continue;
      }
      const defAb = activeAbilitySpec(ctx.sides[targetSide].team[targetIdx], def);
      const canFlinch = sec.volatileStatus === 'flinch' && !def.movedThisTurn && !def.focusPunchReady &&
        !(def.abilityActive && !def.gastroAcid && !moldBreaker && defAb.innerFocus);
      const canConfuse = sec.volatileStatus === 'confusion' && def.confusionTurns === 0 &&
        !(def.abilityActive && !def.gastroAcid && !moldBreaker && defAb.ownTempo) &&
        b.state.sides[targetSide].safeguardTurns === 0 &&
        !(isGrounded(ctx.sides[targetSide].team[targetIdx], def, b.state) && b.state.field.terrain === 'misty');

      let observable = false;
      if (sec.status && canApplyStatus(ctx, b.state, targetSide, targetIdx, sec.status, moldBreaker, corrosion)) {
        observable = true;
      }
      if (canFlinch || canConfuse) observable = true;
      if (sec.boosts) {
        for (const [stat, delta] of Object.entries(sec.boosts) as [BoostStat, number][]) {
          const cur = def.boosts[BOOST_INDEX[stat]];
          if (clampInt(cur + delta, -6, 6) !== cur || (def.abilityActive && !def.gastroAcid && defAb.mirrorArmor && delta < 0)) {
            observable = true;
          }
        }
      }
      if (sec.selfBoosts && !atk.fainted) {
        for (const [stat, delta] of Object.entries(sec.selfBoosts) as [BoostStat, number][]) {
          const cur = atk.boosts[BOOST_INDEX[stat]];
          if (clampInt(cur + delta, -6, 6) !== cur) observable = true;
        }
      }
      if (!observable) {
        next.push(b);
        continue;
      }

      const rawChance = sereneGrace ? Math.min(100, sec.chance * 2) : sec.chance;
      const pProc = rawChance >= 100 ? 1 : Math.ceil(rawChance) / 100;
      const choices = pickChoices(
        [
          {item: false, prob: 1 - pProc},
          {item: true, prob: pProc},
        ],
        policy,
        stats
      );
      for (const c of choices) {
        const st = choices.length === 1 ? b.state : cloneState(b.state);
        const br: ActiveBranch = {
          state: st,
          probability: b.probability * c.prob,
          remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
        if (!c.item) {
          next.push(br);
          continue;
        }
        if (canFlinch) st.sides[targetSide].pokemon[targetIdx].flinched = true;
        if (sec.boosts) {
          for (const [stat, delta] of Object.entries(sec.boosts) as [BoostStat, number][]) {
            applyStatBoost(ctx, st, targetSide, targetIdx, stat, delta, atkSide !== targetSide, moldBreaker, atkSide, atkIdx);
          }
        }
        if (sec.selfBoosts && !st.sides[atkSide].pokemon[atkIdx].fainted) {
          for (const [stat, delta] of Object.entries(sec.selfBoosts) as [BoostStat, number][]) {
            applyStatBoost(ctx, st, atkSide, atkIdx, stat, delta, false);
          }
        }
        let sub: ActiveBranch[] = [br];
        if (sec.status) {
          sub = inflictStatusWithBranching(ctx, br, targetSide, targetIdx, sec.status, policy, stats, moldBreaker, atkSide, atkIdx, corrosion);
        }
        if (canConfuse) {
          const nextConf: ActiveBranch[] = [];
          for (const sb of sub) {
            nextConf.push(...inflictConfusionWithBranching(ctx, sb, targetSide, targetIdx, policy, stats, moldBreaker));
          }
          sub = nextConf;
        }
        next.push(...sub);
      }
    }
    branches = next;
  }
  return branches;
}

function executeMoveAction(
  ctx: StaticBattleContext,
  ab: ActiveBranch,
  actorSide: 0 | 1,
  action: MoveAction,
  damageCache: DamageBatchCache,
  policy: BranchPolicy,
  stats: StepStats,
  overrideMove?: StaticMoveData,
  skipPreChecks = false,
  defer?: DeferTracker
): {active: ActiveBranch[]; paused: WeightedState[]; ended: WeightedState[]} {
  const paused: WeightedState[] = [];
  const ended: WeightedState[] = [];

  const side = ab.state.sides[actorSide];
  const pokeIdx = side.active[action.slot];
  if (pokeIdx < 0 || side.pokemon[pokeIdx].fainted) {
    return {active: [ab], paused, ended};
  }
  const poke = side.pokemon[pokeIdx];
  const atkStatic = ctx.sides[actorSide].team[pokeIdx];
  const atkAb = activeAbilitySpec(atkStatic, poke);

  if (!skipPreChecks) {
    // Clear start-of-turn-action volatiles (Glaive Rush & Destiny Bond expire when user attempts next action)
    poke.glaiveRush = false;
    poke.destinyBond = false;
    poke.beakBlastHeating = false;

    if (poke.flinched) {
      poke.flinched = false;
      poke.movedThisTurn = true;
      poke.protectStreak = 0;
      poke.lastMoveFailed = true;
      if (poke.abilityActive && !poke.gastroAcid && atkAb.steadfast) {
        applyStatBoost(ctx, ab.state, actorSide, pokeIdx, 'spe', 1, false);
      }
      return {active: [ab], paused, ended};
    }
    if (poke.mustRecharge) {
      poke.mustRecharge = false;
      poke.movedThisTurn = true;
      poke.protectStreak = 0;
      return {active: [ab], paused, ended};
    }
  }

  let moveIndex = poke.chargingMoveIdx >= 0
    ? poke.chargingMoveIdx
    : (poke.lockedMoveIdx >= 0 ? poke.lockedMoveIdx : action.moveIndex);
  if (!overrideMove && poke.encoreMoveIdx >= 0 && poke.chargingMoveIdx < 0 && poke.lockedMoveIdx < 0) moveIndex = poke.encoreMoveIdx;
  if (!overrideMove && moveIndex >= 0 && poke.chargingMoveIdx < 0 && poke.lockedMoveIdx < 0 && poke.pp[moveIndex] <= 0) moveIndex = -1;
  const move = overrideMove ?? getMoveForAction(ctx, actorSide, pokeIdx, moveIndex, ab.state);

  // --- BeforeMove checks: Sleep (Early Bird, Snore, Sleep Talk), Freeze, Paralysis, Attract, Confusion ---
  let preMoveBranches: {ab: ActiveBranch; immobilized: boolean}[] = [];
  if (skipPreChecks) {
    preMoveBranches.push({ab, immobilized: false});
  } else if (poke.status === 'slp') {
    const tick = poke.abilityActive && !poke.gastroAcid && atkAb.earlyBird ? 2 : 1;
    poke.statusTurns = Math.max(0, poke.statusTurns - tick);
    if (poke.statusTurns <= 0) {
      poke.status = '';
      preMoveBranches.push({ab, immobilized: false});
    } else if (move.specialKind === 'snore' || move.specialKind === 'sleep-talk') {
      preMoveBranches.push({ab, immobilized: false});
    } else {
      preMoveBranches.push({ab, immobilized: true});
    }
  } else if (poke.status === 'frz') {
    const maxTurns = ctx.ruleset.freezeMaxTurns;
    if (maxTurns > 0) poke.statusTurns--;
    if (maxTurns > 0 && poke.statusTurns <= 0) {
      poke.status = '';
      preMoveBranches.push({ab, immobilized: false});
    } else {
      const pThaw = ctx.ruleset.freezeThawChance;
      const choices = pickChoices([{item: true, prob: pThaw}, {item: false, prob: 1 - pThaw}], policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? ab.state : cloneState(ab.state);
        if (c.item) {
          st.sides[actorSide].pokemon[pokeIdx].status = '';
          st.sides[actorSide].pokemon[pokeIdx].statusTurns = 0;
        }
        preMoveBranches.push({
          ab: {state: st, probability: ab.probability * c.prob, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
          immobilized: !c.item,
        });
      }
    }
  } else if (poke.status === 'par') {
    const pPara = ctx.ruleset.paralysisChance;
    const choices = pickChoices([{item: false, prob: 1 - pPara}, {item: true, prob: pPara}], policy, stats);
    for (const c of choices) {
      const st = choices.length === 1 ? ab.state : cloneState(ab.state);
      preMoveBranches.push({
        ab: {state: st, probability: ab.probability * c.prob, remainingActions: ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
        immobilized: c.item,
      });
    }
  } else {
    preMoveBranches.push({ab, immobilized: false});
  }

  // Attract check (50% immobilization while infatuation source remains active)
  if (!skipPreChecks) {
    const afterAttract: {ab: ActiveBranch; immobilized: boolean}[] = [];
    for (const pre of preMoveBranches) {
      if (pre.immobilized) {
        afterAttract.push(pre);
        continue;
      }
      const p0 = pre.ab.state.sides[actorSide].pokemon[pokeIdx];
      if (p0.attractSide !== -1) {
        const srcIdx = pre.ab.state.sides[p0.attractSide].active[p0.attractSlot];
        if (srcIdx === undefined || srcIdx < 0 || pre.ab.state.sides[p0.attractSide].pokemon[srcIdx].fainted) {
          p0.attractSide = -1;
          p0.attractSlot = -1;
          afterAttract.push(pre);
        } else {
          const choices = pickChoices([{item: false, prob: 0.5}, {item: true, prob: 0.5}], policy, stats);
          for (const c of choices) {
            const st = choices.length === 1 ? pre.ab.state : cloneState(pre.ab.state);
            afterAttract.push({
              ab: {state: st, probability: pre.ab.probability * c.prob, remainingActions: pre.ab.remainingActions.map(a => ({...a, action: {...a.action}}))},
              immobilized: c.item,
            });
          }
        }
      } else {
        afterAttract.push(pre);
      }
    }
    preMoveBranches = afterAttract;

    // Confusion check: decrement turns; if still > 0, 1/3 self-hit (40 BP typeless physical)
    const afterConf: {ab: ActiveBranch; immobilized: boolean}[] = [];
    for (const pre of preMoveBranches) {
      if (pre.immobilized) {
        afterConf.push(pre);
        continue;
      }
      const p0 = pre.ab.state.sides[actorSide].pokemon[pokeIdx];
      if (p0.confusionTurns > 0) {
        p0.confusionTurns--;
        if (p0.confusionTurns <= 0) {
          afterConf.push(pre);
        } else {
          const choices = pickChoices([{item: false, prob: 0.67}, {item: true, prob: 0.33}], policy, stats);
          for (const c of choices) {
            const st = choices.length === 1 ? pre.ab.state : cloneState(pre.ab.state);
            const br: ActiveBranch = {
              state: st,
              probability: pre.ab.probability * c.prob,
              remainingActions: pre.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
            };
            if (!c.item) {
              afterConf.push({ab: br, immobilized: false});
            } else {
              // 40 BP typeless physical self-hit
              const ps = activeStats(atkStatic, st.sides[actorSide].pokemon[pokeIdx]);
              const atkStat = applyBoostToStat(ps.atk, st.sides[actorSide].pokemon[pokeIdx].boosts[0]);
              const defStat = applyBoostToStat(ps.def, st.sides[actorSide].pokemon[pokeIdx].boosts[1]);
              const lvl = Math.floor(2 * atkStatic.level / 5 + 2);
              const baseDmg = Math.floor(Math.floor(Math.floor(lvl * 40 * atkStat) / Math.max(1, defStat)) / 50) + 2;
              const rollCounts = new Map<number, number>();
              for (let r = 0; r < 16; r++) {
                const d = Math.max(1, Math.floor(Math.floor(baseDmg * (100 - r)) / 100));
                rollCounts.set(d, (rollCounts.get(d) ?? 0) + 1 / 16);
              }
              const rChoices = pickChoices([...rollCounts.entries()].map(([d, prob]) => ({item: d, prob})), policy, stats);
              for (const rc of rChoices) {
                const st2 = rChoices.length === 1 ? st : cloneState(st);
                const br2: ActiveBranch = {
                  state: st2,
                  probability: br.probability * rc.prob,
                  remainingActions: br.remainingActions.map(a => ({...a, action: {...a.action}})),
                };
                const hitOut = applyFixedDamageWithThresholds(ctx, br2, actorSide, pokeIdx, rc.item, true, policy, stats);
                for (const h of hitOut) afterConf.push({ab: h, immobilized: true});
              }
            }
          }
        }
      } else {
        afterConf.push(pre);
      }
    }
    preMoveBranches = afterConf;
  }

  const outActive: ActiveBranch[] = [];
  const oppSide: 0 | 1 = actorSide === 0 ? 1 : 0;

  for (const pre of preMoveBranches) {
    const cur = pre.ab;
    const p = cur.state.sides[actorSide].pokemon[pokeIdx];
    if (p.fainted) {
      if (checkEnded(cur.state, oppSide)) ended.push({state: cur.state, probability: cur.probability});
      else outActive.push(cur);
      continue;
    }
    p.movedThisTurn = true;
    if (pre.immobilized) {
      p.protectStreak = 0;
      p.chargingMoveIdx = -1;
      p.invulnerable = '';
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // Focus Punch lost focus check
    if (move.specialKind === 'focus-punch' && p.focusPunchLost) {
      p.protectStreak = 0;
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // Imprison mid-turn block check
    if (move.id !== 'struggle') {
      let blockedByImprison = false;
      for (const oIdx of cur.state.sides[oppSide].active) {
        if (oIdx < 0) continue;
        const op = cur.state.sides[oppSide].pokemon[oIdx];
        if (!op.fainted && op.imprison && activeMoves(ctx.sides[oppSide].team[oIdx], op).some(m => m.id === move.id)) {
          blockedByImprison = true;
          break;
        }
      }
      if (blockedByImprison) {
        p.protectStreak = 0;
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
    }

    // Taunt / Disabled mid-turn check
    if (!skipPreChecks && ((p.tauntTurns > 0 && move.category === 'Status') ||
        (p.disabledMoveIdx === moveIndex && p.disabledTurns > 0 && moveIndex >= 0))) {
      p.protectStreak = 0;
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // Snore / Sleep Talk fail if not asleep
    if ((move.specialKind === 'snore' || move.specialKind === 'sleep-talk') && p.status !== 'slp') {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    const wasCharging = p.chargingMoveIdx >= 0;
    const wasLocked = p.lockedMoveIdx >= 0 && moveIndex === p.lockedMoveIdx;
    const targetsPre = resolveTargets(ctx, cur.state, actorSide, action.slot, action, move);

    // Deduct PP (not deducted again on second turn of a two-turn charge move, lockedmove, or meta-called move)
    if (!overrideMove && moveIndex >= 0 && !wasCharging && !wasLocked && p.uproarTurns === 0) {
      let ppCost = 1;
      for (const t of targetsPre) {
        if (t.side !== actorSide) {
          const dp = cur.state.sides[t.side].pokemon[t.pokeIdx];
          if (dp.abilityActive && !dp.gastroAcid && activeAbilitySpec(ctx.sides[t.side].team[t.pokeIdx], dp).pressure) {
            ppCost++;
          }
        }
      }
      p.pp[moveIndex] = Math.max(0, p.pp[moveIndex] - ppCost);
      p.lastMoveIdx = moveIndex;
      p.lastMoveId = move.id;
      p.usedMovesMask |= 1 << moveIndex;
      if (isItemEffectActive(cur.state, atkStatic, p) && activeItemSpec(ctx, atkStatic, p).archetype === 'choice-scarf' && p.choiceLockedMoveIdx < 0) {
        p.choiceLockedMoveIdx = moveIndex;
      }
    } else if (!overrideMove && moveIndex >= 0 && wasLocked) {
      p.lastMoveIdx = moveIndex;
      p.lastMoveId = move.id;
      p.usedMovesMask |= 1 << moveIndex;
    } else if (!overrideMove && moveIndex < 0) {
      p.lastMoveIdx = -2;
      p.lastMoveId = 'struggle';
    }
    if (move.id !== 'struggle' && move.specialKind !== 'copycat') {
      cur.state.field.lastMoveId = move.id;
    }

    // --- Belch / Last Resort / Aura Wheel / Spit Up / Swallow onTry checks (after PP deducted!) ---
    if (move.specialKind === 'belch' && !p.ateBerry) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'last-resort') {
      const curMoves = activeMoves(atkStatic, p);
      let ok = curMoves.length >= 2;
      if (ok) {
        for (let mi = 0; mi < curMoves.length; mi++) {
          if (curMoves[mi].id === 'lastresort') continue;
          if ((p.usedMovesMask & (1 << mi)) === 0) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
    }
    if (move.specialKind === 'aura-wheel' && !atkStatic.speciesId.startsWith('morpeko')) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if ((move.specialKind === 'spit-up' || move.specialKind === 'swallow') && p.stockpileLayers <= 0) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // --- Stance Change (Aegislash: Blade on attack, Shield on King's Shield) ---
    if (p.abilityActive && !p.gastroAcid && atkAb.stanceChange && !p.transformed && atkStatic.speciesId === 'aegislash') {
      if (move.category !== 'Status' && atkStatic.altFormes['aegislashblade']) {
        p.formeId = 'aegislashblade';
      } else if (move.id === 'kingsshield') {
        p.formeId = null;
      }
    }

    // --- Gulp Missile: Cramorant catches prey on Surf or Dive ---
    if (p.abilityActive && !p.gastroAcid && atkAb.gulpMissile && activeSpeciesId(atkStatic, p) === 'cramorant' &&
        (move.id === 'surf' || (move.id === 'dive' && !wasCharging))) {
      const nextF = p.hp * 2 <= atkStatic.maxhp ? 'cramorantgorging' : 'cramorantgulping';
      if (atkStatic.altFormes[nextF]) p.formeId = nextF;
    }

    // --- Meta-calling moves: Sleep Talk, Copycat, Instruct ---
    if (move.specialKind === 'sleep-talk') {
      const curMoves = activeMoves(atkStatic, p);
      const eligible = curMoves.filter(m =>
        m.id !== 'sleeptalk' && !m.noSleepTalk &&
        m.specialKind !== 'solar-beam' && m.specialKind !== 'meteor-beam' &&
        m.specialKind !== 'electro-shot' && m.specialKind !== 'two-turn-invuln' && m.specialKind !== 'sky-attack'
      );
      if (eligible.length === 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const prob = 1 / eligible.length;
      const picked = pickChoices(eligible.map(m => ({item: m, prob})), policy, stats);
      for (const c of picked) {
        const st = picked.length === 1 ? cur.state : cloneState(cur.state);
        const br: ActiveBranch = {
          state: st,
          probability: cur.probability * c.prob,
          remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
        const sub = executeMoveAction(ctx, br, actorSide, action, damageCache, policy, stats, c.item, true);
        outActive.push(...sub.active);
        paused.push(...sub.paused);
        ended.push(...sub.ended);
      }
      continue;
    }
    if (move.specialKind === 'copycat') {
      const lmId = cur.state.field.lastMoveId;
      if (!lmId) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const copied = compileMoveSpec(ctx.dex, lmId).move;
      if (copied.failCopycat) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const sub = executeMoveAction(ctx, cur, actorSide, action, damageCache, policy, stats, copied, true);
      outActive.push(...sub.active);
      paused.push(...sub.paused);
      ended.push(...sub.ended);
      continue;
    }
    if (move.specialKind === 'instruct') {
      const t = targetsPre[0];
      if (!t) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const dp = cur.state.sides[t.side].pokemon[t.pokeIdx];
      if (dp.fainted || !dp.lastMoveId) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const dMoves = activeMoves(ctx.sides[t.side].team[t.pokeIdx], dp);
      const tMi = dMoves.findIndex(m => m.id === dp.lastMoveId);
      const tMove = tMi >= 0 ? dMoves[tMi] : null;
      if (!tMove || tMove.failInstruct || dp.pp[tMi] <= 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const instructAction: MoveAction = {
        kind: 'move',
        slot: t.slot,
        moveIndex: tMi,
        targetSide: t.side === 0 ? 1 : 0,
        targetSlot: 0,
      };
      const sub = executeMoveAction(ctx, cur, t.side, instructAction, damageCache, policy, stats, undefined, true);
      outActive.push(...sub.active);
      paused.push(...sub.paused);
      ended.push(...sub.ended);
      continue;
    }

    // Protean / Libero: change type to move type once per switch-in
    if (p.abilityActive && !p.gastroAcid && atkAb.protean && !p.proteanUsed && move.type !== '???') {
      const {type: effType} = resolveMoveType(ctx, cur.state, actorSide, pokeIdx, move);
      const curTypes = activeTypes(atkStatic, p);
      if (curTypes.length !== 1 || curTypes[0] !== effType) {
        p.types = [effType];
        p.proteanUsed = true;
      }
    }

    if (!move.protect && move.specialKind !== 'endure') {
      p.protectStreak = 0;
    }
    p.lastMoveFailed = false;

    // --- Two-turn charge moves (Solar Beam/Blade, Meteor Beam, Electro Shot, Fly/Bounce/Dig/Dive/Phantom Force, Sky Attack) ---
    if (move.specialKind === 'solar-beam' || move.specialKind === 'meteor-beam' ||
        move.specialKind === 'electro-shot' || move.specialKind === 'two-turn-invuln' ||
        move.specialKind === 'sky-attack') {
      if (wasCharging) {
        p.chargingMoveIdx = -1;
        p.invulnerable = '';
      } else {
        const effW = (p.abilityActive && atkAb.megaSol) ? 'sun' : effectiveFieldWeather(ctx, cur.state);
        if (move.specialKind === 'meteor-beam' || move.specialKind === 'electro-shot') {
          applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'spa', 1, false);
        }
        const skipCharge =
          (move.specialKind === 'solar-beam' && effW === 'sun') ||
          (move.specialKind === 'electro-shot' && effW === 'rain');
        const hasPowerHerb = isItemEffectActive(cur.state, atkStatic, p) && atkStatic.itemSpec.archetype === 'power-herb';
        if (skipCharge) {
          // Execute immediately without charging
        } else if (hasPowerHerb) {
          consumeItem(ctx, cur.state, actorSide, pokeIdx);
        } else {
          p.chargingMoveIdx = moveIndex;
          if (move.id === 'fly' || move.id === 'bounce') p.invulnerable = 'fly';
          else if (move.id === 'dig') p.invulnerable = 'dig';
          else if (move.id === 'dive') p.invulnerable = 'dive';
          else if (move.id === 'phantomforce') p.invulnerable = 'shadow';
          outActive.push(cur);
          continue;
        }
      }
    }

    // --- Protect / Spiky Shield / King's Shield / Baneful Bunker / Endure ---
    if (move.protect || move.specialKind === 'endure') {
      const someoneLeftToAct = cur.remainingActions.some(ra => {
        const rIdx = cur.state.sides[ra.side].active[ra.action.slot];
        return rIdx >= 0 && !cur.state.sides[ra.side].pokemon[rIdx].fainted;
      });
      if (!someoneLeftToAct) {
        p.protectStreak = 0;
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const denom = p.protectStreak === 0 ? 1 : Math.min(729, 3 ** p.protectStreak);
      const pSuccess = 1 / denom;
      const choices = pickChoices([{item: true, prob: pSuccess}, {item: false, prob: 1 - pSuccess}], policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? cur.state : cloneState(cur.state);
        const pk = st.sides[actorSide].pokemon[pokeIdx];
        if (c.item) {
          if (move.specialKind === 'endure') {
            pk.enduring = true;
          } else {
            pk.protecting = true;
            pk.protectKind = move.specialKind === 'spiky-shield' ? 'spiky'
              : move.specialKind === 'kings-shield' ? 'kings'
                : move.specialKind === 'baneful-bunker' ? 'baneful' : 'protect';
          }
          pk.protectStreak = Math.min(6, pk.protectStreak + 1);
        } else {
          pk.protectStreak = 0;
          pk.lastMoveFailed = true;
        }
        outActive.push({
          state: st,
          probability: cur.probability * c.prob,
          remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
        });
      }
      continue;
    }

    if (move.specialKind === 'wide-guard') {
      cur.state.sides[actorSide].wideGuard = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'quick-guard') {
      cur.state.sides[actorSide].quickGuard = true;
      outActive.push(cur);
      continue;
    }

    // --- Redirection (Follow Me / Rage Powder) & Doubles support (Ally Switch, Helping Hand, After You, Quash) ---
    if (move.specialKind === 'redirect') {
      if (ctx.activeCount > 1) {
        p.redirectKind = move.id === 'ragepowder' ? 'ragepowder' : 'followme';
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'ally-switch') {
      if (ctx.activeCount === 2) {
        const tmp = cur.state.sides[actorSide].active[0];
        cur.state.sides[actorSide].active[0] = cur.state.sides[actorSide].active[1];
        cur.state.sides[actorSide].active[1] = tmp;
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'helping-hand') {
      const allySlot = action.slot === 0 ? 1 : 0;
      const allyIdx = ctx.activeCount === 2 ? cur.state.sides[actorSide].active[allySlot] : -1;
      const willMove = allyIdx >= 0 && cur.remainingActions.some(ra => ra.side === actorSide && ra.action.slot === allySlot);
      if (allyIdx >= 0 && !cur.state.sides[actorSide].pokemon[allyIdx].fainted && willMove) {
        cur.state.sides[actorSide].pokemon[allyIdx].helpingHandCount++;
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'after-you' || move.specialKind === 'quash') {
      const t = targetsPre[0];
      if (t) {
        const ra = cur.remainingActions.find(x => x.side === t.side && x.action.slot === t.slot);
        if (ra) {
          if (move.specialKind === 'after-you') {
            ra.priority = 100;
            ra.subOrder = 10;
          } else {
            ra.priority = -100;
            ra.subOrder = -10;
          }
        } else {
          p.lastMoveFailed = true;
        }
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }

    // --- Hazards (respecting Magic Bounce on opposing side!) ---
    const oppHasMagicBounce = !(p.abilityActive && atkAb.moldBreaker) &&
      sideHasActiveAbility(ctx, cur.state, oppSide, a => !!a.magicBounce);
    if (move.specialKind === 'stealth-rock') {
      const destSide = oppHasMagicBounce ? actorSide : oppSide;
      cur.state.sides[destSide].stealthRock = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'spikes') {
      const destSide = oppHasMagicBounce ? actorSide : oppSide;
      cur.state.sides[destSide].spikes = Math.min(3, cur.state.sides[destSide].spikes + 1);
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'toxic-spikes') {
      const destSide = oppHasMagicBounce ? actorSide : oppSide;
      cur.state.sides[destSide].toxicSpikes = Math.min(2, cur.state.sides[destSide].toxicSpikes + 1);
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'sticky-web') {
      const destSide = oppHasMagicBounce ? actorSide : oppSide;
      cur.state.sides[destSide].stickyWeb = true;
      outActive.push(cur);
      continue;
    }

    // --- Screens / Safeguard / Tailwind / Rooms / Weather / Terrain / Court Change / Tidy Up / Haze / Perish Song / Wish / Heal Bell ---
    const lightClay = isItemEffectActive(cur.state, atkStatic, p) && atkStatic.itemSpec.archetype === 'light-clay';
    if (move.specialKind === 'tailwind') {
      if (cur.state.sides[actorSide].tailwindTurns === 0) cur.state.sides[actorSide].tailwindTurns = 4;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'reflect') {
      if (cur.state.sides[actorSide].reflectTurns === 0) cur.state.sides[actorSide].reflectTurns = lightClay ? 8 : 5;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'light-screen') {
      if (cur.state.sides[actorSide].lightScreenTurns === 0) cur.state.sides[actorSide].lightScreenTurns = lightClay ? 8 : 5;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'aurora-veil') {
      if (effectiveFieldWeather(ctx, cur.state) === 'snow' && cur.state.sides[actorSide].auroraVeilTurns === 0) {
        cur.state.sides[actorSide].auroraVeilTurns = lightClay ? 8 : 5;
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'safeguard') {
      if (cur.state.sides[actorSide].safeguardTurns === 0) cur.state.sides[actorSide].safeguardTurns = 5;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'trick-room') {
      cur.state.field.trickRoomTurns = cur.state.field.trickRoomTurns > 0 ? 0 : 5;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'gravity') {
      if (cur.state.field.gravityTurns === 0) cur.state.field.gravityTurns = 5;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'fairy-lock') {
      if (cur.state.field.fairyLockTurns === 0) cur.state.field.fairyLockTurns = 2;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'magic-room') {
      cur.state.field.magicRoomTurns = cur.state.field.magicRoomTurns > 0 ? 0 : 5;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'wonder-room') {
      cur.state.field.wonderRoomTurns = cur.state.field.wonderRoomTurns > 0 ? 0 : 5;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'set-weather' && move.setsWeather) {
      setWeather(ctx, cur.state, move.setsWeather, actorSide, pokeIdx);
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'set-terrain' && move.setsTerrain) {
      setTerrain(ctx, cur.state, move.setsTerrain, actorSide, pokeIdx);
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'chilly-reception') {
      setWeather(ctx, cur.state, 'snow', actorSide, pokeIdx);
      const bench = legalBenchSwitches(cur.state.sides[actorSide]);
      if (bench.length > 0) {
        cur.state.phase = {
          kind: 'switch',
          pendingSlots: [{side: actorSide, slot: action.slot}],
          remainingActions: cur.remainingActions,
          needsEndOfTurn: true,
        };
        paused.push({state: cur.state, probability: cur.probability});
      } else {
        outActive.push(cur);
      }
      continue;
    }
    if (move.specialKind === 'haze') {
      for (const s of [0, 1] as const) {
        for (const idx of cur.state.sides[s].active) {
          if (idx >= 0) cur.state.sides[s].pokemon[idx].boosts = [0, 0, 0, 0, 0, 0, 0];
        }
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'tidy-up') {
      for (const s of [0, 1] as const) {
        cur.state.sides[s].stealthRock = false;
        cur.state.sides[s].spikes = 0;
        cur.state.sides[s].toxicSpikes = 0;
        cur.state.sides[s].stickyWeb = false;
        for (const idx of cur.state.sides[s].active) {
          if (idx >= 0) cur.state.sides[s].pokemon[idx].substituteHp = 0;
        }
      }
      applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'atk', 1, false);
      applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'spe', 1, false);
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'court-change') {
      const s0 = cur.state.sides[0];
      const s1 = cur.state.sides[1];
      [s0.stealthRock, s1.stealthRock] = [s1.stealthRock, s0.stealthRock];
      [s0.spikes, s1.spikes] = [s1.spikes, s0.spikes];
      [s0.toxicSpikes, s1.toxicSpikes] = [s1.toxicSpikes, s0.toxicSpikes];
      [s0.stickyWeb, s1.stickyWeb] = [s1.stickyWeb, s0.stickyWeb];
      [s0.tailwindTurns, s1.tailwindTurns] = [s1.tailwindTurns, s0.tailwindTurns];
      [s0.reflectTurns, s1.reflectTurns] = [s1.reflectTurns, s0.reflectTurns];
      [s0.lightScreenTurns, s1.lightScreenTurns] = [s1.lightScreenTurns, s0.lightScreenTurns];
      [s0.auroraVeilTurns, s1.auroraVeilTurns] = [s1.auroraVeilTurns, s0.auroraVeilTurns];
      [s0.safeguardTurns, s1.safeguardTurns] = [s1.safeguardTurns, s0.safeguardTurns];
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'perish-song') {
      for (const s of [0, 1] as const) {
        for (const idx of cur.state.sides[s].active) {
          if (idx < 0) continue;
          const tp = cur.state.sides[s].pokemon[idx];
          if (tp.fainted || tp.perishTurns > 0) continue;
          if (tp.abilityActive && activeAbilitySpec(ctx.sides[s].team[idx], tp).soundproof) continue;
          tp.perishTurns = 4;
        }
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'wish') {
      if (cur.state.sides[actorSide].wishTurns[action.slot] === 0) {
        cur.state.sides[actorSide].wishTurns[action.slot] = 2;
        cur.state.sides[actorSide].wishHp[action.slot] = Math.max(1, Math.trunc(atkStatic.maxhp / 2));
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'future-sight') {
      const targetSlot = action.targetSlot ?? 0;
      if (!cur.state.sides[oppSide].futureMoves[targetSlot]) {
        cur.state.sides[oppSide].futureMoves[targetSlot] = {
          turns: 3,
          sourceSide: actorSide,
          sourceIdx: pokeIdx,
          moveId: move.id,
        };
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'heal-bell') {
      for (const tp of cur.state.sides[actorSide].pokemon) {
        if (!tp.fainted) {
          tp.status = '';
          tp.statusTurns = 0;
        }
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'corrosive-gas') {
      for (const t of targetsPre) {
        const dp = cur.state.sides[t.side].pokemon[t.pokeIdx];
        const dsp = ctx.sides[t.side].team[t.pokeIdx];
        const sticky = dp.abilityActive && activeAbilitySpec(dsp, dp).stickyHold;
        if (!dp.fainted && !dp.protecting && dp.itemActive && dsp.itemRemovable && !sticky) {
          consumeItem(ctx, cur.state, t.side, t.pokeIdx);
        }
      }
      outActive.push(cur);
      continue;
    }

    // --- Self volatile/HP-cost status moves (Substitute, Belly Drum, Clangorous Soul, No Retreat, Curse, Focus Energy, Dragon Cheer, Charge, Aqua Ring, Ingrain, Destiny Bond, Acupressure) ---
    if (move.specialKind === 'substitute') {
      const cost = Math.trunc(atkStatic.maxhp / 4);
      if (p.substituteHp === 0 && cost > 0) {
        const split = splitBranchByHpPredicate({state: cur.state, probability: cur.probability}, actorSide, pokeIdx, hp => hp > cost);
        if (split.didSplit) stats.hpSplits++;
        if (split.matched) {
          const subBr: ActiveBranch = {
            state: split.matched.state,
            probability: split.matched.probability,
            remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
          };
          subBr.state.sides[actorSide].pokemon[pokeIdx].substituteHp = cost;
          outActive.push(...applyFixedDamageWithThresholds(ctx, subBr, actorSide, pokeIdx, cost, true, policy, stats));
        }
        if (split.unmatched) {
          split.unmatched.state.sides[actorSide].pokemon[pokeIdx].lastMoveFailed = true;
          outActive.push({state: split.unmatched.state, probability: split.unmatched.probability, remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}}))});
        }
      } else {
        p.lastMoveFailed = true;
        outActive.push(cur);
      }
      continue;
    }
    if (move.specialKind === 'belly-drum') {
      const cost = Math.trunc(atkStatic.maxhp / 2);
      if (p.boosts[0] < 6 && atkStatic.maxhp > 1 && cost > 0) {
        const split = splitBranchByHpPredicate({state: cur.state, probability: cur.probability}, actorSide, pokeIdx, hp => hp > cost);
        if (split.didSplit) stats.hpSplits++;
        if (split.matched) {
          const bdBr: ActiveBranch = {
            state: split.matched.state,
            probability: split.matched.probability,
            remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
          };
          const afterCost = applyFixedDamageWithThresholds(ctx, bdBr, actorSide, pokeIdx, cost, true, policy, stats);
          for (const b of afterCost) {
            if (!b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
              applyStatBoost(ctx, b.state, actorSide, pokeIdx, 'atk', 12, false);
            }
          }
          outActive.push(...afterCost);
        }
        if (split.unmatched) {
          split.unmatched.state.sides[actorSide].pokemon[pokeIdx].lastMoveFailed = true;
          outActive.push({state: split.unmatched.state, probability: split.unmatched.probability, remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}}))});
        }
      } else {
        p.lastMoveFailed = true;
        outActive.push(cur);
      }
      continue;
    }
    if (move.specialKind === 'clangorous-soul') {
      const cost = Math.trunc(atkStatic.maxhp / 3);
      if (cost > 0) {
        const split = splitBranchByHpPredicate({state: cur.state, probability: cur.probability}, actorSide, pokeIdx, hp => hp > cost);
        if (split.didSplit) stats.hpSplits++;
        if (split.matched) {
          const csBr: ActiveBranch = {
            state: split.matched.state,
            probability: split.matched.probability,
            remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
          };
          const afterCost = applyFixedDamageWithThresholds(ctx, csBr, actorSide, pokeIdx, cost, true, policy, stats);
          for (const b of afterCost) {
            if (!b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
              for (const st of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
                applyStatBoost(ctx, b.state, actorSide, pokeIdx, st, 1, false);
              }
            }
          }
          outActive.push(...afterCost);
        }
        if (split.unmatched) {
          split.unmatched.state.sides[actorSide].pokemon[pokeIdx].lastMoveFailed = true;
          outActive.push({state: split.unmatched.state, probability: split.unmatched.probability, remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}}))});
        }
      } else {
        outActive.push(cur);
      }
      continue;
    }
    if (move.specialKind === 'no-retreat') {
      if (!p.noRetreatUsed) {
        p.noRetreatUsed = true;
        p.trapped = true;
        for (const st of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
          applyStatBoost(ctx, cur.state, actorSide, pokeIdx, st, 1, false);
        }
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'curse') {
      if (!activeTypes(atkStatic, p).includes('Ghost')) {
        applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'spe', -1, false);
        applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'atk', 1, false);
        applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'def', 1, false);
        outActive.push(cur);
      } else {
        const t = targetsPre[0];
        if (t && !cur.state.sides[t.side].pokemon[t.pokeIdx].cursed) {
          cur.state.sides[t.side].pokemon[t.pokeIdx].cursed = true;
          const cost = Math.max(1, Math.trunc(atkStatic.maxhp / 2));
          outActive.push(...applyFixedDamageWithThresholds(ctx, cur, actorSide, pokeIdx, cost, true, policy, stats));
        } else {
          p.lastMoveFailed = true;
          outActive.push(cur);
        }
      }
      continue;
    }
    if (move.specialKind === 'focus-energy') {
      if (!p.focusEnergy) p.focusEnergy = true;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'dragon-cheer') {
      const allySlot = action.slot === 0 ? 1 : 0;
      const allyIdx = ctx.activeCount === 2 ? cur.state.sides[actorSide].active[allySlot] : -1;
      if (allyIdx >= 0 && !cur.state.sides[actorSide].pokemon[allyIdx].fainted) {
        const ap = cur.state.sides[actorSide].pokemon[allyIdx];
        const asp = ctx.sides[actorSide].team[allyIdx];
        if (ap.dragonCheer === 0) {
          ap.dragonCheer = activeTypes(asp, ap).includes('Dragon') ? 2 : 1;
        }
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'charge') {
      p.charged = true;
      applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'spd', 1, false);
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'aqua-ring') {
      if (!p.aquaRing) p.aquaRing = true;
      else p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'ingrain') {
      if (!p.ingrain) {
        p.ingrain = true;
        p.trapped = true;
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'destiny-bond') {
      p.destinyBond = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'acupressure') {
      const boostable: BoostStat[] = (['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'] as const).filter(
        st => p.boosts[BOOST_INDEX[st]] < 6
      );
      if (boostable.length > 0) {
        const pr = 1 / boostable.length;
        const choices = pickChoices(boostable.map(st => ({item: st, prob: pr})), policy, stats);
        for (const c of choices) {
          const st = choices.length === 1 ? cur.state : cloneState(cur.state);
          applyStatBoost(ctx, st, actorSide, pokeIdx, c.item, 2, false);
          outActive.push({state: st, probability: cur.probability * c.prob, remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}}))});
        }
      } else {
        p.lastMoveFailed = true;
        outActive.push(cur);
      }
      continue;
    }

    // --- Healing moves (Recover, Roost, Weather Heal, Rest) ---
    if (move.specialKind === 'heal-half' || move.specialKind === 'roost' || move.specialKind === 'heal-weather') {
      if (hpMin(p) >= atkStatic.maxhp && p.hp >= atkStatic.maxhp) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      let healAmt = Math.max(1, Math.round(atkStatic.maxhp / 2));
      if (move.specialKind === 'heal-weather') {
        const w = effectiveFieldWeather(ctx, cur.state);
        if (move.id === 'shoreup') {
          healAmt = w === 'sand' ? Math.round(atkStatic.maxhp * 2 / 3) : Math.round(atkStatic.maxhp / 2);
        } else {
          healAmt = w === 'sun' ? Math.round(atkStatic.maxhp * 2 / 3) : w !== '' ? Math.round(atkStatic.maxhp / 4) : Math.round(atkStatic.maxhp / 2);
        }
      }
      applyHeal(ctx, cur.state, actorSide, pokeIdx, healAmt);
      if (move.specialKind === 'roost') p.roosted = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'rest') {
      const leafGuardBlocked = p.abilityActive && atkAb.leafGuard && effectiveFieldWeather(ctx, cur.state) === 'sun';
      const sleepImmune = (p.abilityActive && (atkAb.statusImmune === 'slp' || atkAb.statusImmune === 'all')) ||
        sideHasActiveAbility(ctx, cur.state, actorSide, a => !!a.sweetVeil);
      if (hpMin(p) < atkStatic.maxhp && !leafGuardBlocked && !sleepImmune) {
        p.hp = atkStatic.maxhp;
        p.hpDist = null;
        p.status = 'slp';
        p.statusTurns = 3;
        maybeTriggerStatusBerry(ctx, cur.state, actorSide, pokeIdx);
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }

    // --- Pure self-targeting status move (Swords Dance, Dragon Dance, Nasty Plot, Calm Mind, Minimize, etc.) ---
    if (move.category === 'Status' && move.target === 'self' && move.specialKind === 'standard') {
      if (move.selfBoosts) {
        for (const [stat, delta] of Object.entries(move.selfBoosts) as [BoostStat, number][]) {
          applyStatBoost(ctx, cur.state, actorSide, pokeIdx, stat, delta, false);
        }
      }
      outActive.push(cur);
      continue;
    }

    // --- Encore / Taunt / Disable / Torment (blocked by Aroma Veil!) ---
    if (move.specialKind === 'encore' || move.specialKind === 'taunt' || move.specialKind === 'disable' || move.specialKind === 'torment') {
      const targets = targetsPre;
      if (targets.length === 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      let tSide = targets[0].side;
      let tSlot = targets[0].slot;
      let tIdx = targets[0].pokeIdx;
      const moldBreaker = p.abilityActive && !!atkAb.moldBreaker;

      // Magic Bounce reflection for reflectable status moves
      if (move.reflectable && !moldBreaker && tSide !== actorSide) {
        const dp0 = cur.state.sides[tSide].pokemon[tIdx];
        if (dp0.abilityActive && activeAbilitySpec(ctx.sides[tSide].team[tIdx], dp0).magicBounce) {
          tSide = actorSide;
          tSlot = action.slot;
          tIdx = pokeIdx;
        }
      }

      const def = cur.state.sides[tSide].pokemon[tIdx];
      const defStatic = ctx.sides[tSide].team[tIdx];
      const defAb = activeAbilitySpec(defStatic, def);
      const pranksterBlocked = p.abilityActive && atkAb.prankster && tSide !== actorSide && activeTypes(defStatic, def).includes('Dark');
      const aromaProtected = !moldBreaker && sideHasActiveAbility(ctx, cur.state, tSide, a => !!a.aromaVeil);

      if ((move.protectable && def.protecting && tSide !== actorSide) || pranksterBlocked || aromaProtected ||
          (def.abilityActive && !moldBreaker && defAb.goodAsGold && tSide !== actorSide)) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      if (move.specialKind === 'encore') {
        if (def.encoreMoveIdx >= 0 || def.lastMoveIdx < 0) { p.lastMoveFailed = true; outActive.push(cur); continue; }
        const lastMove = defStatic.moves[def.lastMoveIdx];
        if (!lastMove || lastMove.failEncore || def.pp[def.lastMoveIdx] <= 0) { p.lastMoveFailed = true; outActive.push(cur); continue; }
      } else if (move.specialKind === 'taunt') {
        if (def.tauntTurns > 0 || (def.abilityActive && !moldBreaker && defAb.oblivious)) { p.lastMoveFailed = true; outActive.push(cur); continue; }
      } else if (move.specialKind === 'disable') {
        if (def.disabledMoveIdx >= 0 || def.lastMoveIdx < 0 || def.pp[def.lastMoveIdx] <= 0) { p.lastMoveFailed = true; outActive.push(cur); continue; }
      } else if (move.specialKind === 'torment') {
        if (def.tormented) { p.lastMoveFailed = true; outActive.push(cur); continue; }
      }
      const accProb = tSide === actorSide ? 1 : accuracyProbability(ctx, cur.state, actorSide, pokeIdx, tSide, tIdx, move);
      const choices = pickChoices([{item: true, prob: accProb}, {item: false, prob: 1 - accProb}], policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? cur.state : cloneState(cur.state);
        if (c.item) {
          const dp = st.sides[tSide].pokemon[tIdx];
          const willMove = cur.remainingActions.some(ra => ra.side === tSide && ra.action.slot === tSlot);
          if (move.specialKind === 'encore') {
            dp.encoreMoveIdx = dp.lastMoveIdx;
            dp.encoreTurns = willMove ? 3 : 4;
          } else if (move.specialKind === 'taunt') {
            dp.tauntTurns = willMove ? 3 : 4;
          } else if (move.specialKind === 'disable') {
            dp.disabledMoveIdx = dp.lastMoveIdx;
            dp.disabledTurns = willMove ? 4 : 5;
          } else if (move.specialKind === 'torment') {
            dp.tormented = true;
          }
        } else {
          st.sides[actorSide].pokemon[pokeIdx].lastMoveFailed = true;
        }
        outActive.push({
          state: st,
          probability: cur.probability * c.prob,
          remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
        });
      }
      continue;
    }

    // --- Wave 3 Self / Side / Field Status Moves ---
    if (move.specialKind === 'recycle') {
      if (p.itemActive || !p.lastItemId) {
        p.lastMoveFailed = true;
      } else {
        const restored = p.lastItemId;
        p.lastItemId = '';
        setPokemonItem(cur.state, actorSide, pokeIdx, restored);
        maybeTriggerStatusBerry(ctx, cur.state, actorSide, pokeIdx);
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'stuff-cheeks') {
      const it = activeItemSpec(ctx, atkStatic, p);
      if (!isItemEffectActive(cur.state, atkStatic, p) || !it.isBerry) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const boosted = applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'def', 2, false);
      if (boosted) {
        const bId = it.id;
        consumeItem(ctx, cur.state, actorSide, pokeIdx, true, true);
        eatBerryEffect(ctx, cur.state, actorSide, pokeIdx, bId, false, false);
      } else {
        p.lastMoveFailed = true;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'teatime') {
      let anyAte = false;
      for (const s of [0, 1] as const) {
        for (const idx of cur.state.sides[s].active) {
          if (idx < 0) continue;
          const tp = cur.state.sides[s].pokemon[idx];
          const tsp = ctx.sides[s].team[idx];
          if (tp.fainted || tp.invulnerable) continue;
          const tit = activeItemSpec(ctx, tsp, tp);
          if (isItemEffectActive(cur.state, tsp, tp) && tit.isBerry) {
            const bId = tit.id;
            consumeItem(ctx, cur.state, s, idx, true, true);
            eatBerryEffect(ctx, cur.state, s, idx, bId, false, false);
            anyAte = true;
          }
        }
      }
      if (!anyAte) p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'magnet-rise') {
      if (p.magnetRiseTurns > 0 || p.ingrain || p.smackedDown || cur.state.field.gravityTurns > 0) {
        p.lastMoveFailed = true;
      } else {
        p.magnetRiseTurns = 5;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'magnetic-flux') {
      let anyBoost = false;
      for (const aIdx of cur.state.sides[actorSide].active) {
        if (aIdx < 0) continue;
        const ap = cur.state.sides[actorSide].pokemon[aIdx];
        const aSp = ctx.sides[actorSide].team[aIdx];
        if (!ap.fainted && ap.abilityActive && !ap.gastroAcid && activeAbilitySpec(aSp, ap).plusMinus) {
          const b1 = applyStatBoost(ctx, cur.state, actorSide, aIdx, 'def', 1, false);
          const b2 = applyStatBoost(ctx, cur.state, actorSide, aIdx, 'spd', 1, false);
          if (b1 || b2) anyBoost = true;
        }
      }
      if (!anyBoost) p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'stockpile') {
      if (p.stockpileLayers >= 3) {
        p.lastMoveFailed = true;
      } else {
        p.stockpileLayers++;
        const prevDef = p.boosts[1];
        const prevSpd = p.boosts[3];
        applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'def', 1, false);
        applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'spd', 1, false);
        p.stockpileDef += p.boosts[1] - prevDef;
        p.stockpileSpd += p.boosts[3] - prevSpd;
      }
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'swallow') {
      const layers = p.stockpileLayers;
      const frac = layers === 1 ? 0.25 : layers === 2 ? 0.5 : 1;
      applyHeal(ctx, cur.state, actorSide, pokeIdx, Math.max(1, pokeRound(ctx, atkStatic.maxhp, frac)));
      if (p.stockpileDef !== 0) applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'def', -p.stockpileDef, false);
      if (p.stockpileSpd !== 0) applyStatBoost(ctx, cur.state, actorSide, pokeIdx, 'spd', -p.stockpileSpd, false);
      p.stockpileLayers = 0;
      p.stockpileDef = 0;
      p.stockpileSpd = 0;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'power-trick' || move.specialKind === 'power-shift') {
      p.powerTrick = !p.powerTrick;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'imprison') {
      if (p.imprison) p.lastMoveFailed = true;
      else p.imprison = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'healing-wish') {
      const bench = legalBenchSwitches(cur.state.sides[actorSide]);
      if (bench.length === 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      p.hp = 0;
      p.hpDist = null;
      p.fainted = true;
      cur.state.sides[actorSide].healingWish[action.slot] = true;
      if (checkEnded(cur.state, oppSide)) {
        ended.push({state: cur.state, probability: cur.probability});
      } else {
        outActive.push(cur);
      }
      continue;
    }
    if (move.specialKind === 'baton-pass') {
      const bench = legalBenchSwitches(cur.state.sides[actorSide]);
      if (bench.length === 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      cur.state.phase = {
        kind: 'switch',
        pendingSlots: [{side: actorSide, slot: action.slot, batonPass: true}],
        remainingActions: cur.remainingActions,
        needsEndOfTurn: true,
      };
      paused.push({state: cur.state, probability: cur.probability});
      continue;
    }
    if (move.specialKind === 'shed-tail') {
      const bench = legalBenchSwitches(cur.state.sides[actorSide]);
      const cost = Math.ceil(atkStatic.maxhp / 2);
      if (bench.length === 0 || p.substituteHp > 0 || p.hp <= cost) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      p.hp -= cost;
      p.hpDist = null;
      const subHp = Math.max(1, Math.floor(atkStatic.maxhp / 4));
      p.substituteHp = subHp;
      cur.state.phase = {
        kind: 'switch',
        pendingSlots: [{side: actorSide, slot: action.slot, shedTailHp: subHp}],
        remainingActions: cur.remainingActions,
        needsEndOfTurn: true,
      };
      paused.push({state: cur.state, probability: cur.probability});
      continue;
    }
    if (move.specialKind === 'revival-blessing') {
      const hasFainted = cur.state.sides[actorSide].pokemon.some((m, i) => m.fainted && !cur.state.sides[actorSide].active.includes(i));
      if (!hasFainted) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      cur.state.phase = {
        kind: 'switch',
        pendingSlots: [{side: actorSide, slot: action.slot, revive: true}],
        remainingActions: cur.remainingActions,
        needsEndOfTurn: true,
      };
      paused.push({state: cur.state, probability: cur.probability});
      continue;
    }

    // --- Target Status Moves (Status inflict, Leech Seed, Yawn, Parting Shot, Defog, Roar, Heal Pulse, Strength Sap, Pain Split, Type-changers, Stat swaps, Trap, Spite) ---
    if (move.category === 'Status') {
      const targets = targetsPre;
      if (targets.length === 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      let tSide = targets[0].side;
      let tSlot = targets[0].slot;
      let tIdx = targets[0].pokeIdx;
      const moldBreaker = p.abilityActive && !!atkAb.moldBreaker;
      const corrosion = p.abilityActive && !!atkAb.corrosion;

      // Magic Bounce reflects reflectable target status moves back onto the caster!
      let bounced = false;
      if (move.reflectable && !moldBreaker && tSide !== actorSide) {
        const dp0 = cur.state.sides[tSide].pokemon[tIdx];
        if (dp0.abilityActive && activeAbilitySpec(ctx.sides[tSide].team[tIdx], dp0).magicBounce) {
          tSide = actorSide;
          tSlot = action.slot;
          tIdx = pokeIdx;
          bounced = true;
        }
      }

      const def = cur.state.sides[tSide].pokemon[tIdx];
      const defStatic = ctx.sides[tSide].team[tIdx];
      const defAb = activeAbilitySpec(defStatic, def);
      const blockedBySub = !bounced && def.substituteHp > 0 && !move.bypassSub && !(p.abilityActive && atkAb.infiltrator) &&
        move.specialKind !== 'psych-up' && move.specialKind !== 'power-swap' && move.specialKind !== 'guard-swap' && move.specialKind !== 'speed-swap';
      const pranksterBlocked = !bounced && p.abilityActive && atkAb.prankster && tSide !== actorSide && activeTypes(defStatic, def).includes('Dark');

      if ((!bounced && move.protectable && def.protecting) || blockedBySub || pranksterBlocked ||
          (!bounced && def.abilityActive && !moldBreaker && defAb.goodAsGold && tSide !== actorSide) ||
          (move.powder && (activeTypes(defStatic, def).includes('Grass') || (def.abilityActive && !moldBreaker && defAb.overcoat) ||
            (isItemEffectActive(cur.state, defStatic, def) && activeItemSpec(ctx, defStatic, def).archetype === 'safety-goggles')))) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      if (move.statusInflict && !canApplyStatus(ctx, cur.state, tSide, tIdx, move.statusInflict, moldBreaker, corrosion, tSide !== actorSide)) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      if (move.type === 'Electric' && move.statusInflict === 'par' && typeEffectiveness(ctx, 'Electric', activeTypes(defStatic, def)).immune) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      if (move.specialKind === 'leech-seed' && (activeTypes(defStatic, def).includes('Grass') || def.leechSeedSlot >= 0)) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      if (move.specialKind === 'yawn' && (def.yawnTurns > 0 || !canApplyStatus(ctx, cur.state, tSide, tIdx, 'slp', moldBreaker))) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }

      const accProb = bounced ? 1 : accuracyProbability(ctx, cur.state, actorSide, pokeIdx, tSide, tIdx, move);
      const choices = pickChoices([{item: true, prob: accProb}, {item: false, prob: 1 - accProb}], policy, stats);
      for (const c of choices) {
        const st = choices.length === 1 ? cur.state : cloneState(cur.state);
        const br: ActiveBranch = {
          state: st,
          probability: cur.probability * c.prob,
          remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
        };
        if (!c.item) {
          st.sides[actorSide].pokemon[pokeIdx].lastMoveFailed = true;
          outActive.push(br);
          continue;
        }
        const dp = st.sides[tSide].pokemon[tIdx];
        const ap = st.sides[actorSide].pokemon[pokeIdx];
        if (move.specialKind === 'defog') {
          st.sides[tSide].reflectTurns = 0;
          st.sides[tSide].lightScreenTurns = 0;
          st.sides[tSide].auroraVeilTurns = 0;
          st.sides[tSide].safeguardTurns = 0;
          for (const s of [0, 1] as const) {
            st.sides[s].stealthRock = false;
            st.sides[s].spikes = 0;
            st.sides[s].toxicSpikes = 0;
            st.sides[s].stickyWeb = false;
          }
          applyStatBoost(ctx, st, tSide, tIdx, 'eva', -1, !bounced, moldBreaker, actorSide, pokeIdx);
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'force-switch') {
          const dAbFs = activeAbilitySpec(defStatic, dp);
          const blockedFs = dp.ingrain || (dp.abilityActive && !moldBreaker && (dAbFs.suctionCups || dAbFs.guardDog));
          const bench = blockedFs ? [] : legalBenchSwitches(st.sides[tSide]);
          if (bench.length > 0) {
            const pSw = 1 / bench.length;
            const swChoices = pickChoices(bench.map(bi => ({item: bi, prob: pSw})), policy, stats);
            for (const swc of swChoices) {
              const swSt = swChoices.length === 1 ? st : cloneState(st);
              const swBr: ActiveBranch = {
                state: swSt,
                probability: br.probability * swc.prob,
                remainingActions: br.remainingActions.filter(ra => !(ra.side === tSide && ra.action.slot === tSlot)),
              };
              outActive.push(...performSwitchIn(ctx, [swBr], tSide, tSlot, swc.item, policy, stats));
            }
          } else {
            outActive.push(br);
          }
          continue;
        }
        if (move.specialKind === 'parting-shot') {
          const s1 = applyStatBoost(ctx, st, tSide, tIdx, 'atk', -1, !bounced, moldBreaker, actorSide, pokeIdx);
          const s2 = applyStatBoost(ctx, st, tSide, tIdx, 'spa', -1, !bounced, moldBreaker, actorSide, pokeIdx);
          const mirrored = dp.abilityActive && !moldBreaker && activeAbilitySpec(defStatic, dp).mirrorArmor;
          if ((s1 || s2 || mirrored) && !bounced && !ap.fainted) {
            const bench = legalBenchSwitches(st.sides[actorSide]);
            if (bench.length > 0) {
              st.phase = {
                kind: 'switch',
                pendingSlots: [{side: actorSide, slot: action.slot}],
                remainingActions: br.remainingActions,
                needsEndOfTurn: true,
              };
              paused.push({state: st, probability: br.probability});
              continue;
            }
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'leech-seed') {
          dp.leechSeedSlot = action.slot;
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'yawn') {
          dp.yawnTurns = 2;
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'heal-pulse') {
          const mult = ap.abilityActive && atkAb.megaLauncher ? 0.75 : 0.5;
          applyHeal(ctx, st, tSide, tIdx, Math.max(1, Math.round(defStatic.maxhp * mult)));
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'strength-sap') {
          const targetAtk = applyBoostToStat(activeStats(defStatic, dp).atk, dp.boosts[0]);
          const lowered = applyStatBoost(ctx, st, tSide, tIdx, 'atk', -1, !bounced, moldBreaker, actorSide, pokeIdx);
          if (lowered && targetAtk > 0) {
            if (dp.abilityActive && !moldBreaker && activeAbilitySpec(defStatic, dp).liquidOoze) {
              outActive.push(...applyFixedDamageWithThresholds(ctx, br, actorSide, pokeIdx, targetAtk, true, policy, stats, true));
              continue;
            }
            applyHeal(ctx, st, actorSide, pokeIdx, targetAtk);
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'pain-split') {
          const avg = Math.max(1, Math.floor((ap.hp + dp.hp) / 2));
          ap.hp = Math.min(atkStatic.maxhp, avg);
          ap.hpDist = null;
          dp.hp = Math.min(defStatic.maxhp, avg);
          dp.hpDist = null;
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'soak') {
          dp.types = ['Water'];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'magic-powder') {
          dp.types = ['Psychic'];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'trick-or-treat') {
          const curT = activeTypes(defStatic, dp);
          if (!curT.includes('Ghost')) dp.types = [...curT, 'Ghost'];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'forests-curse') {
          const curT = activeTypes(defStatic, dp);
          if (!curT.includes('Grass')) dp.types = [...curT, 'Grass'];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'topsy-turvy') {
          for (let bi = 0; bi < 7; bi++) dp.boosts[bi] = -dp.boosts[bi];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'psych-up') {
          for (let bi = 0; bi < 7; bi++) ap.boosts[bi] = dp.boosts[bi];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'power-swap') {
          [ap.boosts[0], dp.boosts[0]] = [dp.boosts[0], ap.boosts[0]];
          [ap.boosts[2], dp.boosts[2]] = [dp.boosts[2], ap.boosts[2]];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'guard-swap') {
          [ap.boosts[1], dp.boosts[1]] = [dp.boosts[1], ap.boosts[1]];
          [ap.boosts[3], dp.boosts[3]] = [dp.boosts[3], ap.boosts[3]];
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'speed-swap') {
          const sA = activeStats(atkStatic, ap).spe;
          const sD = activeStats(defStatic, dp).spe;
          ap.statOverride = {...(ap.statOverride ?? {}), spe: sD};
          dp.statOverride = {...(dp.statOverride ?? {}), spe: sA};
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'spite') {
          if (dp.lastMoveIdx >= 0 && dp.pp[dp.lastMoveIdx] > 0) {
            dp.pp[dp.lastMoveIdx] = Math.max(0, dp.pp[dp.lastMoveIdx] - 4);
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'trap-target') {
          dp.trapped = true;
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'trick') {
          const myItem = activeItemId(atkStatic, ap);
          const theirItem = activeItemId(defStatic, dp);
          const myOk = !myItem || canRemoveItem(ctx, st, actorSide, pokeIdx, false);
          const theirOk = !theirItem || canRemoveItem(ctx, st, tSide, tIdx, actorSide !== tSide);
          if ((myItem || theirItem) && myOk && theirOk) {
            setPokemonItem(st, actorSide, pokeIdx, theirItem);
            setPokemonItem(st, tSide, tIdx, myItem);
            ap.choiceLockedMoveIdx = -1;
            dp.choiceLockedMoveIdx = -1;
            maybeTriggerStatusBerry(ctx, st, actorSide, pokeIdx);
            maybeTriggerStatusBerry(ctx, st, tSide, tIdx);
            maybeTriggerTerrainSeed(ctx, st, actorSide, pokeIdx);
            maybeTriggerTerrainSeed(ctx, st, tSide, tIdx);
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'gastro-acid') {
          const dAbId = activeAbilitySpec(defStatic, dp).id;
          if (!dp.gastroAcid && !abilityFlags(ctx, dAbId).cantsuppress) {
            dp.gastroAcid = true;
            dp.abilityActive = false;
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'worry-seed') {
          const dAbId = activeAbilitySpec(defStatic, dp).id;
          if (dAbId !== 'insomnia' && dAbId !== 'truant' && tryChangeAbility(ctx, st, tSide, tIdx, 'insomnia')) {
            if (dp.status === 'slp') {
              dp.status = '';
              dp.statusTurns = 0;
            }
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'simple-beam') {
          const dAbId = activeAbilitySpec(defStatic, dp).id;
          if (dAbId !== 'simple' && dAbId !== 'truant' && tryChangeAbility(ctx, st, tSide, tIdx, 'simple')) {
            // ability changed
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'entrainment') {
          const aAbId = activeAbilitySpec(atkStatic, ap).id;
          const dAbId = activeAbilitySpec(defStatic, dp).id;
          if (aAbId && aAbId !== dAbId && dAbId !== 'truant' && !abilityFlags(ctx, aAbId).noentrain &&
              tryChangeAbility(ctx, st, tSide, tIdx, aAbId)) {
            triggerEntryAbilities(ctx, st, tSide, tIdx);
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'role-play') {
          const aAbId = activeAbilitySpec(atkStatic, ap).id;
          const dAbId = activeAbilitySpec(defStatic, dp).id;
          if (dAbId && aAbId !== dAbId && !abilityFlags(ctx, dAbId).failroleplay &&
              tryChangeAbility(ctx, st, actorSide, pokeIdx, dAbId)) {
            triggerEntryAbilities(ctx, st, actorSide, pokeIdx);
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'skill-swap') {
          if (trySkillSwap(ctx, st, actorSide, pokeIdx, tSide, tIdx)) {
            triggerEntryAbilities(ctx, st, actorSide, pokeIdx);
            triggerEntryAbilities(ctx, st, tSide, tIdx);
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'lock-on') {
          ap.lockOnTurns = 2;
          ap.lockOnSide = tSide;
          ap.lockOnSlot = tSlot;
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'power-split') {
          const sA = activeStats(atkStatic, ap);
          const sD = activeStats(defStatic, dp);
          const avgAtk = Math.floor((sA.atk + sD.atk) / 2);
          const avgSpa = Math.floor((sA.spa + sD.spa) / 2);
          ap.statOverride = {...(ap.statOverride ?? {}), atk: avgAtk, spa: avgSpa};
          dp.statOverride = {...(dp.statOverride ?? {}), atk: avgAtk, spa: avgSpa};
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'guard-split') {
          const sA = activeStats(atkStatic, ap);
          const sD = activeStats(defStatic, dp);
          const avgDef = Math.floor((sA.def + sD.def) / 2);
          const avgSpd = Math.floor((sA.spd + sD.spd) / 2);
          ap.statOverride = {...(ap.statOverride ?? {}), def: avgDef, spd: avgSpd};
          dp.statOverride = {...(dp.statOverride ?? {}), def: avgDef, spd: avgSpd};
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'reflect-type') {
          const dTypes = activeTypes(defStatic, dp).filter(t => t !== '???');
          if (dTypes.length > 0) {
            ap.types = [...dTypes];
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'octolock') {
          if (dp.octolockSide < 0) {
            dp.octolockSide = actorSide;
            dp.octolockSlot = action.slot;
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'electrify') {
          const targetPending = br.remainingActions.some(ra => ra.side === tSide && ra.action.slot === tSlot);
          if (targetPending && !dp.electrified) {
            dp.electrified = true;
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'attract') {
          const dAbNow = activeAbilitySpec(defStatic, dp);
          const oppositeGender = (atkStatic.gender === 'M' && defStatic.gender === 'F') ||
            (atkStatic.gender === 'F' && defStatic.gender === 'M');
          const immuneAttract = !oppositeGender || dp.attractSide >= 0 ||
            (dp.abilityActive && !dp.gastroAcid && !moldBreaker && dAbNow.oblivious);
          if (!immuneAttract) {
            dp.attractSide = actorSide;
            dp.attractSlot = action.slot;
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.specialKind === 'transform') {
          if (tryTransformInto(ctx, st, actorSide, pokeIdx, tSide, tIdx)) {
            triggerEntryAbilities(ctx, st, actorSide, pokeIdx);
          } else {
            ap.lastMoveFailed = true;
          }
          outActive.push(br);
          continue;
        }
        if (move.targetBoosts) {
          for (const [stat, delta] of Object.entries(move.targetBoosts) as [BoostStat, number][]) {
            applyStatBoost(ctx, st, tSide, tIdx, stat, delta, actorSide !== tSide, moldBreaker, actorSide, pokeIdx);
          }
        }
        if (move.statusInflict) {
          outActive.push(...inflictStatusWithBranching(ctx, br, tSide, tIdx, move.statusInflict, policy, stats, moldBreaker, actorSide, pokeIdx, corrosion));
        } else if (move.volatileStatus === 'confusion') {
          outActive.push(...inflictConfusionWithBranching(ctx, br, tSide, tIdx, policy, stats, moldBreaker));
        } else {
          outActive.push(br);
        }
      }
      continue;
    }

    // --- Pollen Puff targeting an ally heals 50% maxHP instead of dealing damage! ---
    if (move.specialKind === 'pollen-puff' && targetsPre.length === 1 && targetsPre[0].side === actorSide) {
      const t = targetsPre[0];
      const allyStatic = ctx.sides[t.side].team[t.pokeIdx];
      applyHeal(ctx, cur.state, t.side, t.pokeIdx, Math.max(1, Math.round(allyStatic.maxhp / 2)));
      outActive.push(cur);
      continue;
    }

    // --- Damp blocks Explosion / Self-Destruct / Misty Explosion ---
    if (move.specialKind === 'self-ko' && fieldHasActiveAbility(ctx, cur.state, a => !!a.damp)) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // --- Burn Up / Double Shock require Fire / Electric type ---
    if (move.specialKind === 'burn-up' && !activeTypes(atkStatic, p).includes('Fire')) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    if (move.specialKind === 'double-shock' && !activeTypes(atkStatic, p).includes('Electric')) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // --- Steel Roller fails if no Terrain is active ---
    if (move.specialKind === 'steel-roller' && cur.state.field.terrain === '') {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // --- Fake Out / First Impression (turn-1 only) ---
    if (move.specialKind === 'fake-out' && p.activeTurns > 0) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }

    // --- Sucker Punch / Upper Hand pre-check ---
    if (move.suckerPunch || move.specialKind === 'upper-hand') {
      if (targetsPre.length === 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const t = targetsPre[0];
      const def = cur.state.sides[t.side].pokemon[t.pokeIdx];
      const pendingTargetAction = cur.remainingActions.find(
        ra => ra.side === t.side && ra.action.slot === t.slot
      );
      if (!pendingTargetAction || def.mustRecharge) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      const targetMoveIdx = def.encoreMoveIdx >= 0 ? def.encoreMoveIdx : pendingTargetAction.action.moveIndex;
      const targetMove = getMoveForAction(ctx, t.side, t.pokeIdx, targetMoveIdx, cur.state);
      if (targetMove.category === 'Status' || (move.specialKind === 'upper-hand' && pendingTargetAction.priority <= 0)) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
    }

    // --- Fling pre-check & item throw ---
    let flingItemId: string | undefined;
    let flingPower: number | undefined;
    if (move.specialKind === 'fling') {
      const fId = activeItemId(atkStatic, p);
      const fSpec = activeItemSpec(ctx, atkStatic, p);
      if (!fId || !isItemEffectActive(cur.state, atkStatic, p) || !canRemoveItem(ctx, cur.state, actorSide, pokeIdx, false) || fSpec.flingPower <= 0) {
        p.lastMoveFailed = true;
        outActive.push(cur);
        continue;
      }
      flingItemId = fId;
      flingPower = fSpec.flingPower;
      consumeItem(ctx, cur.state, actorSide, pokeIdx, false, true);
    }

    // --- Uproar wakes all sleeping active Pokemon and locks for 3 turns ---
    if (move.specialKind === 'uproar') {
      for (const s of [0, 1] as const) {
        for (const aIdx of cur.state.sides[s].active) {
          if (aIdx >= 0 && cur.state.sides[s].pokemon[aIdx].status === 'slp') {
            cur.state.sides[s].pokemon[aIdx].status = '';
            cur.state.sides[s].pokemon[aIdx].statusTurns = 0;
          }
        }
      }
      if (p.uproarTurns === 0) {
        p.uproarTurns = 3;
      }
    }

    // --- Round: boost ally's queued Round to act immediately next (roundUsedThisTurn set after this hit resolves) ---
    if (move.specialKind === 'round') {
      for (const ra of cur.remainingActions) {
        if (ra.side === actorSide && ra.action.slot !== action.slot) {
          const allyIdx = cur.state.sides[actorSide].active[ra.action.slot];
          if (allyIdx >= 0 && !cur.state.sides[actorSide].pokemon[allyIdx].fainted) {
            const allyP = cur.state.sides[actorSide].pokemon[allyIdx];
            const allyMoveIdx = allyP.encoreMoveIdx >= 0 ? allyP.encoreMoveIdx : ra.action.moveIndex;
            const allyMove = getMoveForAction(ctx, actorSide, allyIdx, allyMoveIdx, cur.state);
            if (allyMove.specialKind === 'round') {
              ra.priority = 99;
            }
          }
        }
      }
    }

    // --- Damaging moves (single, spread, multi-hit, Parental Bond, Triple Axel, Fickle Beam, Beat Up, Shell Side Arm, OHKO) ---
    const targets = targetsPre;
    if (targets.length === 0) {
      p.lastMoveFailed = true;
      outActive.push(cur);
      continue;
    }
    const isSpread = (move.target === 'allAdjacentFoes' || move.target === 'allAdjacent') && targets.length > 1;
    const analyticBoost = p.abilityActive && !!atkAb.analytic && cur.remainingActions.every(ra => {
      const idx = cur.state.sides[ra.side].active[ra.action.slot];
      return idx < 0 || cur.state.sides[ra.side].pokemon[idx].fainted;
    });

    // Fickle Beam: 30% chance to double base power
    let initialMoveBranches: {ab: ActiveBranch; hitAny: boolean; fickleDouble: boolean}[];
    if (move.specialKind === 'fickle-beam') {
      const fChoices = pickChoices([{item: false, prob: 0.7}, {item: true, prob: 0.3}], policy, stats);
      initialMoveBranches = fChoices.map(c => ({
        ab: {
          state: fChoices.length === 1 ? cur.state : cloneState(cur.state),
          probability: cur.probability * c.prob,
          remainingActions: cur.remainingActions.map(a => ({...a, action: {...a.action}})),
        },
        hitAny: false,
        fickleDouble: c.item,
      }));
    } else {
      initialMoveBranches = [{ab: cur, hitAny: false, fickleDouble: false}];
    }

    let moveBranches = initialMoveBranches;

    for (const t of targets) {
      const nextMoveBranches: {ab: ActiveBranch; hitAny: boolean; fickleDouble: boolean}[] = [];

      for (const mb of moveBranches) {
        const atk = mb.ab.state.sides[actorSide].pokemon[pokeIdx];
        const def = mb.ab.state.sides[t.side].pokemon[t.pokeIdx];
        if (atk.fainted || def.fainted) {
          nextMoveBranches.push(mb);
          continue;
        }
        const defStatic = ctx.sides[t.side].team[t.pokeIdx];
        const defAb = activeAbilitySpec(defStatic, def);
        const moldBreaker = atk.abilityActive && !!atkAb.moldBreaker;
        const defAbActive = def.abilityActive && !moldBreaker;

        // Semi-invulnerable target check (Fly / Bounce / Dig / Dive / Phantom Force; Lock-On & No Guard bypass)
        const lockedOn = atk.lockOnTurns > 0 && atk.lockOnSide === t.side && atk.lockOnSlot === t.slot;
        if (def.invulnerable && !(atk.abilityActive && atkAb.noGuard) && !lockedOn) {
          const canHitInvuln =
            (def.invulnerable === 'fly' && (move.id === 'thunder' || move.id === 'hurricane' || move.id === 'smackdown')) ||
            (def.invulnerable === 'dig' && move.id === 'earthquake') ||
            (def.invulnerable === 'dive' && move.id === 'surf');
          if (!canHitInvuln) {
            nextMoveBranches.push(mb);
            continue;
          }
        }

        // Telepathy: ally immune to ally damaging moves
        if (t.side === actorSide && defAbActive && defAb.telepathy) {
          nextMoveBranches.push(mb);
          continue;
        }

        // Poltergeist fails if target has no active item
        if (move.specialKind === 'poltergeist' && !def.itemActive) {
          nextMoveBranches.push(mb);
          continue;
        }

        // Priority blockers (Psychic Terrain, Armor Tail, Queenly Majesty, Quick Guard)
        const effPriority = move.priority +
          (atk.abilityActive && atkAb.galeWings && move.type === 'Flying' && hpMin(atk) === atkStatic.maxhp ? 1 : 0) +
          (move.specialKind === 'grassy-glide' && mb.ab.state.field.terrain === 'grassy' && isGrounded(atkStatic, atk, mb.ab.state) ? 1 : 0);
        if (effPriority > 0 && t.side !== actorSide) {
          if (mb.ab.state.sides[t.side].quickGuard ||
              (mb.ab.state.field.terrain === 'psychic' && isGrounded(defStatic, def, mb.ab.state)) ||
              (defAbActive && defAb.priorityBlock)) {
            nextMoveBranches.push(mb);
            continue;
          }
        }

        // Wide Guard blocks spread moves
        if ((move.target === 'allAdjacentFoes' || move.target === 'allAdjacent') && t.side !== actorSide && mb.ab.state.sides[t.side].wideGuard) {
          nextMoveBranches.push(mb);
          continue;
        }

        // Shell Side Arm picks Physical+contact vs Special per target (50/50 on tie)
        let ssaOptions: {cat?: MoveCategory; contact?: boolean; prob: number}[] = [{prob: 1}];
        if (move.specialKind === 'shell-side-arm') {
          const aSt = activeStats(atkStatic, atk);
          const dSt = activeStats(defStatic, def);
          const lvl = Math.floor(2 * atkStatic.level / 5 + 2);
          const pEst = Math.floor(Math.floor(Math.floor(lvl * 90 * applyBoostToStat(aSt.atk, atk.boosts[0])) / Math.max(1, applyBoostToStat(dSt.def, def.boosts[1]))) / 50);
          const sEst = Math.floor(Math.floor(Math.floor(lvl * 90 * applyBoostToStat(aSt.spa, atk.boosts[2])) / Math.max(1, applyBoostToStat(dSt.spd, def.boosts[3]))) / 50);
          if (pEst > sEst) {
            ssaOptions = [{cat: 'Physical', contact: true, prob: 1}];
          } else if (sEst > pEst) {
            ssaOptions = [{cat: 'Special', contact: false, prob: 1}];
          } else {
            ssaOptions = [
              {cat: 'Physical', contact: true, prob: 0.5},
              {cat: 'Special', contact: false, prob: 0.5},
            ];
          }
        }
        const pickedSsa = pickChoices(ssaOptions.map(o => ({item: o, prob: o.prob})), policy, stats);
        for (const ssa of pickedSsa) {
          const ssaState = pickedSsa.length === 1 ? mb.ab.state : cloneState(mb.ab.state);
          const ssaAb: ActiveBranch = {
            state: ssaState,
            probability: mb.ab.probability * ssa.prob,
            remainingActions: mb.ab.remainingActions.map(a => ({...a, action: {...a.action}})),
          };
          const ssaAtk = ssaState.sides[actorSide].pokemon[pokeIdx];
          const ssaDef = ssaState.sides[t.side].pokemon[t.pokeIdx];
          const categoryOverride = ssa.item.cat;
          const contactOverride = ssa.item.contact;

          // Protect check (+ Unseen Fist / Piercing Drill / Feint / Phantom Force bypass!)
          let bypassProtect = false;
          const makesContact = (contactOverride ?? move.contact) && !(ssaAtk.abilityActive && atkAb.longReach);
          if (move.specialKind === 'feint' || move.id === 'phantomforce') {
            ssaDef.protecting = false;
            ssaState.sides[t.side].wideGuard = false;
            ssaState.sides[t.side].quickGuard = false;
          } else if (move.protectable && ssaDef.protecting) {
            if (makesContact && ssaAtk.abilityActive && atkAb.protectBypassContact) {
              bypassProtect = true;
            } else {
              if (makesContact && ssaDef.protectKind === 'spiky') {
                const dmg = Math.max(1, Math.trunc(atkStatic.maxhp / 8));
                const out = applyFixedDamageWithThresholds(ctx, ssaAb, actorSide, pokeIdx, dmg, true, policy, stats, true);
                for (const r of out) nextMoveBranches.push({ab: r, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
              } else if (makesContact && ssaDef.protectKind === 'kings') {
                applyStatBoost(ctx, ssaState, actorSide, pokeIdx, 'atk', -1, true, false, t.side, t.pokeIdx);
                nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
              } else if (makesContact && ssaDef.protectKind === 'baneful') {
                const out = inflictStatusWithBranching(ctx, ssaAb, actorSide, pokeIdx, 'psn', policy, stats, false, t.side, t.pokeIdx);
                for (const r of out) nextMoveBranches.push({ab: r, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
              } else {
                nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
              }
              continue;
            }
          }

          // Ability & Item immunities
          const {type: effType} = resolveMoveType(ctx, ssaState, actorSide, pokeIdx, move);
          if (move.sound && defAbActive && defAb.soundproof) {
            nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
            continue;
          }
          if (move.bullet && defAbActive && defAb.bulletproof) {
            nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
            continue;
          }
          if (effType === 'Ground' && !isGrounded(defStatic, ssaDef, ssaState) &&
              (ssaDef.magnetRiseTurns > 0 || (isItemEffectActive(ssaState, defStatic, ssaDef) && activeItemSpec(ctx, defStatic, ssaDef).archetype === 'air-balloon'))) {
            nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
            continue;
          }
          if (defAbActive && defAb.immuneType === effType && t.side !== actorSide) {
            if (defAb.immuneHealQuarter) {
              applyHeal(ctx, ssaState, t.side, t.pokeIdx, Math.max(1, Math.trunc(defStatic.maxhp / 4)));
            }
            if (defAb.immuneBoostStat && defAb.immuneBoostStages) {
              applyStatBoost(ctx, ssaState, t.side, t.pokeIdx, defAb.immuneBoostStat, defAb.immuneBoostStages, false);
            }
            if (defAb.flashFire) ssaDef.flashFireActive = true;
            nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
            continue;
          }

          // Type immunity before accuracy roll (note Ground hits grounded Flying via Gravity/Roost/Smack Down/Iron Ball)
          const defTypesForCheck = effType === 'Ground' && isGrounded(defStatic, ssaDef, ssaState)
            ? activeTypes(defStatic, ssaDef).filter(tp => tp !== 'Flying')
            : activeTypes(defStatic, ssaDef);
          if (typeEffectiveness(ctx, effType, defTypesForCheck, ssaAtk.abilityActive && !!atkAb.scrappy, move.specialKind).immune) {
            nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
            continue;
          }

          // OHKO immunity & level-based accuracy
          if (move.specialKind === 'ohko') {
            if (atkStatic.level < defStatic.level ||
                (defAbActive && defAb.sturdy) ||
                (move.id === 'sheercold' && activeTypes(defStatic, ssaDef).includes('Ice'))) {
              nextMoveBranches.push({ab: ssaAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
              continue;
            }
          }

          // Triple Axel: 3 independent accuracy-checked hits at 20, 40, 60 BP!
          if (move.specialKind === 'triple-axel') {
            const accProb = accuracyProbability(ctx, ssaState, actorSide, pokeIdx, t.side, t.pokeIdx, move);
            let curTA: {ab: ActiveBranch; landed: boolean; active: boolean}[] = [{ab: ssaAb, landed: mb.hitAny, active: true}];
            for (const bp of [20, 40, 60]) {
              const nextTA: {ab: ActiveBranch; landed: boolean; active: boolean}[] = [];
              for (const item of curTA) {
                if (!item.active || item.ab.state.sides[actorSide].pokemon[pokeIdx].fainted || item.ab.state.sides[t.side].pokemon[t.pokeIdx].fainted) {
                  nextTA.push({...item, active: false});
                  continue;
                }
                const hitChoices = pickChoices([{item: true, prob: accProb}, {item: false, prob: 1 - accProb}], policy, stats);
                for (const hc of hitChoices) {
                  const st = hitChoices.length === 1 ? item.ab.state : cloneState(item.ab.state);
                  const br: ActiveBranch = {state: st, probability: item.ab.probability * hc.prob, remainingActions: item.ab.remainingActions.map(a => ({...a, action: {...a.action}}))};
                  if (!hc.item) {
                    nextTA.push({ab: br, landed: item.landed, active: false});
                  } else {
                    const res = executeSingleHitOnTarget(
                      ctx, [br], actorSide, pokeIdx, t.side, t.pokeIdx, move,
                      {isSpread: false, isFinalHit: bp === 60, bypassProtect, targetSlot: t.slot, moveIndex, analyticBoost, basePowerOverride: bp},
                      damageCache, policy, stats
                    );
                    for (const rb of res.branches) {
                      nextTA.push({ab: rb, landed: item.landed || res.anyHitLanded, active: true});
                    }
                  }
                }
              }
              curTA = nextTA;
            }
            for (const item of curTA) {
              nextMoveBranches.push({ab: item.ab, hitAny: item.landed, fickleDouble: mb.fickleDouble});
            }
            continue;
          }

          // Accuracy check (OHKO uses special level formula)
          let accProb: number;
          if (move.specialKind === 'ohko') {
            if ((ssaAtk.abilityActive && atkAb.noGuard) || (ssaDef.abilityActive && defAb.noGuard) || lockedOn) {
              accProb = 1;
            } else {
              const baseAcc = move.id === 'sheercold' && !activeTypes(atkStatic, ssaAtk).includes('Ice') ? 20 : 30;
              accProb = Math.min(100, baseAcc + atkStatic.level - defStatic.level) / 100;
            }
          } else {
            accProb = accuracyProbability(ctx, ssaState, actorSide, pokeIdx, t.side, t.pokeIdx, move);
          }
          const accChoices = pickChoices([{item: true, prob: accProb}, {item: false, prob: 1 - accProb}], policy, stats);

          for (const ac of accChoices) {
            const baseSt = accChoices.length === 1 ? ssaState : cloneState(ssaState);
            const baseAb: ActiveBranch = {
              state: baseSt,
              probability: ssaAb.probability * ac.prob,
              remainingActions: ssaAb.remainingActions.map(a => ({...a, action: {...a.action}})),
            };
            if (!ac.item) {
              nextMoveBranches.push({ab: baseAb, hitAny: mb.hitAny, fickleDouble: mb.fickleDouble});
              continue;
            }

            // Brick Break / Psychic Fangs / Raging Bull shatter screens before dealing damage!
            if (move.specialKind === 'screen-break' || move.specialKind === 'raging-bull') {
              baseSt.sides[t.side].reflectTurns = 0;
              baseSt.sides[t.side].lightScreenTurns = 0;
              baseSt.sides[t.side].auroraVeilTurns = 0;
            }

            // Beat Up: one hit per healthy party member (BP = floor(baseAtk / 10) + 5)
            if (move.specialKind === 'beat-up') {
              const allies = baseSt.sides[actorSide].pokemon
                .map((m, idx) => ({m, idx}))
                .filter(({m, idx}) => idx === pokeIdx || (!m.fainted && m.status === ''));
              let hitBatch: ActiveBranch[] = [baseAb];
              let landed = mb.hitAny;
              for (let hi = 0; hi < allies.length; hi++) {
                const allySp = ctx.sides[actorSide].team[allies[hi].idx];
                const bp = Math.floor(allySp.baseAtk / 10) + 5;
                const res = executeSingleHitOnTarget(
                  ctx, hitBatch, actorSide, pokeIdx, t.side, t.pokeIdx, move,
                  {
                    isSpread: false,
                    isFinalHit: hi === allies.length - 1,
                    bypassProtect,
                    targetSlot: t.slot,
                    moveIndex,
                    analyticBoost,
                    basePowerOverride: bp,
                  },
                  damageCache, policy, stats
                );
                hitBatch = res.branches;
                if (res.anyHitLanded) landed = true;
              }
              for (const hb of hitBatch) {
                nextMoveBranches.push({ab: hb, hitAny: landed, fickleDouble: mb.fickleDouble});
              }
              continue;
            }

            // Multi-hit count fork (Skill Link always 5 hits; Parental Bond converts single-target non-multihit to 2 hits!)
            const isParentalBond = ssaAtk.abilityActive && !!atkAb.parentalBond && !move.multihit && !isSpread &&
              move.specialKind !== 'self-ko' && move.specialKind !== 'final-gambit' && move.specialKind !== 'ohko';

            let hitPlans: {hits: number; prob: number}[];
            if (isParentalBond) {
              hitPlans = [{hits: 2, prob: 1}];
            } else if (Array.isArray(move.multihit) && move.multihit[0] === 2 && move.multihit[1] === 5) {
              hitPlans = ssaAtk.abilityActive && atkAb.skillLink ? [{hits: 5, prob: 1}] : [...MULTIHIT_2_5];
            } else if (typeof move.multihit === 'number') {
              hitPlans = [{hits: move.multihit, prob: 1}];
            } else {
              hitPlans = [{hits: 1, prob: 1}];
            }

            const pickedPlans = pickChoices(hitPlans.map(hp => ({item: hp.hits, prob: hp.prob})), policy, stats);
            for (const plan of pickedPlans) {
              let hitBatch: ActiveBranch[] = [{
                state: pickedPlans.length === 1 ? baseAb.state : cloneState(baseAb.state),
                probability: baseAb.probability * plan.prob,
                remainingActions: baseAb.remainingActions.map(a => ({...a, action: {...a.action}})),
              }];
              let landed = mb.hitAny;
              const totalHits = plan.item;
              for (let h = 1; h <= totalHits; h++) {
                if (hitBatch.length === 0) break;
                const res = executeSingleHitOnTarget(
                  ctx,
                  hitBatch,
                  actorSide,
                  pokeIdx,
                  t.side,
                  t.pokeIdx,
                  move,
                  {
                    isSpread,
                    isFinalHit: h === totalHits,
                    bypassProtect,
                    targetSlot: t.slot,
                    moveIndex,
                    analyticBoost,
                    fickleDouble: mb.fickleDouble,
                    basePowerOverride: flingPower,
                    categoryOverride,
                    contactOverride,
                    flingItemId,
                    parentalBondSecondHit: isParentalBond && h === 2,
                    runSecondariesOnEveryHit: isParentalBond,
                  },
                  damageCache,
                  policy,
                  stats,
                  defer
                );
                hitBatch = res.branches;
                if (res.anyHitLanded) landed = true;
              }

              // Damaging forced-switch moves (Dragon Tail / Circle Throw)
              if (move.forceSwitch && landed) {
                const forced: ActiveBranch[] = [];
                for (const hb of hitBatch) {
                  const dp = hb.state.sides[t.side].pokemon[t.pokeIdx];
                  const dAbFs = activeAbilitySpec(defStatic, dp);
                  const blockedFs = dp.ingrain || (dp.abilityActive && !moldBreaker && (dAbFs.suctionCups || dAbFs.guardDog));
                  const bench = blockedFs ? [] : legalBenchSwitches(hb.state.sides[t.side]);
                  if (!dp.fainted && dp.substituteHp === 0 && bench.length > 0) {
                    const pSw = 1 / bench.length;
                    const swChoices = pickChoices(bench.map(bi => ({item: bi, prob: pSw})), policy, stats);
                    for (const swc of swChoices) {
                      const swSt = swChoices.length === 1 ? hb.state : cloneState(hb.state);
                      const swBr: ActiveBranch = {
                        state: swSt,
                        probability: hb.probability * swc.prob,
                        remainingActions: hb.remainingActions.filter(ra => !(ra.side === t.side && ra.action.slot === t.slot)),
                      };
                      forced.push(...performSwitchIn(ctx, [swBr], t.side, t.slot, swc.item, policy, stats));
                    }
                  } else {
                    forced.push(hb);
                  }
                }
                hitBatch = forced;
              }

              for (const hb of hitBatch) {
                nextMoveBranches.push({ab: hb, hitAny: landed, fickleDouble: mb.fickleDouble});
              }
            }
          }
        }
      }

      moveBranches = nextMoveBranches;
    }

    // Post-move effects (Crash Recoil, Steel Beam, Burn Up, Double Shock, Glaive Rush, Rapid Spin, self boosts, Life Orb, Struggle, self-KO, recharge, pivot switch)
    const sheerForce = p.abilityActive && !!atkAb.sheerForce && (move.secondaries.length > 0 || move.specialKind === 'tri-attack');
    for (const mb of moveBranches) {
      let postBranches: ActiveBranch[] = [mb.ab];

      if (!mb.hitAny) {
        for (const b of postBranches) {
          b.state.sides[actorSide].pokemon[pokeIdx].lastMoveFailed = true;
        }
        // Crash recoil moves (High Jump Kick, Axe Kick, Supercell Slam): lose trunc(50% maxHP) on miss/immune/protect!
        if (move.specialKind === 'crash-recoil') {
          const crashDmg = Math.max(1, Math.trunc(atkStatic.maxhp / 2));
          const nextCr: ActiveBranch[] = [];
          for (const b of postBranches) {
            const out = applyFixedDamageWithThresholds(ctx, b, actorSide, pokeIdx, crashDmg, true, policy, stats, true);
            for (const r of out) {
              checkEnded(r.state, oppSide);
              nextCr.push(r);
            }
          }
          postBranches = nextCr;
        }
      }

      if (move.specialKind === 'self-ko' || move.specialKind === 'final-gambit') {
        for (const b of postBranches) {
          const ap = b.state.sides[actorSide].pokemon[pokeIdx];
          ap.hp = 0;
          ap.hpDist = null;
          ap.fainted = true;
          checkEnded(b.state, oppSide);
        }
      }

      // Steel Beam always costs 50% maxHP (unless Magic Guard)
      if (move.specialKind === 'steel-beam') {
        const sbDmg = Math.max(1, Math.round(atkStatic.maxhp / 2));
        const nextSb: ActiveBranch[] = [];
        for (const b of postBranches) {
          const out = applyFixedDamageWithThresholds(ctx, b, actorSide, pokeIdx, sbDmg, true, policy, stats, true);
          for (const r of out) {
            checkEnded(r.state, actorSide);
            nextSb.push(r);
          }
        }
        postBranches = nextSb;
      }

      if (mb.hitAny) {
        if (move.specialKind === 'glaive-rush') {
          for (const b of postBranches) {
            if (!b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
              b.state.sides[actorSide].pokemon[pokeIdx].glaiveRush = true;
            }
          }
        }
        if (move.specialKind === 'burn-up' || move.specialKind === 'double-shock') {
          const removeType = move.specialKind === 'burn-up' ? 'Fire' : 'Electric';
          for (const b of postBranches) {
            const ap = b.state.sides[actorSide].pokemon[pokeIdx];
            if (!ap.fainted) {
              const rem = activeTypes(atkStatic, ap).filter(tp => tp !== removeType);
              ap.types = rem.length > 0 ? rem : ['???'];
            }
          }
        }
        if (move.specialKind === 'hazard-clear-self') {
          for (const b of postBranches) {
            if (!b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
              b.state.sides[actorSide].stealthRock = false;
              b.state.sides[actorSide].spikes = 0;
              b.state.sides[actorSide].toxicSpikes = 0;
              b.state.sides[actorSide].stickyWeb = false;
              b.state.sides[actorSide].pokemon[pokeIdx].leechSeedSlot = -1;
              b.state.sides[actorSide].pokemon[pokeIdx].partialTrapTurns = 0;
            }
          }
        }
        if (move.selfBoosts) {
          for (const b of postBranches) {
            if (!b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
              for (const [stat, delta] of Object.entries(move.selfBoosts) as [BoostStat, number][]) {
                applyStatBoost(ctx, b.state, actorSide, pokeIdx, stat, delta, false);
              }
            }
          }
        }
        if (move.recharge) {
          for (const b of postBranches) {
            const ap = b.state.sides[actorSide].pokemon[pokeIdx];
            if (!ap.fainted) ap.mustRecharge = true;
          }
        }
        if (move.selfLockedMove && !overrideMove && moveIndex >= 0) {
          const nextLock: ActiveBranch[] = [];
          for (const b of postBranches) {
            const ap = b.state.sides[actorSide].pokemon[pokeIdx];
            if (ap.fainted) {
              nextLock.push(b);
              continue;
            }
            if (ap.lockedMoveIdx < 0) {
              // onStart: trueDuration = random(2, 4) -> 50% 2 turns, 50% 3 turns; duration = 2
              const choices = pickChoices(
                [{item: 2, prob: 0.5}, {item: 3, prob: 0.5}],
                policy,
                stats
              );
              for (const c of choices) {
                const st = choices.length === 1 ? b.state : cloneState(b.state);
                const lp = st.sides[actorSide].pokemon[pokeIdx];
                lp.lockedMoveIdx = moveIndex;
                lp.lockedMoveDuration = 2;
                lp.lockedMoveTrueDuration = c.item;
                nextLock.push({
                  state: st,
                  probability: b.probability * c.prob,
                  remainingActions: b.remainingActions.map(a => ({...a, action: {...a.action}})),
                });
              }
            } else {
              // onRestart: extend duration to 2 while trueDuration >= 2
              if (ap.lockedMoveTrueDuration >= 2) ap.lockedMoveDuration = 2;
              nextLock.push(b);
            }
          }
          postBranches = nextLock;
        }
        if (move.id === 'struggle') {
          const struggleDmg = Math.max(1, Math.round(atkStatic.maxhp / 4));
          const nextRec: ActiveBranch[] = [];
          for (const b of postBranches) {
            if (!b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
              const recOut = applyFixedDamageWithThresholds(ctx, b, actorSide, pokeIdx, struggleDmg, true, policy, stats);
              for (const r of recOut) {
                checkEnded(r.state, actorSide);
                nextRec.push(r);
              }
            } else {
              nextRec.push(b);
            }
          }
          postBranches = nextRec;
        }
        if (move.id !== 'struggle' && !move.selfSwitch && !sheerForce) {
          const loDmg = Math.max(1, Math.trunc(atkStatic.maxhp / 10));
          const nextLo: ActiveBranch[] = [];
          for (const b of postBranches) {
            const ap = b.state.sides[actorSide].pokemon[pokeIdx];
            if (!ap.fainted && isItemEffectActive(b.state, atkStatic, ap) && activeItemSpec(ctx, atkStatic, ap).archetype === 'life-orb') {
              const loOut = applyFixedDamageWithThresholds(ctx, b, actorSide, pokeIdx, loDmg, true, policy, stats, true);
              for (const r of loOut) {
                checkEnded(r.state, actorSide);
                nextLo.push(r);
              }
            } else {
              nextLo.push(b);
            }
          }
          postBranches = nextLo;
        }
      }

      // lockedmove onAfterMove: when duration === 1 (final turn or disrupted), remove volatile;
      // onEnd confuses the user if trueDuration <= 1.
      {
        const nextAfterLock: ActiveBranch[] = [];
        for (const b of postBranches) {
          const ap = b.state.sides[actorSide].pokemon[pokeIdx];
          if (!ap.fainted && ap.lockedMoveIdx >= 0 && ap.lockedMoveDuration === 1) {
            const td = ap.lockedMoveTrueDuration;
            ap.lockedMoveIdx = -1;
            ap.lockedMoveDuration = 0;
            ap.lockedMoveTrueDuration = 0;
            if (td <= 1) {
              nextAfterLock.push(...inflictConfusionWithBranching(ctx, b, actorSide, pokeIdx, policy, stats, false));
              continue;
            }
          }
          nextAfterLock.push(b);
        }
        postBranches = nextAfterLock;
      }

      if (move.specialKind === 'round') {
        for (const b of postBranches) {
          b.state.sides[actorSide].roundUsedThisTurn = true;
        }
      }
      if (move.specialKind === 'spit-up') {
        for (const b of postBranches) {
          const ap = b.state.sides[actorSide].pokemon[pokeIdx];
          if (!ap.fainted && ap.stockpileLayers > 0) {
            if (ap.stockpileDef > 0) applyStatBoost(ctx, b.state, actorSide, pokeIdx, 'def', -ap.stockpileDef, false);
            if (ap.stockpileSpd > 0) applyStatBoost(ctx, b.state, actorSide, pokeIdx, 'spd', -ap.stockpileSpd, false);
            ap.stockpileLayers = 0;
            ap.stockpileDef = 0;
            ap.stockpileSpd = 0;
          }
        }
      }

      for (const b of postBranches) {
        if (b.state.phase.kind === 'ended' || checkEnded(b.state, actorSide)) {
          ended.push({state: b.state, probability: b.probability});
          continue;
        }
        // Emergency Exit / Wimp Out post-move switch pause
        const eePending: PendingSwitchSlot[] = [];
        for (const s of [0, 1] as const) {
          for (let sl = 0; sl < ctx.activeCount; sl++) {
            const eIdx = b.state.sides[s].active[sl];
            if (eIdx < 0) continue;
            const ep = b.state.sides[s].pokemon[eIdx];
            if (ep.emergencyExitTriggered) {
              ep.emergencyExitTriggered = false;
              if (!ep.fainted && legalBenchSwitches(b.state.sides[s]).length > 0) {
                eePending.push({side: s, slot: sl});
              }
            }
          }
        }
        if (eePending.length > 0) {
          b.state.phase = {
            kind: 'switch',
            pendingSlots: eePending,
            remainingActions: b.remainingActions,
            needsEndOfTurn: true,
          };
          paused.push({state: b.state, probability: b.probability});
          continue;
        }
        if (mb.hitAny && move.selfSwitch && !b.state.sides[actorSide].pokemon[pokeIdx].fainted) {
          const bench = legalBenchSwitches(b.state.sides[actorSide]);
          if (bench.length > 0) {
            b.state.phase = {
              kind: 'switch',
              pendingSlots: [{side: actorSide, slot: action.slot}],
              remainingActions: b.remainingActions,
              needsEndOfTurn: true,
            };
            paused.push({state: b.state, probability: b.probability});
            continue;
          }
        }
        outActive.push(b);
      }
    }
  }

  return {
    active: mergeActiveBranches(ctx, outActive, stats),
    paused,
    ended,
  };
}

function runActionLoop(
  ctx: StaticBattleContext,
  initialBatch: ActiveBranch[],
  policy: BranchPolicy,
  stats: StepStats
): {completed: WeightedState[]; paused: WeightedState[]; ended: WeightedState[]; remainingMass: number; complete: boolean} {
  let active = initialBatch;
  const completed: WeightedState[] = [];
  const paused: WeightedState[] = [];
  const ended: WeightedState[] = [];
  let remainingMass = 0;
  let complete = true;
  const damageCache = new DamageBatchCache();
  const defer: DeferTracker | undefined =
    policy.mode === 'certified' && (policy.deferMinProb ?? 0) > 0 && (policy.maxDeferredMass ?? 0) > 0
      ? {
          minProb: policy.deferMinProb!,
          maxMass: policy.maxDeferredMass!,
          minBranches: policy.deferMinBranches ?? 12,
          deferredMass: 0,
        }
      : undefined;

  while (active.length > 0) {
    if (policy.mode === 'certified') {
      if (defer) {
        active = deferLowProbBranches(active, defer);
        if (active.length === 0) break;
      }
      if (
        (policy.deadline !== undefined && performance.now() >= policy.deadline) ||
        (policy.maxBranches !== undefined && active.length > policy.maxBranches)
      ) {
        for (const ab of active) remainingMass += ab.probability;
        complete = false;
        active = [];
        break;
      }
    } else if (policy.mode === 'pruned') {
      const minP = policy.minBranchProb ?? 0;
      if (minP > 0) {
        const kept: ActiveBranch[] = [];
        for (const ab of active) {
          if (ab.probability < minP) remainingMass += ab.probability;
          else kept.push(ab);
        }
        active = kept;
      }
      if (policy.maxBranches !== undefined && active.length > policy.maxBranches) {
        active.sort((a, b) => b.probability - a.probability);
        for (let i = policy.maxBranches; i < active.length; i++) {
          remainingMass += active[i].probability;
        }
        active = active.slice(0, policy.maxBranches);
      }
      if (active.length === 0) break;
    }

    const nextActive: ActiveBranch[] = [];
    for (const ab of active) {
      if (ab.state.phase.kind === 'ended' || checkEnded(ab.state)) {
        ended.push({state: ab.state, probability: ab.probability});
        continue;
      }
      if (ab.remainingActions.length === 0) {
        completed.push({state: ab.state, probability: ab.probability});
        continue;
      }

      const scored = ab.remainingActions.map((ra, idx) => {
        const pokeIdx = ab.state.sides[ra.side].active[ra.action.slot];
        const spe = pokeIdx >= 0 && !ab.state.sides[ra.side].pokemon[pokeIdx].fainted
          ? effectiveSpeed(ctx, ab.state, ra.side, pokeIdx)
          : -Infinity;
        // Recompute Grassy Glide dynamic priority if Terrain changed mid-turn
        let prio = ra.priority;
        if (pokeIdx >= 0 && ra.priority > -50 && ra.priority < 50) {
          const p = ab.state.sides[ra.side].pokemon[pokeIdx];
          const sp = ctx.sides[ra.side].team[pokeIdx];
          const mv = getMoveForAction(ctx, ra.side, pokeIdx, p.encoreMoveIdx >= 0 ? p.encoreMoveIdx : ra.action.moveIndex, ab.state);
          if (mv.specialKind === 'grassy-glide') {
            prio = mv.priority + (ab.state.field.terrain === 'grassy' && isGrounded(sp, p, ab.state) ? 1 : 0);
          }
        }
        return {ra, idx, priority: prio, subOrder: ra.subOrder, speed: spe};
      });

      let bestPriority = -Infinity;
      let bestSub = -Infinity;
      let bestSpeed = -Infinity;
      for (const s of scored) {
        if (
          s.priority > bestPriority ||
          (s.priority === bestPriority && s.subOrder > bestSub) ||
          (s.priority === bestPriority && s.subOrder === bestSub && s.speed > bestSpeed)
        ) {
          bestPriority = s.priority;
          bestSub = s.subOrder;
          bestSpeed = s.speed;
        }
      }
      const tied = scored.filter(s => s.priority === bestPriority && s.subOrder === bestSub && s.speed === bestSpeed);
      const tieProb = 1 / tied.length;
      const pickedTies = pickChoices(tied.map(t => ({item: t, prob: tieProb})), policy, stats);

      for (const pt of pickedTies) {
        const st = pickedTies.length === 1 ? ab.state : cloneState(ab.state);
        const rest = ab.remainingActions.filter((_, idx) => idx !== pt.item.idx);
        const branch: ActiveBranch = {
          state: st,
          probability: ab.probability * pt.prob,
          remainingActions: rest,
        };
        const res = executeMoveAction(
          ctx,
          branch,
          pt.item.ra.side,
          pt.item.ra.action,
          damageCache,
          policy,
          stats,
          undefined,
          false,
          defer
        );
        nextActive.push(...res.active);
        paused.push(...res.paused);
        ended.push(...res.ended);
      }
    }

    active = mergeActiveBranches(ctx, nextActive, stats);
  }

  stats.damageBatchHits += damageCache.hits;
  stats.damageBatchMisses += damageCache.misses;
  const totalRemaining = remainingMass + (defer ? defer.deferredMass : 0);
  return {completed, paused, ended, remainingMass: totalRemaining, complete: complete && totalRemaining <= EPS};
}

function runEndOfTurn(
  ctx: StaticBattleContext,
  states: WeightedState[],
  policy: BranchPolicy,
  stats: StepStats
): WeightedState[] {
  const out: WeightedState[] = [];
  const damageCache = new DamageBatchCache();

  for (const ws of states) {
    if (ws.state.phase.kind === 'ended' || checkEnded(ws.state)) {
      out.push(ws);
      continue;
    }

    let branches: ActiveBranch[] = [{
      state: ws.state,
      probability: ws.probability,
      remainingActions: [],
    }];

    const activeSlots: {side: 0 | 1; slot: number; pokeIdx: number}[] = [];
    for (const s of [0, 1] as const) {
      for (let slot = 0; slot < ctx.activeCount; slot++) {
        const idx = ws.state.sides[s].active[slot];
        if (idx >= 0 && !ws.state.sides[s].pokemon[idx].fainted) {
          activeSlots.push({side: s, slot, pokeIdx: idx});
        }
      }
    }
    activeSlots.sort((a, b) =>
      effectiveSpeed(ctx, ws.state, b.side, b.pokeIdx) - effectiveSpeed(ctx, ws.state, a.side, a.pokeIdx)
    );

    // 1. Weather residual (Sandstorm 1/16 chip, Dry Skin Rain +1/8 & Sun -1/8, Rain Dish / Ice Body 1/16 heal, Solar Power 1/8 chip)
    if (ws.state.field.weather !== '') {
      for (const entry of activeSlots) {
        const sp = ctx.sides[entry.side].team[entry.pokeIdx];
        const next: ActiveBranch[] = [];
        for (const b of branches) {
          const p = b.state.sides[entry.side].pokemon[entry.pokeIdx];
          if (p.fainted) {
            next.push(b);
            continue;
          }
          const ab = activeAbilitySpec(sp, p);
          const w = effectiveFieldWeather(ctx, b.state);
          if (w === 'sand') {
            const types = activeTypes(sp, p);
            const immune = types.includes('Rock') || types.includes('Ground') || types.includes('Steel') ||
              (p.abilityActive && (ab.overcoat || ab.magicGuard || ab.sandForce || ab.speedDoubleWeather === 'sand' || ab.evasionWeather === 'sand')) ||
              (isItemEffectActive(b.state, sp, p) && activeItemSpec(ctx, sp, p).archetype === 'safety-goggles');
            if (!immune) {
              const dmg = Math.max(1, Math.trunc(sp.maxhp / 16));
              next.push(...applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true));
              continue;
            }
          } else if (w === 'rain' && p.abilityActive) {
            if (ab.drySkin) applyHeal(ctx, b.state, entry.side, entry.pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 8)));
            else if (ab.rainDish) applyHeal(ctx, b.state, entry.side, entry.pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 16)));
          } else if (w === 'snow' && p.abilityActive && ab.iceBody) {
            applyHeal(ctx, b.state, entry.side, entry.pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 16)));
          } else if (w === 'sun' && p.abilityActive && (ab.solarPower || ab.drySkin)) {
            const dmg = Math.max(1, Math.trunc(sp.maxhp / 8));
            next.push(...applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true));
            continue;
          }
          next.push(b);
        }
        branches = next;
      }
    }

    // 2. Wish & Future Sight slot conditions
    for (const s of [0, 1] as const) {
      for (let sl = 0; sl < ctx.activeCount; sl++) {
        // Wish heal
        for (const b of branches) {
          if (b.state.sides[s].wishTurns[sl] > 0) {
            b.state.sides[s].wishTurns[sl]--;
            if (b.state.sides[s].wishTurns[sl] === 0) {
              const idx = b.state.sides[s].active[sl];
              if (idx >= 0 && !b.state.sides[s].pokemon[idx].fainted) {
                applyHeal(ctx, b.state, s, idx, b.state.sides[s].wishHp[sl]);
              }
              b.state.sides[s].wishHp[sl] = 0;
            }
          }
        }
        // Future Sight strike
        const nextFm: ActiveBranch[] = [];
        for (const b of branches) {
          const fm = b.state.sides[s].futureMoves[sl];
          if (fm) {
            fm.turns--;
            if (fm.turns <= 0) {
              b.state.sides[s].futureMoves[sl] = null;
              const targetIdx = b.state.sides[s].active[sl];
              if (targetIdx >= 0 && !b.state.sides[s].pokemon[targetIdx].fainted) {
                const srcSp = ctx.sides[fm.sourceSide].team[fm.sourceIdx];
                const fmMove = srcSp.moves.find(m => m.id === fm.moveId);
                if (fmMove) {
                  const res = executeSingleHitOnTarget(
                    ctx, [b], fm.sourceSide, fm.sourceIdx, s, targetIdx, fmMove,
                    {isSpread: false, isFinalHit: true, bypassProtect: false, targetSlot: sl},
                    damageCache, policy, stats
                  );
                  nextFm.push(...res.branches);
                  continue;
                }
              }
            }
          }
          nextFm.push(b);
        }
        branches = nextFm;
      }
    }

    // 3. Grassy Terrain (1/16), Leftovers (1/16), Aqua Ring (1/16), Ingrain (1/16)
    for (const entry of activeSlots) {
      const sp = ctx.sides[entry.side].team[entry.pokeIdx];
      const healAmt = Math.max(1, Math.trunc(sp.maxhp / 16));
      for (const b of branches) {
        const p = b.state.sides[entry.side].pokemon[entry.pokeIdx];
        if (p.fainted) continue;
        if (b.state.field.terrain === 'grassy' && isGrounded(sp, p, b.state)) {
          applyHeal(ctx, b.state, entry.side, entry.pokeIdx, healAmt);
        }
        if (p.aquaRing) {
          applyHeal(ctx, b.state, entry.side, entry.pokeIdx, healAmt);
        }
        if (p.ingrain) {
          applyHeal(ctx, b.state, entry.side, entry.pokeIdx, healAmt);
        }
        if (isItemEffectActive(b.state, sp, p) && activeItemSpec(ctx, sp, p).archetype === 'leftovers') {
          applyHeal(ctx, b.state, entry.side, entry.pokeIdx, healAmt);
        }
      }
    }

    // 4. Leech Seed (1/8 drain; Liquid Ooze damages recipient instead!)
    for (const entry of activeSlots) {
      const sp = ctx.sides[entry.side].team[entry.pokeIdx];
      const oppSide: 0 | 1 = entry.side === 0 ? 1 : 0;
      const next: ActiveBranch[] = [];
      for (const b of branches) {
        const p = b.state.sides[entry.side].pokemon[entry.pokeIdx];
        if (p.fainted || p.leechSeedSlot < 0) {
          next.push(b);
          continue;
        }
        const recIdx = b.state.sides[oppSide].active[p.leechSeedSlot] ?? b.state.sides[oppSide].active[0];
        if (recIdx < 0 || b.state.sides[oppSide].pokemon[recIdx].fainted) {
          next.push(b);
          continue;
        }
        const ab = activeAbilitySpec(sp, p);
        const dmg = Math.max(1, Math.trunc(sp.maxhp / 8));
        if (p.abilityActive && ab.magicGuard) {
          next.push(b);
          continue;
        }
        const afterDrain = applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true);
        for (const r of afterDrain) {
          if (p.abilityActive && ab.liquidOoze) {
            next.push(...applyFixedDamageWithThresholds(ctx, r, oppSide, recIdx, dmg, true, policy, stats, true));
          } else {
            applyHeal(ctx, r.state, oppSide, recIdx, dmg);
            next.push(r);
          }
        }
      }
      branches = next;
    }

    // 5. Burn / Poison / Toxic residual damage (or Poison Heal)
    for (const entry of activeSlots) {
      const sp = ctx.sides[entry.side].team[entry.pokeIdx];
      const next: ActiveBranch[] = [];
      for (const b of branches) {
        const p = b.state.sides[entry.side].pokemon[entry.pokeIdx];
        if (p.fainted) {
          next.push(b);
          continue;
        }
        const ab = activeAbilitySpec(sp, p);
        if (p.status === 'brn') {
          const denom = p.abilityActive && ab.heatproof ? 32 : 16;
          const dmg = Math.max(1, Math.trunc(sp.maxhp / denom));
          next.push(...applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true));
        } else if (p.status === 'psn' || p.status === 'tox') {
          if (p.abilityActive && ab.poisonHeal) {
            applyHeal(ctx, b.state, entry.side, entry.pokeIdx, Math.max(1, Math.trunc(sp.maxhp / 8)));
            next.push(b);
          } else if (p.status === 'psn') {
            const dmg = Math.max(1, Math.trunc(sp.maxhp / 8));
            next.push(...applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true));
          } else {
            p.statusTurns = Math.min(15, (p.statusTurns || 0) + 1);
            const dmg = Math.max(1, Math.trunc(sp.maxhp * p.statusTurns / 16));
            next.push(...applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true));
          }
        } else {
          next.push(b);
        }
      }
      branches = next;
    }

    // 6. Ghost Curse (1/4), Partial Trap (1/8), Octolock (-1 Def/-1 SpD), Syrup Bomb (-1 Spe), Yawn (sleep on 0), Perish Song (faint on 0)
    for (const entry of activeSlots) {
      const sp = ctx.sides[entry.side].team[entry.pokeIdx];
      const next: ActiveBranch[] = [];
      for (const b of branches) {
        let curList: ActiveBranch[] = [b];
        const p0 = b.state.sides[entry.side].pokemon[entry.pokeIdx];
        if (!p0.fainted && p0.cursed) {
          const dmg = Math.max(1, Math.trunc(sp.maxhp / 4));
          curList = applyFixedDamageWithThresholds(ctx, b, entry.side, entry.pokeIdx, dmg, true, policy, stats, true);
        }
        const afterPt: ActiveBranch[] = [];
        for (const br of curList) {
          const p = br.state.sides[entry.side].pokemon[entry.pokeIdx];
          if (!p.fainted && p.partialTrapTurns > 0) {
            const dmg = Math.max(1, Math.trunc(sp.maxhp / 8));
            p.partialTrapTurns--;
            afterPt.push(...applyFixedDamageWithThresholds(ctx, br, entry.side, entry.pokeIdx, dmg, true, policy, stats, true));
          } else {
            afterPt.push(br);
          }
        }
        for (const br of afterPt) {
          const p = br.state.sides[entry.side].pokemon[entry.pokeIdx];
          if (p.fainted) {
            next.push(br);
            continue;
          }
          if (p.octolockSide >= 0) {
            const srcSide = p.octolockSide as 0 | 1;
            const srcIdx = br.state.sides[srcSide].active[p.octolockSlot];
            if (srcIdx >= 0 && !br.state.sides[srcSide].pokemon[srcIdx].fainted) {
              applyStatBoost(ctx, br.state, entry.side, entry.pokeIdx, 'def', -1, true, false, srcSide, srcIdx);
              applyStatBoost(ctx, br.state, entry.side, entry.pokeIdx, 'spd', -1, true, false, srcSide, srcIdx);
            } else {
              p.octolockSide = -1;
              p.octolockSlot = -1;
            }
          }
          if (p.syrupBombTurns > 0) {
            applyStatBoost(ctx, br.state, entry.side, entry.pokeIdx, 'spe', -1, true);
            p.syrupBombTurns--;
          }
          if (p.perishTurns > 0) {
            p.perishTurns--;
            if (p.perishTurns === 0) {
              p.hp = 0;
              p.hpDist = null;
              p.fainted = true;
              next.push(br);
              continue;
            }
          }
          if (p.yawnTurns > 0) {
            p.yawnTurns--;
            if (p.yawnTurns === 0) {
              next.push(...inflictStatusWithBranching(ctx, br, entry.side, entry.pokeIdx, 'slp', policy, stats));
              continue;
            }
          }
          next.push(br);
        }
      }
      branches = next;
    }

    // 7. End-of-turn ability triggers (Hydration, Shed Skin, Healer, Harvest, Cud Chew, Moody, Hunger Switch, Shields Down)
    const MOODY_STATS: readonly BoostStat[] = ['atk', 'def', 'spa', 'spd', 'spe'];
    for (const entry of activeSlots) {
      const sp = ctx.sides[entry.side].team[entry.pokeIdx];
      const next: ActiveBranch[] = [];
      for (const b of branches) {
        const p = b.state.sides[entry.side].pokemon[entry.pokeIdx];
        if (p.fainted) {
          next.push(b);
          continue;
        }
        const ab = activeAbilitySpec(sp, p);
        const w = effectiveFieldWeather(ctx, b.state);
        if (p.abilityActive && !p.gastroAcid && ab.hydration && w === 'rain' && p.status !== '') {
          p.status = '';
          p.statusTurns = 0;
        }
        let curList: ActiveBranch[] = [b];
        if (p.abilityActive && !p.gastroAcid && ab.shedSkin && p.status !== '') {
          const choices = pickChoices([{item: true, prob: 0.33}, {item: false, prob: 0.67}], policy, stats);
          curList = choices.map(c => {
            const st = choices.length === 1 ? b.state : cloneState(b.state);
            if (c.item) {
              st.sides[entry.side].pokemon[entry.pokeIdx].status = '';
              st.sides[entry.side].pokemon[entry.pokeIdx].statusTurns = 0;
            }
            return {state: st, probability: b.probability * c.prob, remainingActions: []};
          });
        }
        // Healer (doubles ally cure at ctx.ruleset.healerChance)
        if (p.abilityActive && !p.gastroAcid && ab.healer && ctx.activeCount === 2) {
          const allySlot = entry.slot === 0 ? 1 : 0;
          const afterH: ActiveBranch[] = [];
          for (const br of curList) {
            const aIdx = br.state.sides[entry.side].active[allySlot];
            if (aIdx >= 0 && !br.state.sides[entry.side].pokemon[aIdx].fainted && br.state.sides[entry.side].pokemon[aIdx].status !== '') {
              const pCure = ctx.ruleset.healerChance;
              const choices = pickChoices([{item: true, prob: pCure}, {item: false, prob: 1 - pCure}], policy, stats);
              for (const c of choices) {
                const st = choices.length === 1 ? br.state : cloneState(br.state);
                if (c.item) {
                  st.sides[entry.side].pokemon[aIdx].status = '';
                  st.sides[entry.side].pokemon[aIdx].statusTurns = 0;
                }
                afterH.push({state: st, probability: br.probability * c.prob, remainingActions: []});
              }
            } else {
              afterH.push(br);
            }
          }
          curList = afterH;
        }
        // Harvest (50% / 100% in Sun to restore consumed Berry)
        if (p.abilityActive && !p.gastroAcid && ab.harvest) {
          const afterHarv: ActiveBranch[] = [];
          for (const br of curList) {
            const pk = br.state.sides[entry.side].pokemon[entry.pokeIdx];
            const lastBerryId = pk.lastItemId || (!pk.itemActive && sp.itemSpec.isBerry ? sp.itemId : '');
            const lastSpec = lastBerryId ? getItemSpec(ctx, lastBerryId) : null;
            if (!pk.itemActive && lastSpec?.isBerry) {
              const pRest = w === 'sun' ? 1 : 0.5;
              const choices = pickChoices([{item: true, prob: pRest}, {item: false, prob: 1 - pRest}], policy, stats);
              for (const c of choices) {
                const st = choices.length === 1 ? br.state : cloneState(br.state);
                if (c.item) {
                  setPokemonItem(st, entry.side, entry.pokeIdx, lastBerryId);
                  maybeTriggerStatusBerry(ctx, st, entry.side, entry.pokeIdx);
                  afterHarv.push(...maybeTriggerSitrus(ctx, {state: st, probability: br.probability * c.prob, remainingActions: []}, entry.side, entry.pokeIdx, stats));
                } else {
                  afterHarv.push({state: st, probability: br.probability * c.prob, remainingActions: []});
                }
              }
            } else {
              afterHarv.push(br);
            }
          }
          curList = afterHarv;
        }
        // Cud Chew (re-eat last consumed Berry at end of next turn)
        for (const br of curList) {
          const pk = br.state.sides[entry.side].pokemon[entry.pokeIdx];
          if (!pk.fainted && pk.cudchewBerry) {
            pk.cudchewTurns--;
            if (pk.cudchewTurns <= 0) {
              const berry = pk.cudchewBerry;
              pk.cudchewBerry = '';
              pk.cudchewTurns = 0;
              eatBerryEffect(ctx, br.state, entry.side, entry.pokeIdx, berry, true, false);
            }
          }
        }
        // Moody (+2 random non-maxed stat, -1 random different non-mined stat among atk/def/spa/spd/spe)
        if (p.abilityActive && !p.gastroAcid && ab.moody) {
          const afterMoody: ActiveBranch[] = [];
          for (const br of curList) {
            const pk = br.state.sides[entry.side].pokemon[entry.pokeIdx];
            if (pk.fainted) {
              afterMoody.push(br);
              continue;
            }
            const upCandidates = MOODY_STATS.filter((_, i) => pk.boosts[i] < 6);
            const pairs: {up: BoostStat | null; down: BoostStat | null; prob: number}[] = [];
            if (upCandidates.length > 0) {
              const pUp = 1 / upCandidates.length;
              for (const up of upCandidates) {
                const downCandidates = MOODY_STATS.filter((stName, i) => stName !== up && pk.boosts[i] > -6);
                if (downCandidates.length > 0) {
                  const pDown = 1 / downCandidates.length;
                  for (const down of downCandidates) {
                    pairs.push({up, down, prob: pUp * pDown});
                  }
                } else {
                  pairs.push({up, down: null, prob: pUp});
                }
              }
            } else {
              const downCandidates = MOODY_STATS.filter((_, i) => pk.boosts[i] > -6);
              if (downCandidates.length > 0) {
                const pDown = 1 / downCandidates.length;
                for (const down of downCandidates) {
                  pairs.push({up: null, down, prob: pDown});
                }
              }
            }
            if (pairs.length === 0) {
              afterMoody.push(br);
            } else {
              const picked = pickChoices(pairs.map(pr => ({item: pr, prob: pr.prob})), policy, stats);
              for (const pc of picked) {
                const st = picked.length === 1 ? br.state : cloneState(br.state);
                if (pc.item.up) applyStatBoost(ctx, st, entry.side, entry.pokeIdx, pc.item.up, 2, false);
                if (pc.item.down) applyStatBoost(ctx, st, entry.side, entry.pokeIdx, pc.item.down, -1, false);
                afterMoody.push({state: st, probability: br.probability * pc.prob, remainingActions: []});
              }
            }
          }
          curList = afterMoody;
        }
        // Hunger Switch (Morpeko) & Shields Down (Minior)
        for (const br of curList) {
          const pk = br.state.sides[entry.side].pokemon[entry.pokeIdx];
          if (pk.fainted) continue;
          const pkAb = activeAbilitySpec(sp, pk);
          if (pk.abilityActive && !pk.gastroAcid && pkAb.hungerSwitch && sp.speciesId.startsWith('morpeko') && !pk.transformed) {
            pk.formeId = pk.formeId === 'morpekohangry' ? null : 'morpekohangry';
          }
          if (pk.abilityActive && !pk.gastroAcid && pkAb.shieldsDown) {
            checkShieldsDown(ctx, br.state, entry.side, entry.pokeIdx);
          }
        }
        next.push(...curList);
      }
      branches = next;
    }

    // 8. Speed Boost, Encore/Taunt/Throat Chop/Disable/Stall/Timers & transient resets
    for (const b of branches) {
      for (const s of [0, 1] as const) {
        const side = b.state.sides[s];
        side.wideGuard = false;
        side.quickGuard = false;
        side.roundUsedThisTurn = false;
        if (side.tailwindTurns > 0) side.tailwindTurns--;
        if (side.reflectTurns > 0) side.reflectTurns--;
        if (side.lightScreenTurns > 0) side.lightScreenTurns--;
        if (side.auroraVeilTurns > 0) side.auroraVeilTurns--;
        if (side.safeguardTurns > 0) side.safeguardTurns--;

        for (const idx of side.active) {
          if (idx < 0) continue;
          const p = side.pokemon[idx];
          const sp = ctx.sides[s].team[idx];
          const ab = activeAbilitySpec(sp, p);
          if (!p.fainted && p.abilityActive && !p.gastroAcid && ab.speedBoost && !p.switchedInThisTurn) {
            applyStatBoost(ctx, b.state, s, idx, 'spe', 1, false);
          }
          if (!p.protecting && !p.enduring) p.protectStreak = 0;
          p.protecting = false;
          p.protectKind = '';
          p.enduring = false;
          p.roosted = false;
          p.flinched = false;
          p.movedThisTurn = false;
          p.switchedInThisTurn = false;
          p.helpingHandCount = 0;
          p.redirectKind = '';
          p.damagedThisTurn = 0;
          p.damagedCategory = '';
          p.damagedBySide = -1;
          p.damagedBySlot = -1;
          p.statLoweredThisTurn = false;
          p.focusPunchReady = false;
          p.focusPunchLost = false;
          p.beakBlastHeating = false;
          p.electrified = false;
          p.emergencyExitTriggered = false;
          if (!p.fainted) {
            p.activeTurns++;
            if (p.encoreMoveIdx >= 0) {
              p.encoreTurns--;
              if (p.encoreTurns <= 0 || p.pp[p.encoreMoveIdx] <= 0) {
                p.encoreMoveIdx = -1;
                p.encoreTurns = 0;
              }
            }
            if (p.disabledMoveIdx >= 0) {
              p.disabledTurns--;
              if (p.disabledTurns <= 0) {
                p.disabledMoveIdx = -1;
                p.disabledTurns = 0;
              }
            }
            if (p.tauntTurns > 0) p.tauntTurns--;
            if (p.throatChopTurns > 0) p.throatChopTurns--;
            if (p.magnetRiseTurns > 0) p.magnetRiseTurns--;
            if (p.lockOnTurns > 0) {
              p.lockOnTurns--;
              if (p.lockOnTurns === 0) {
                p.lockOnSide = -1;
                p.lockOnSlot = -1;
              }
            }
            if (p.uproarTurns > 0) {
              if (p.throatChopTurns > 0 || p.lastMoveId === 'struggle') {
                p.uproarTurns = 0;
              } else {
                p.uproarTurns--;
              }
            }
            if (p.lockedMoveIdx >= 0) {
              if (p.status === 'slp') {
                p.lockedMoveIdx = -1;
                p.lockedMoveDuration = 0;
                p.lockedMoveTrueDuration = 0;
              } else {
                p.lockedMoveTrueDuration--;
                p.lockedMoveDuration--;
              }
            }
          }
        }
      }
      const f = b.state.field;
      if (f.weatherTurns > 0) {
        f.weatherTurns--;
        if (f.weatherTurns === 0) {
          f.weather = '';
          applyWeatherFormes(ctx, b.state);
        }
      }
      if (f.terrainTurns > 0) {
        f.terrainTurns--;
        if (f.terrainTurns === 0) {
          f.terrain = '';
          applyTerrainFormes(ctx, b.state);
        }
      }
      if (f.trickRoomTurns > 0) f.trickRoomTurns--;
      if (f.gravityTurns > 0) f.gravityTurns--;
      if (f.magicRoomTurns > 0) f.magicRoomTurns--;
      if (f.wonderRoomTurns > 0) f.wonderRoomTurns--;
      if (f.fairyLockTurns > 0) f.fairyLockTurns--;

      if (checkEnded(b.state)) {
        out.push({state: b.state, probability: b.probability});
        continue;
      }

      // If lockedmove expired during residual (e.g. user was immobilized on Turn 2), remove it and confuse if trueDuration <= 1
      let finalBranches: ActiveBranch[] = [b];
      for (const s of [0, 1] as const) {
        for (const idx of b.state.sides[s].active) {
          if (idx < 0) continue;
          const nextFb: ActiveBranch[] = [];
          for (const fb of finalBranches) {
            const p = fb.state.sides[s].pokemon[idx];
            if (!p.fainted && p.lockedMoveIdx >= 0 && p.lockedMoveDuration <= 0) {
              const td = p.lockedMoveTrueDuration;
              p.lockedMoveIdx = -1;
              p.lockedMoveDuration = 0;
              p.lockedMoveTrueDuration = 0;
              if (td <= 1) {
                nextFb.push(...inflictConfusionWithBranching(ctx, fb, s, idx, policy, stats, false));
                continue;
              }
            }
            nextFb.push(fb);
          }
          finalBranches = nextFb;
        }
      }

      for (const fb of finalBranches) {
        const pendingSlots: {side: 0 | 1; slot: number}[] = [];
        for (const s of [0, 1] as const) {
          const side = fb.state.sides[s];
          const bench = legalBenchSwitches(side);
          let avail = bench.length;
          for (let slot = 0; slot < ctx.activeCount; slot++) {
            const idx = side.active[slot];
            if ((idx < 0 || side.pokemon[idx].fainted) && avail > 0) {
              pendingSlots.push({side: s, slot});
              avail--;
            }
          }
        }
        if (pendingSlots.length > 0) {
          fb.state.phase = {
            kind: 'switch',
            pendingSlots,
            remainingActions: [],
            needsEndOfTurn: false,
          };
        } else {
          fb.state.phase = {kind: 'turn'};
        }
        out.push({state: fb.state, probability: fb.probability});
      }
    }
  }

  return out;
}

function foldWeightedStatesByPokeHp(
  ctx: StaticBattleContext,
  list: WeightedState[],
  side: 0 | 1,
  idx: number,
  stats: StepStats
): WeightedState[] {
  if (list.length <= 1) return list;
  const maskPoke = {side, idx};
  const groups = new Map<string, WeightedState[]>();
  const passthrough: WeightedState[] = [];
  for (let i = 0; i < list.length; i++) {
    const ws = list[i];
    if (ws.probability <= EPS) continue;
    if (ws.state.phase.kind === 'ended') {
      passthrough.push(ws);
      continue;
    }
    const p = ws.state.sides[side].pokemon[idx];
    if (!p || p.fainted || p.hp <= 0) {
      passthrough.push(ws);
      continue;
    }
    const key = canonicalStateKey(ctx, ws.state, undefined, false, maskPoke);
    let g = groups.get(key);
    if (!g) {
      g = [ws];
      groups.set(key, g);
    } else {
      g.push(ws);
    }
  }
  if (groups.size + passthrough.length === list.length) return list;
  const out: WeightedState[] = [...passthrough];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    let totalProb = 0;
    const hpMap = new Map<number, number>();
    for (let i = 0; i < g.length; i++) {
      const ws = g[i];
      totalProb += ws.probability;
      const entries = getHpEntries(ws.state.sides[side].pokemon[idx]);
      for (let j = 0; j < entries.length; j++) {
        const e = entries[j];
        hpMap.set(e.hp, (hpMap.get(e.hp) ?? 0) + ws.probability * e.prob);
      }
    }
    const target = g[0];
    target.probability = totalProb;
    const combined: HpEntry[] = [];
    for (const [hp, w] of hpMap) {
      combined.push({hp, prob: w / totalProb});
    }
    setNormalizedHpDist(target.state.sides[side].pokemon[idx], combined);
    stats.merges += g.length - 1;
    out.push(target);
  }
  return out;
}

function finalizeOutcomes(
  ctx: StaticBattleContext,
  raw: WeightedState[],
  remainingMass: number,
  complete: boolean,
  policy: BranchPolicy,
  stats: StepStats
): StepResult {
  const hpOutputMode = policy.hpOutputMode ?? 'discrete';
  let expanded: WeightedState[] = [];
  if (hpOutputMode === 'discrete') {
    for (const ws of raw) {
      const sub = expandStateHpDists(ws);
      for (let i = 0; i < sub.length; i++) expanded.push(sub[i]);
    }
  } else {
    expanded = raw;
  }

  const merged = new Map<string, WeightedState>();
  for (const ws of expanded) {
    if (ws.probability <= EPS) continue;
    const key = canonicalStateKey(ctx, ws.state);
    const prev = merged.get(key);
    if (prev) {
      prev.probability += ws.probability;
      stats.merges++;
    } else {
      merged.set(key, {state: ws.state, probability: ws.probability});
    }
  }

  let outcomes = [...merged.values()];
  if (hpOutputMode === 'distributional' && outcomes.length > 1) {
    for (let s = 0; s < 2 && outcomes.length > 1; s++) {
      const sideIdx: 0 | 1 = s === 0 ? 0 : 1;
      const seenIdx = new Set<number>();
      for (let i = 0; i < outcomes.length; i++) {
        const act = outcomes[i].state.sides[sideIdx].active;
        for (let sl = 0; sl < act.length; sl++) {
          if (act[sl] >= 0) seenIdx.add(act[sl]);
        }
      }
      for (const idx of seenIdx) {
        if (outcomes.length <= 1) break;
        outcomes = foldWeightedStatesByPokeHp(ctx, outcomes, sideIdx, idx, stats);
      }
    }
  }
  let finalRemaining = remainingMass;

  if (policy.mode === 'pruned') {
    const minP = policy.minBranchProb ?? 0;
    if (minP > 0) {
      const kept: WeightedState[] = [];
      for (const o of outcomes) {
        if (o.probability < minP) finalRemaining += o.probability;
        else kept.push(o);
      }
      outcomes = kept;
    }
    if (policy.maxBranches !== undefined && outcomes.length > policy.maxBranches) {
      outcomes.sort((a, b) => b.probability - a.probability);
      for (let i = policy.maxBranches; i < outcomes.length; i++) {
        finalRemaining += outcomes[i].probability;
      }
      outcomes = outcomes.slice(0, policy.maxBranches);
    }
    if (policy.renormalize && outcomes.length > 0) {
      const sum = outcomes.reduce((s, o) => s + o.probability, 0);
      if (sum > EPS) {
        for (const o of outcomes) o.probability /= sum;
      }
      finalRemaining = 0;
    }
  }

  if (finalRemaining > 1 && finalRemaining <= 1 + 1e-9) {
    finalRemaining = 1;
  }

  return {
    outcomes,
    remainingMass: finalRemaining,
    complete: complete && finalRemaining <= 1e-12,
    stats,
  };
}

/**
 * Single-pass branching step for both normal turns (with Mega Evolution) and paused/faint switch decisions.
 */
export function stepBattle(
  ctx: StaticBattleContext,
  state: DynamicState,
  p1Action: SideAction,
  p2Action: SideAction,
  policy: BranchPolicy = {mode: 'certified', hpOutputMode: 'discrete'}
): StepResult {
  const stats = createStats();
  if (state.phase.kind === 'ended') {
    return {
      outcomes: [{state: cloneState(state), probability: 1}],
      remainingMass: 0,
      complete: true,
      stats,
    };
  }

  const root = cloneState(state);
  const sideActions: [SideAction, SideAction] = [p1Action, p2Action];

  // --- Phase: Switch (mid-turn pivot, Revival Blessing, Baton Pass, Shed Tail, Emergency Exit, or end-of-turn faint replacement) ---
  if (root.phase.kind === 'switch') {
    const switchPhase = root.phase;
    const switches: {side: 0 | 1; slot: number; benchIndex: number; speed: number; meta: PendingSwitchSlot}[] = [];
    for (const ps of switchPhase.pendingSlots) {
      const act = sideActions[ps.side].find(a => a.slot === ps.slot);
      if (act && act.kind === 'switch') {
        const prevIdx = root.sides[ps.side].active[ps.slot];
        const spe = prevIdx >= 0 ? effectiveSpeed(ctx, root, ps.side, prevIdx) : 0;
        switches.push({side: ps.side, slot: ps.slot, benchIndex: act.benchIndex, speed: spe, meta: ps});
      }
    }
    switches.sort((a, b) => b.speed - a.speed);

    root.phase = {kind: 'turn'};
    let batch: ActiveBranch[] = [{
      state: root,
      probability: 1,
      remainingActions: switchPhase.remainingActions.map(a => ({...a, action: {...a.action}})),
    }];

    for (const sw of switches) {
      batch = performSwitchIn(ctx, batch, sw.side, sw.slot, sw.benchIndex, policy, stats, sw.meta);
    }

    if (switchPhase.remainingActions.length > 0) {
      const loopRes = runActionLoop(ctx, batch, policy, stats);
      const afterEot = switchPhase.needsEndOfTurn
        ? runEndOfTurn(ctx, loopRes.completed, policy, stats)
        : loopRes.completed;
      return finalizeOutcomes(
        ctx,
        [...afterEot, ...loopRes.paused, ...loopRes.ended],
        loopRes.remainingMass,
        loopRes.complete,
        policy,
        stats
      );
    }

    const done: WeightedState[] = batch.map(b => {
      checkEnded(b.state);
      return {state: b.state, probability: b.probability};
    });
    const finalDone = switchPhase.needsEndOfTurn
      ? runEndOfTurn(ctx, done, policy, stats)
      : done;
    return finalizeOutcomes(ctx, finalDone, 0, true, policy, stats);
  }

  // --- Phase: Normal Turn ---
  for (const s of [0, 1] as const) {
    root.sides[s].wideGuard = false;
    root.sides[s].quickGuard = false;
    root.sides[s].roundUsedThisTurn = false;
    for (const idx of root.sides[s].active) {
      if (idx < 0) continue;
      const p = root.sides[s].pokemon[idx];
      p.protecting = false;
      p.protectKind = '';
      p.enduring = false;
      p.roosted = false;
      p.flinched = false;
      p.movedThisTurn = false;
      p.switchedInThisTurn = false;
      p.helpingHandCount = 0;
      p.redirectKind = '';
      p.damagedThisTurn = 0;
      p.damagedCategory = '';
      p.damagedBySide = -1;
      p.damagedBySlot = -1;
      p.statLoweredThisTurn = false;
      p.focusPunchReady = false;
      p.focusPunchLost = false;
      p.beakBlastHeating = false;
      p.electrified = false;
      p.emergencyExitTriggered = false;
    }
  }

  // Separate switches (priority +6), Mega Evolutions (before moves, dynamic speed updates immediately!), and moves
  const switches: {side: 0 | 1; action: SwitchAction; speed: number}[] = [];
  const megas: {side: 0 | 1; slot: number; speed: number}[] = [];
  const moveQueue: PendingQueuedAction[] = [];

  for (const s of [0, 1] as const) {
    for (const act of sideActions[s]) {
      const pokeIdx = root.sides[s].active[act.slot];
      if (pokeIdx < 0 || root.sides[s].pokemon[pokeIdx].fainted) continue;
      if (act.kind === 'switch') {
        switches.push({
          side: s,
          action: act,
          speed: effectiveSpeed(ctx, root, s, pokeIdx),
        });
      } else if (act.kind === 'move') {
        if (act.mega && canSlotMegaEvolve(ctx, root, s, act.slot)) {
          megas.push({side: s, slot: act.slot, speed: effectiveSpeed(ctx, root, s, pokeIdx)});
        }
        const p = root.sides[s].pokemon[pokeIdx];
        const sp = ctx.sides[s].team[pokeIdx];
        const effIdx = p.chargingMoveIdx >= 0 ? p.chargingMoveIdx : (p.lockedMoveIdx >= 0 ? p.lockedMoveIdx : (p.encoreMoveIdx >= 0 ? p.encoreMoveIdx : act.moveIndex));
        const move = getMoveForAction(ctx, s, pokeIdx, effIdx, root);
        const ab = activeAbilitySpec(sp, p);
        let prio = move.priority;
        if (p.abilityActive && !p.gastroAcid && ab.prankster && move.category === 'Status') prio += 1;
        if (p.abilityActive && !p.gastroAcid && ab.galeWings && move.type === 'Flying' && hpMin(p) === sp.maxhp) prio += 1;
        if (move.specialKind === 'grassy-glide' && root.field.terrain === 'grassy' && isGrounded(sp, p, root)) prio += 1;
        const subOrder = p.abilityActive && !p.gastroAcid && ab.stall ? -1 : 0;
        moveQueue.push({
          side: s,
          action: act,
          priority: prio,
          speed: effectiveSpeed(ctx, root, s, pokeIdx),
          subOrder,
        });
      }
    }
  }

  // 1. Execute voluntary switches first (ordered by speed descending)
  switches.sort((a, b) => b.speed - a.speed);
  let batch: ActiveBranch[] = [{
    state: root,
    probability: 1,
    remainingActions: moveQueue,
  }];
  for (const sw of switches) {
    batch = performSwitchIn(ctx, batch, sw.side, sw.action.slot, sw.action.benchIndex, policy, stats);
  }

  // 2. Execute Mega Evolutions (ordered by pre-Mega speed descending; speed & ability update BEFORE moves execute!)
  megas.sort((a, b) => b.speed - a.speed);
  for (const mg of megas) {
    const nextMg: ActiveBranch[] = [];
    for (const b of batch) {
      if (!canSlotMegaEvolve(ctx, b.state, mg.side, mg.slot)) {
        nextMg.push(b);
        continue;
      }
      const pokeIdx = b.state.sides[mg.side].active[mg.slot];
      const p = b.state.sides[mg.side].pokemon[pokeIdx];
      b.state.sides[mg.side].megaUsed = true;
      p.megaEvolved = true;
      p.types = null;
      nextMg.push(...triggerEntryAbilitiesBranching(ctx, b, mg.side, pokeIdx, policy, stats));
    }
    batch = nextMg;
  }

  // 3. Quick Draw (30% chance to move first in priority bracket for attacking moves)
  for (let qi = 0; qi < moveQueue.length; qi++) {
    const nextQd: ActiveBranch[] = [];
    for (const b of batch) {
      const ra = b.remainingActions[qi];
      if (!ra) {
        nextQd.push(b);
        continue;
      }
      const pIdx = b.state.sides[ra.side].active[ra.action.slot];
      const p = pIdx >= 0 ? b.state.sides[ra.side].pokemon[pIdx] : null;
      const sp = pIdx >= 0 ? ctx.sides[ra.side].team[pIdx] : null;
      const qdIdx = p ? (p.chargingMoveIdx >= 0 ? p.chargingMoveIdx : (p.lockedMoveIdx >= 0 ? p.lockedMoveIdx : (p.encoreMoveIdx >= 0 ? p.encoreMoveIdx : ra.action.moveIndex))) : ra.action.moveIndex;
      const mv = p && sp ? getMoveForAction(ctx, ra.side, pIdx, qdIdx, b.state) : null;
      if (p && sp && mv && !p.fainted && p.abilityActive && !p.gastroAcid && activeAbilitySpec(sp, p).quickDraw && mv.category !== 'Status') {
        const choices = pickChoices([{item: true, prob: 0.3}, {item: false, prob: 0.7}], policy, stats);
        for (const c of choices) {
          const st = choices.length === 1 ? b.state : cloneState(b.state);
          const rem = b.remainingActions.map((x, idx) => ({
            ...x,
            action: {...x.action},
            subOrder: idx === qi && c.item ? 1 : x.subOrder,
          }));
          nextQd.push({state: st, probability: b.probability * c.prob, remainingActions: rem});
        }
      } else {
        nextQd.push(b);
      }
    }
    batch = nextQd;
  }

  // 4. Trigger start-of-turn onUpdate items (Sitrus / Oran / Status berries when starting below threshold)
  //    and pre-turn Focus Punch / Beak Blast charging flags
  for (const b of batch) {
    for (const ra of b.remainingActions) {
      const idx = b.state.sides[ra.side].active[ra.action.slot];
      if (idx < 0) continue;
      const p = b.state.sides[ra.side].pokemon[idx];
      if (p.fainted) continue;
      const effIdx = p.chargingMoveIdx >= 0 ? p.chargingMoveIdx : (p.lockedMoveIdx >= 0 ? p.lockedMoveIdx : (p.encoreMoveIdx >= 0 ? p.encoreMoveIdx : ra.action.moveIndex));
      const mv = getMoveForAction(ctx, ra.side, idx, effIdx, b.state);
      if (mv.specialKind === 'focus-punch') p.focusPunchReady = true;
      if (mv.specialKind === 'beak-blast') p.beakBlastHeating = true;
    }
  }
  for (const s of [0, 1] as const) {
    for (let slot = 0; slot < ctx.activeCount; slot++) {
      const next: ActiveBranch[] = [];
      for (const b of batch) {
        const idx = b.state.sides[s].active[slot];
        if (idx >= 0) {
          maybeTriggerStatusBerry(ctx, b.state, s, idx);
          next.push(...maybeTriggerSitrus(ctx, b, s, idx, stats));
        } else {
          next.push(b);
        }
      }
      batch = next;
    }
  }

  // 5. Execute moves dynamically in priority + subOrder + post-Mega speed order
  const loopRes = runActionLoop(ctx, batch, policy, stats);

  // 6. End-of-turn residual effects
  const afterEot = runEndOfTurn(ctx, loopRes.completed, policy, stats);

  return finalizeOutcomes(
    ctx,
    [...afterEot, ...loopRes.paused, ...loopRes.ended],
    loopRes.remainingMass,
    loopRes.complete,
    policy,
    stats
  );
}
