import type {Battle} from '@pkmn/sim';
import type {BoundedAdapter, MonotoneBoxOutcome, MonotoneSignature} from '../bounded-solver';
import type {Action, Outcome} from '../types';
import {canRunInEngine, compileContextFromBattle} from './context';
import {
  activeAbilitySpec,
  activeItemSpec,
  canonicalStateKey,
  cloneState,
  expandStateHpDists,
  legalSideActions,
  stateFromBattle,
  terminalUtilityFromState,
} from './state';
import {stepBattle} from './turn';
import type {CompiledAbilitySpec} from './effects/abilities';
import type {
  DynamicState,
  HpEntry,
  HpOutputMode,
  SideAction,
  StaticBattleContext,
  StaticPokemonData,
} from './types';

export interface EngineActionEntry extends Action {
  sideAction: SideAction;
}

export interface EngineAdapterOptions {
  hpOutputMode?: HpOutputMode;
  /** Enable sound progressive tail deferral cursor for BoundedSolver (default true). */
  progressive?: boolean;
}

function allStaticAbilities(sp: StaticPokemonData): CompiledAbilitySpec[] {
  return sp.megaForme ? [sp.abilitySpec, sp.megaForme.abilitySpec] : [sp.abilitySpec];
}

function sideHasMoveOfTypeOrDynamic(sp: StaticPokemonData, targetType: string, ab: CompiledAbilitySpec): boolean {
  for (const m of sp.moves) {
    if (m.category === 'Status') continue;
    if (m.type === targetType || m.optTraits.dynamicMoveType) return true;
    if (ab.liquidVoice && targetType === 'Water' && m.sound) return true;
    if (ab.ateType === targetType && m.type === 'Normal') return true;
  }
  return false;
}

/**
 * Build a strictly sound HP-monotonicity analyzer for 1v1 and multi-Pokemon
 * singles/doubles battles from co-located fail-closed optimization traits on
 * moves, abilities, and items.
 *
 * For any turn-phase state where side `s` has zero alive bench Pokemon,
 * higher `pokemon[idx].hp` (when `isPokeHpMonotone` returns true) is
 * guaranteed to yield weakly better utility for side `s`.
 */
export interface MonotoneAnalyzer {
  anyAxisAllowed: boolean;
  isHpMonotone: (state: DynamicState, s: 0 | 1, hp: number) => boolean;
  isPokeHpMonotone: (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number) => boolean;
  monotoneSignature: (state: DynamicState) => MonotoneSignature | null;
}

function countAliveAndBench(state: DynamicState, s: 0 | 1): {alive: number; aliveBench: number} {
  const side = state.sides[s];
  let alive = 0;
  let aliveActive = 0;
  for (let i = 0; i < side.pokemon.length; i++) {
    if (!side.pokemon[i].fainted) alive++;
  }
  for (let sl = 0; sl < side.active.length; sl++) {
    const idx = side.active[sl];
    if (idx >= 0 && !side.pokemon[idx].fainted) aliveActive++;
  }
  return {alive, aliveBench: alive - aliveActive};
}

export function createMonotoneAnalyzer(ctx: StaticBattleContext): MonotoneAnalyzer {
  const disabled: MonotoneAnalyzer = {
    anyAxisAllowed: false,
    isHpMonotone: () => false,
    isPokeHpMonotone: () => false,
    monotoneSignature: () => null,
  };

  let battleHasHpBerry = false;
  let battleHasBerryMutator = false;
  for (let s = 0; s < 2; s++) {
    for (const mon of ctx.sides[s].team) {
      if (mon.itemSpec.optTraits.hpThresholdBerry) battleHasHpBerry = true;
      for (const m of mon.moves) {
        if (m.optTraits.hpMonotone === 'unsafe-both') return disabled;
        if (m.optTraits.canMutateBerry) battleHasBerryMutator = true;
      }
      for (const ab of allStaticAbilities(mon)) {
        if (ab.optTraits.mutatesAbilities) return disabled;
        if (ab.optTraits.mutatesBerry) battleHasBerryMutator = true;
      }
    }
  }

  if (battleHasHpBerry && battleHasBerryMutator) {
    return disabled;
  }

  const is1v1 = ctx.activeCount === 1 && ctx.sides[0].team.length === 1 && ctx.sides[1].team.length === 1;

  if (is1v1) {
    const sp: [StaticPokemonData, StaticPokemonData] = [ctx.sides[0].team[0], ctx.sides[1].team[0]];
    const staticAxisAllowed: [boolean, boolean] = [true, true];
    const canHealWithoutBerry: [boolean, boolean] = [false, false];

    for (let s = 0; s < 2; s++) {
      const self = sp[s];
      const foe = sp[1 - s];

      let selfDamagesAttackerOnHit = self.itemSpec.optTraits.damagesAttackerOnHit;
      for (const m of self.moves) {
        if (m.optTraits.hpMonotone === 'unsafe-self') staticAxisAllowed[s] = false;
        if (m.optTraits.canHealSelf) canHealWithoutBerry[s] = true;
      }
      if (self.itemSpec.optTraits.canHealWithoutBerry) canHealWithoutBerry[s] = true;
      for (const ab of allStaticAbilities(self)) {
        if (ab.optTraits.canHealSelf) canHealWithoutBerry[s] = true;
        if (ab.optTraits.damagesAttackerOnHit) selfDamagesAttackerOnHit = true;
        if (ab.optTraits.hpThreshold === 'unsafe-self') staticAxisAllowed[s] = false;
      }

      const foeHasSelfRecoilItem = foe.itemSpec.optTraits.selfRecoilOnAttack;
      for (const m of foe.moves) {
        if (m.optTraits.hpMonotone === 'unsafe-target') staticAxisAllowed[s] = false;
        if (m.optTraits.hasDrain && (selfDamagesAttackerOnHit || foeHasSelfRecoilItem)) {
          staticAxisAllowed[s] = false;
        }
        if (m.optTraits.canHealFoe) canHealWithoutBerry[s] = true;
      }
      if (foe.itemSpec.optTraits.breaksFoeHpMonotonicity) staticAxisAllowed[s] = false;
      for (const ab of allStaticAbilities(foe)) {
        if (ab.optTraits.canHealFoe) canHealWithoutBerry[s] = true;
      }
    }

    if (!staticAxisAllowed[0] && !staticAxisAllowed[1]) {
      return disabled;
    }

    const isHpMonotone = (state: DynamicState, s: 0 | 1, hp: number): boolean => {
      if (!staticAxisAllowed[s]) return false;
      const side = state.sides[s];
      const p = side.pokemon[0];
      if (p.fainted || hp <= 0 || p.transformed) return false;

      const mon = sp[s];
      const itemSpec = p.itemActive ? activeItemSpec(ctx, mon, p) : null;
      if (itemSpec?.optTraits.hpThresholdBerry || p.cudchewBerry !== '') return false;

      const canHealNow =
        canHealWithoutBerry[s] ||
        state.field.terrain === 'grassy' ||
        p.aquaRing ||
        p.ingrain ||
        side.wishTurns[0] > 0 ||
        state.sides[1 - s].pokemon[0].leechSeedSlot >= 0;

      const checkAbility = (ab: CompiledAbilitySpec): boolean => {
        switch (ab.optTraits.hpThreshold) {
          case 'none':
          case 'half-maxhp-pivot':
            return true;
          case 'pinch-third':
            return !ab.pinchType || !sideHasMoveOfTypeOrDynamic(mon, ab.pinchType, ab) ||
              (hp <= Math.floor(mon.maxhp / 3) && !canHealNow);
          case 'half-maxhp':
            return hp <= Math.floor(mon.maxhp / 2) && !canHealNow;
          case 'below-maxhp':
            return hp < mon.maxhp && !canHealNow;
          case 'unsafe-self':
            return false;
        }
      };

      if (p.abilityActive && !p.gastroAcid) {
        if (!checkAbility(activeAbilitySpec(mon, p))) return false;
      }
      if (!side.megaUsed && mon.megaForme) {
        if (!checkAbility(mon.megaForme.abilitySpec)) return false;
      }
      return true;
    };

    const monotoneSignature = (state: DynamicState): MonotoneSignature | null => {
      if (state.phase.kind !== 'turn') return null;
      const p0 = state.sides[0].pokemon[0];
      const p1 = state.sides[1].pokemon[0];
      if (p0.hpDist || p1.hpDist) return null;
      const m0 = isHpMonotone(state, 0, p0.hp);
      const m1 = isHpMonotone(state, 1, p1.hp);
      if (!m0 && !m1) return null;
      const groupKey = canonicalStateKey(ctx, state, [m0, m1]);
      return {
        groupKey,
        h1: m0 ? p0.hp : null,
        h2: m1 ? p1.hp : null,
      };
    };

    return {
      anyAxisAllowed: true,
      isHpMonotone,
      isPokeHpMonotone: (state, s, pokeIdx, hp) => pokeIdx === 0 && isHpMonotone(state, s, hp),
      monotoneSignature,
    };
  }

  // General multi-Pokemon (singles with bench & doubles) static traits per Pokemon
  interface MonStaticMonoInfo {
    unsafeSelf: boolean;
    hasFairyAura: boolean;
    damagesAttackerOnHit: boolean;
    hasSelfRecoilItem: boolean;
    hasDrain: boolean;
    hasRecoilMove: boolean;
    hasThresholdTrigger: boolean;
    hasUnsafeTarget: boolean;
    breaksFoeHpMono: boolean;
    hasAllAdjacentDamage: boolean;
    hasKoBonus: boolean;
    canHealSelf: boolean;
    canHealOther: boolean;
    setsGrassy: boolean;
  }

  const info: [MonStaticMonoInfo[], MonStaticMonoInfo[]] = [[], []];
  for (let s = 0; s < 2; s++) {
    for (const mon of ctx.sides[s].team) {
      let unsafeSelf = false;
      let hasFairyAura = false;
      let damagesAttackerOnHit = mon.itemSpec.optTraits.damagesAttackerOnHit;
      const hasSelfRecoilItem = mon.itemSpec.optTraits.selfRecoilOnAttack;
      let hasDrain = false;
      let hasRecoilMove = false;
      let hasThresholdTrigger = mon.itemSpec.optTraits.hpThresholdBerry;
      let hasUnsafeTarget = false;
      const breaksFoeHpMono = mon.itemSpec.optTraits.breaksFoeHpMonotonicity;
      let hasAllAdjacentDamage = false;
      let hasKoBonus = false;
      let canHealSelf = mon.itemSpec.optTraits.canHealWithoutBerry;
      let canHealOther = false;
      let setsGrassy = false;

      for (const m of mon.moves) {
        if (m.optTraits.hpMonotone === 'unsafe-self') {
          unsafeSelf = true;
          hasThresholdTrigger = true;
        }
        if (m.optTraits.hpMonotone === 'unsafe-target') hasUnsafeTarget = true;
        if (m.optTraits.hasDrain) hasDrain = true;
        if (m.recoil !== null) hasRecoilMove = true;
        if (m.target === 'allAdjacent' && m.category !== 'Status') hasAllAdjacentDamage = true;
        if (m.specialKind === 'last-respects' || m.specialKind === 'fell-stinger') hasKoBonus = true;
        if (m.optTraits.canHealSelf) canHealSelf = true;
        if (m.optTraits.canHealFoe || m.specialKind === 'heal-pulse' || m.specialKind === 'pollen-puff') {
          canHealOther = true;
        }
        if (m.setsTerrain === 'grassy') setsGrassy = true;
      }
      for (const ab of allStaticAbilities(mon)) {
        if (ab.optTraits.hpThreshold === 'unsafe-self') unsafeSelf = true;
        if (ab.optTraits.hpThreshold !== 'none') hasThresholdTrigger = true;
        if (ab.fairyAura) hasFairyAura = true;
        if (ab.optTraits.damagesAttackerOnHit) damagesAttackerOnHit = true;
        if (ab.supremeOverlord || ab.moxie || ab.battleBond) hasKoBonus = true;
        if (ab.optTraits.canHealSelf) canHealSelf = true;
        if (ab.optTraits.canHealFoe) canHealOther = true;
        if (ab.setsTerrain === 'grassy' || ab.seedSower) setsGrassy = true;
      }

      info[s].push({
        unsafeSelf,
        hasFairyAura,
        damagesAttackerOnHit,
        hasSelfRecoilItem,
        hasDrain,
        hasRecoilMove,
        hasThresholdTrigger,
        hasUnsafeTarget,
        breaksFoeHpMono,
        hasAllAdjacentDamage,
        hasKoBonus,
        canHealSelf,
        canHealOther,
        setsGrassy,
      });
    }
  }

  const isPokeHpMonotone = (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number): boolean => {
    if (state.phase.kind !== 'turn') return false;
    const side = state.sides[s];
    const p = side.pokemon[pokeIdx];
    if (!p || p.fainted || hp <= 0 || p.transformed) return false;

    // Fail closed when side `s` still has an alive bench Pokemon: fainting at
    // lower HP can yield a strictly better free switch-in than surviving.
    const {alive: myAlive, aliveBench} = countAliveAndBench(state, s);
    if (aliveBench > 0) return false;

    const myInfo = info[s][pokeIdx];
    if (myInfo.unsafeSelf) return false;
    if (myAlive > 1 && myInfo.hasFairyAura) return false;

    const mon = ctx.sides[s].team[pokeIdx];
    const itemSpec = p.itemActive ? activeItemSpec(ctx, mon, p) : null;
    if (itemSpec?.optTraits.hpThresholdBerry || p.cudchewBerry !== '') return false;

    // Check alive teammates on side `s`
    if (myAlive > 1) {
      for (let j = 0; j < side.pokemon.length; j++) {
        if (j === pokeIdx || side.pokemon[j].fainted) continue;
        const allyInfo = info[s][j];
        if (allyInfo.hasAllAdjacentDamage || allyInfo.hasKoBonus || allyInfo.hasUnsafeTarget) {
          return false;
        }
      }
    }

    // Check alive opposing Pokemon
    const opp: 0 | 1 = s === 0 ? 1 : 0;
    const oppSide = state.sides[opp];
    for (let j = 0; j < oppSide.pokemon.length; j++) {
      if (oppSide.pokemon[j].fainted) continue;
      const foeInfo = info[opp][j];
      if (foeInfo.hasUnsafeTarget || foeInfo.breaksFoeHpMono) return false;
      if (foeInfo.hasDrain) {
        if (myAlive > 1 || myInfo.damagesAttackerOnHit || foeInfo.hasSelfRecoilItem) return false;
      }
      if (myAlive > 1 && foeInfo.hasRecoilMove && foeInfo.hasThresholdTrigger) {
        return false;
      }
    }

    const computeCanHealNow = (): boolean => {
      if (myInfo.canHealSelf || state.field.terrain === 'grassy' || p.aquaRing || p.ingrain) return true;
      const slot = side.active.indexOf(pokeIdx);
      if (slot >= 0 && side.wishTurns[slot] > 0) return true;
      for (let j = 0; j < oppSide.pokemon.length; j++) {
        if (oppSide.pokemon[j].fainted) continue;
        if (oppSide.pokemon[j].leechSeedSlot >= 0) return true;
        if (info[opp][j].canHealOther || info[opp][j].setsGrassy) return true;
      }
      for (let j = 0; j < side.pokemon.length; j++) {
        if (j === pokeIdx || side.pokemon[j].fainted) continue;
        if (info[s][j].canHealOther || info[s][j].setsGrassy) return true;
      }
      return false;
    };

    let canHealCached: boolean | null = null;
    const canHeal = () => {
      if (canHealCached === null) canHealCached = computeCanHealNow();
      return canHealCached;
    };

    const checkAbility = (ab: CompiledAbilitySpec): boolean => {
      switch (ab.optTraits.hpThreshold) {
        case 'none':
        case 'half-maxhp-pivot':
          // Safe because aliveBench === 0 (Emergency Exit / Wimp Out cannot switch).
          return true;
        case 'pinch-third':
          return !ab.pinchType || !sideHasMoveOfTypeOrDynamic(mon, ab.pinchType, ab) ||
            (hp <= Math.floor(mon.maxhp / 3) && !canHeal());
        case 'half-maxhp':
          return hp <= Math.floor(mon.maxhp / 2) && !canHeal();
        case 'below-maxhp':
          return hp < mon.maxhp && !canHeal();
        case 'unsafe-self':
          return false;
      }
    };

    if (p.abilityActive && !p.gastroAcid) {
      if (!checkAbility(activeAbilitySpec(mon, p))) return false;
    }
    if (!side.megaUsed && mon.megaForme) {
      if (!checkAbility(mon.megaForme.abilitySpec)) return false;
    }
    return true;
  };

  // Reuse 2D monotone frontier on 1v1 residual subgames reached inside multi-Pokemon battles
  const monotoneSignature = (state: DynamicState): MonotoneSignature | null => {
    if (state.phase.kind !== 'turn') return null;
    let i0 = -1;
    let c0 = 0;
    for (let i = 0; i < state.sides[0].pokemon.length; i++) {
      if (!state.sides[0].pokemon[i].fainted) {
        i0 = i;
        c0++;
        if (c0 > 1) return null;
      }
    }
    let i1 = -1;
    let c1 = 0;
    for (let i = 0; i < state.sides[1].pokemon.length; i++) {
      if (!state.sides[1].pokemon[i].fainted) {
        i1 = i;
        c1++;
        if (c1 > 1) return null;
      }
    }
    if (c0 !== 1 || c1 !== 1) return null;
    const p0 = state.sides[0].pokemon[i0];
    const p1 = state.sides[1].pokemon[i1];
    if (p0.hpDist || p1.hpDist) return null;
    const m0 = isPokeHpMonotone(state, 0, i0, p0.hp);
    const m1 = isPokeHpMonotone(state, 1, i1, p1.hp);
    if (!m0 && !m1) return null;
    const groupKey = canonicalStateKey(ctx, state, [m0 ? i0 : -1, m1 ? i1 : -1]);
    return {
      groupKey,
      h1: m0 ? p0.hp : null,
      h2: m1 ? p1.hp : null,
    };
  };

  return {
    anyAxisAllowed: true,
    isHpMonotone: (state, s, hp) => isPokeHpMonotone(state, s, state.sides[s].active[0], hp),
    isPokeHpMonotone,
    monotoneSignature,
  };
}

export function createMonotoneSignature(
  ctx: StaticBattleContext
): (state: DynamicState) => MonotoneSignature | null {
  return createMonotoneAnalyzer(ctx).monotoneSignature;
}

interface MultiHpAxis {
  side: 0 | 1;
  pokeIdx: number;
  entries: HpEntry[];
  monotone: boolean;
}

interface HpAxisChunk {
  entries: HpEntry[];
  sum: number;
  monotone: boolean;
}

function materializeHpVector(
  baseState: DynamicState,
  axes: readonly MultiHpAxis[],
  pickMaxForP1: boolean | null
): DynamicState {
  const st = cloneState(baseState);
  for (let i = 0; i < axes.length; i++) {
    const a = axes[i];
    const hp = pickMaxForP1 === null
      ? a.entries[0].hp
      : (a.side === 0
        ? (pickMaxForP1 ? a.entries[a.entries.length - 1].hp : a.entries[0].hp)
        : (pickMaxForP1 ? a.entries[0].hp : a.entries[a.entries.length - 1].hp));
    const p = st.sides[a.side].pokemon[a.pokeIdx];
    p.hp = hp;
    p.hpDist = null;
    p.fainted = hp <= 0;
  }
  return st;
}

function partitionMonotoneAxis(
  state: DynamicState,
  side: 0 | 1,
  pokeIdx: number,
  dist: HpEntry[],
  isPokeHpMonotone: (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number) => boolean
): HpAxisChunk[] {
  const chunks: HpAxisChunk[] = [];
  let monoEntries: HpEntry[] | null = null;
  let monoSum = 0;
  let prevHp = -1;
  let nonMonoEntries: HpEntry[] | null = null;
  let nonMonoSum = 0;
  const flushMono = () => {
    if (monoEntries && monoEntries.length > 0) {
      chunks.push({entries: monoEntries, sum: monoSum, monotone: true});
      monoEntries = null;
      monoSum = 0;
    }
  };
  const flushNonMono = () => {
    if (nonMonoEntries && nonMonoEntries.length > 0) {
      chunks.push({entries: nonMonoEntries, sum: nonMonoSum, monotone: false});
      nonMonoEntries = null;
      nonMonoSum = 0;
    }
  };
  for (const e of dist) {
    if (isPokeHpMonotone(state, side, pokeIdx, e.hp)) {
      flushNonMono();
      // Split disjoint HP clusters (e.g. a 1/24 crit cluster sitting far below
      // the 23/24 non-crit range) so a rare tail never widens the main box.
      if (monoEntries && prevHp >= 0 && e.hp - prevHp > 6) {
        flushMono();
      }
      if (!monoEntries) monoEntries = [];
      monoEntries.push(e);
      monoSum += e.prob;
      prevHp = e.hp;
    } else {
      flushMono();
      prevHp = -1;
      if (!nonMonoEntries) nonMonoEntries = [];
      nonMonoEntries.push(e);
      nonMonoSum += e.prob;
    }
  }
  flushMono();
  flushNonMono();
  return chunks;
}

function makeMultiBoxOrSingleton(
  baseState: DynamicState,
  probability: number,
  axes: MultiHpAxis[]
): Outcome | MonotoneBoxOutcome {
  let anyVarying = false;
  let anyNonMonoVarying = false;
  for (let i = 0; i < axes.length; i++) {
    if (axes[i].entries.length > 1) {
      anyVarying = true;
      if (!axes[i].monotone) anyNonMonoVarying = true;
    }
  }
  if (!anyVarying) {
    const snap = materializeHpVector(baseState, axes, null);
    const utility = terminalUtilityFromState(snap);
    if (utility !== null) {
      return {utility, probability};
    }
    return {snapshot: snap as any, probability};
  }

  // If any varying axis is non-monotone, emit a sound lazy unexpanded box
  // (null corners -> [-1, +1]) and bisect non-monotone axes first on split().
  const lowerSnapshot = anyNonMonoVarying ? null : (materializeHpVector(baseState, axes, false) as any);
  const upperSnapshot = anyNonMonoVarying ? null : (materializeHpVector(baseState, axes, true) as any);

  return {
    probability,
    lowerSnapshot,
    upperSnapshot,
    split: () => {
      let splitAxisIdx = -1;
      let bestLen = 0;
      for (let i = 0; i < axes.length; i++) {
        const a = axes[i];
        if (a.entries.length <= 1) continue;
        if (anyNonMonoVarying && a.monotone) continue;
        if (a.entries.length > bestLen) {
          bestLen = a.entries.length;
          splitAxisIdx = i;
        }
      }
      const target = axes[splitAxisIdx];
      const mid = target.entries.length >>> 1;
      const leftEntries = target.entries.slice(0, mid);
      const rightEntries = target.entries.slice(mid);
      let sL = 0;
      for (let i = 0; i < leftEntries.length; i++) sL += leftEntries[i].prob;
      let sR = 0;
      for (let i = 0; i < rightEntries.length; i++) sR += rightEntries[i].prob;
      const total = sL + sR;
      const leftAxes = axes.slice();
      leftAxes[splitAxisIdx] = {...target, entries: leftEntries};
      const rightAxes = axes.slice();
      rightAxes[splitAxisIdx] = {...target, entries: rightEntries};
      return [
        makeMultiBoxOrSingleton(baseState, probability * (sL / total), leftAxes),
        makeMultiBoxOrSingleton(baseState, probability * (sR / total), rightAxes),
      ];
    },
  };
}

function formatSideAction(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  sideAction: SideAction
): EngineActionEntry {
  const names: string[] = [];
  const ids: string[] = [];
  const cmds: string[] = [];
  for (const act of sideAction) {
    if (act.kind === 'pass') {
      names.push('Pass');
      ids.push('pass');
      cmds.push('pass');
    } else if (act.kind === 'switch') {
      const sp = ctx.sides[sideIdx].team[act.benchIndex];
      names.push(`Switch ${sp.name}`);
      ids.push(`switch:${act.benchIndex}`);
      cmds.push(`switch ${act.benchIndex + 1}`);
    } else {
      const pokeIdx = state.sides[sideIdx].active[act.slot];
      const sp = ctx.sides[sideIdx].team[pokeIdx];
      if (act.moveIndex < 0) {
        names.push('Struggle');
        ids.push('struggle');
        cmds.push('auto');
      } else {
        const move = sp.moves[act.moveIndex];
        const targetSuffix = ctx.activeCount > 1 && act.targetSide !== undefined && act.targetSlot !== undefined
          ? (act.targetSide === sideIdx ? ` -${act.targetSlot + 1}` : ` +${act.targetSlot + 1}`)
          : '';
        const megaSuffix = act.mega ? ' mega' : '';
        names.push(`${move.name}${targetSuffix}${act.mega ? ' (Mega)' : ''}`);
        ids.push(`${move.id}${targetSuffix}${act.mega ? ':mega' : ''}`);
        cmds.push(`move ${act.moveIndex + 1}${targetSuffix}${megaSuffix}`);
      }
    }
  }
  return {
    name: names.join(', '),
    id: ids.join(','),
    command: cmds.join(', '),
    sideAction,
  };
}

/**
 * Sound rule-based action ordering for doubles: keeps every legal action intact
 * while ordering strong/priority/spread attacks against opponents first, then
 * support/status, Protect/Switch, guaranteed-failing moves (Fake Out after turn 1),
 * and damaging ally-targeting moves last.
 */
function doublesActionOrderScore(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  sideAction: SideAction
): number {
  let score = 0;
  for (let i = 0; i < sideAction.length; i++) {
    const act = sideAction[i];
    if (act.kind === 'pass') {
      score += 300;
      continue;
    }
    if (act.kind === 'switch') {
      score += 250;
      continue;
    }
    const pokeIdx = state.sides[sideIdx].active[act.slot];
    if (pokeIdx < 0) continue;
    const poke = state.sides[sideIdx].pokemon[pokeIdx];
    if (act.moveIndex < 0) {
      score += 150;
      continue;
    }
    const move = ctx.sides[sideIdx].team[pokeIdx].moves[act.moveIndex];
    if (!move) continue;
    if (act.targetSide === sideIdx && act.targetSlot !== act.slot &&
        move.category !== 'Status' && move.specialKind !== 'pollen-puff') {
      score += 1000;
      continue;
    }
    if (move.specialKind === 'fake-out' && !poke.switchedInThisTurn) {
      score += 400;
      continue;
    }
    if (
      move.specialKind === 'protect' ||
      move.specialKind === 'spiky-shield' ||
      move.specialKind === 'kings-shield' ||
      move.specialKind === 'baneful-bunker' ||
      move.specialKind === 'endure' ||
      move.specialKind === 'wide-guard' ||
      move.specialKind === 'quick-guard'
    ) {
      score += 200;
      continue;
    }
    if (move.category === 'Status') {
      if (move.specialKind === 'trick-room' && state.field.trickRoomTurns > 0) {
        score += 350;
      } else {
        score += 120;
      }
      continue;
    }
    // Offensive move targeting foe(s): prefer higher base power, priority, spread, and Mega
    const bpBonus = Math.min(100, (move.basePower || 60) * 0.5);
    const prioBonus = move.priority > 0 ? 15 : 0;
    const spreadBonus = move.target === 'allAdjacentFoes' ? 10 : 0;
    const megaBonus = act.mega ? 5 : 0;
    score -= bpBonus + prioBonus + spreadBonus + megaBonus;
  }
  return score;
}

/**
 * Resolve deterministic 1x1 forced-switch outcomes inline (e.g. a fainted slot
 * with a single surviving bench Pokemon) so BoundedSolver does not allocate
 * redundant 1x1 switch nodes or prematurely discard distributional HpDists.
 * Semantically exact: at any 1x1 switch node, V(s) = E[V(s' | s, a*, b*)].
 */
function resolveForcedSwitches(
  ctx: StaticBattleContext,
  outcomes: Array<{state: DynamicState; probability: number}>,
  remainingMass: number,
  complete: boolean,
  hpOutputMode: HpOutputMode,
  deadline?: number
): {
  outcomes: Array<{state: DynamicState; probability: number}>;
  remainingMass: number;
  complete: boolean;
  extraRuns: number;
} {
  let anySwitch = false;
  for (let i = 0; i < outcomes.length; i++) {
    if (outcomes[i].state.phase.kind === 'switch') {
      anySwitch = true;
      break;
    }
  }
  if (!anySwitch) {
    return {outcomes, remainingMass, complete, extraRuns: 0};
  }

  let cur = outcomes;
  let totalRemaining = remainingMass;
  let allComplete = complete;
  let extraRuns = 0;
  let didResolve = false;

  for (let iter = 0; iter < 8; iter++) {
    let resolvedAny = false;
    const next: Array<{state: DynamicState; probability: number}> = [];
    for (let i = 0; i < cur.length; i++) {
      const o = cur[i];
      if (o.state.phase.kind === 'switch') {
        const a0 = legalSideActions(ctx, o.state, 0);
        const a1 = legalSideActions(ctx, o.state, 1);
        if (a0.length === 1 && a1.length === 1) {
          const sw = stepBattle(ctx, o.state, a0[0], a1[0], {
            mode: 'certified',
            hpOutputMode,
            deadline,
          });
          extraRuns += sw.stats.forks + 1;
          if (!sw.complete) {
            allComplete = false;
            totalRemaining += o.probability * sw.remainingMass;
          }
          for (let j = 0; j < sw.outcomes.length; j++) {
            const so = sw.outcomes[j];
            next.push({state: so.state, probability: o.probability * so.probability});
          }
          resolvedAny = true;
          didResolve = true;
          continue;
        }
      }
      next.push(o);
    }
    cur = next;
    if (!resolvedAny) break;
  }

  if (!didResolve) {
    return {outcomes: cur, remainingMass: totalRemaining, complete: allComplete, extraRuns};
  }

  const merged = new Map<string, {state: DynamicState; probability: number}>();
  for (let i = 0; i < cur.length; i++) {
    const o = cur[i];
    if (o.probability <= 1e-15) continue;
    const key = canonicalStateKey(ctx, o.state);
    const prev = merged.get(key);
    if (prev) prev.probability += o.probability;
    else merged.set(key, {state: o.state, probability: o.probability});
  }
  if (totalRemaining > 1 && totalRemaining <= 1 + 1e-9) totalRemaining = 1;
  return {
    outcomes: [...merged.values()],
    remainingMass: totalRemaining,
    complete: allComplete && totalRemaining <= 1e-12,
    extraRuns,
  };
}

/**
 * Create a zero-serialization BoundedAdapter backed by the compact single-pass
 * branching engine. Returns null when the battle uses mechanics outside the
 * engine's verified whitelist (so callers can transparently fall back to @pkmn/sim).
 */
export function createEngineBoundedAdapter(
  initialBattle: Battle,
  options: EngineAdapterOptions = {}
): BoundedAdapter | null {
  if (!canRunInEngine(initialBattle).supported) return null;
  const ctx = compileContextFromBattle(initialBattle);
  const analyzer = createMonotoneAnalyzer(ctx);
  const explicitDiscrete = options.hpOutputMode === 'discrete';
  const useBoxes = !explicitDiscrete;
  const hpOutputMode: HpOutputMode = explicitDiscrete ? 'discrete' : 'distributional';
  const hasBench = ctx.sides[0].team.length > ctx.activeCount || ctx.sides[1].team.length > ctx.activeCount;

  const isDynamicState = (value: any): value is DynamicState =>
    !!value && typeof value === 'object' && 'field' in value && 'sides' in value && 'phase' in value;

  // Static audit for linear PP mechanics (safe across 1v1, full singles, and doubles):
  // Rejects Leppa Berry, Imposter/Transform, Spite, Instruct, Copycat, Sleep Talk,
  // Eerie Spell, Grudge, Trump Card, Lunar Dance. Accounts for opponent Pressure.
  let ppLinearSafe = true;
  let maxPressurePerSide = 0;
  for (let s = 0; s < 2 && ppLinearSafe; s++) {
    let sidePressure = 0;
    for (const mon of ctx.sides[s].team) {
      if (mon.itemSpec.archetype === 'leppa-berry') {
        ppLinearSafe = false;
        break;
      }
      let hasPressure = false;
      for (const ab of allStaticAbilities(mon)) {
        if (ab.imposter) {
          ppLinearSafe = false;
          break;
        }
        if (ab.pressure) hasPressure = true;
      }
      if (!ppLinearSafe) break;
      if (hasPressure) sidePressure++;
      for (const m of mon.moves) {
        if (
          m.specialKind === 'spite' ||
          m.specialKind === 'transform' ||
          m.specialKind === 'instruct' ||
          m.specialKind === 'copycat' ||
          m.specialKind === 'sleep-talk' ||
          m.id === 'eeriespell' ||
          m.id === 'grudge' ||
          m.id === 'trumpcard' ||
          m.id === 'lunardance'
        ) {
          ppLinearSafe = false;
          break;
        }
      }
    }
    if (sidePressure > maxPressurePerSide) maxPressurePerSide = sidePressure;
  }
  const maxPpLossPerTurn = 1 + Math.min(ctx.activeCount, maxPressurePerSide);

  // Exact PP-template transition cache for 1v1 singles:
  const canUsePpTemplateCache =
    ppLinearSafe &&
    ctx.activeCount === 1 &&
    ctx.sides[0].team.length === 1 &&
    ctx.sides[1].team.length === 1;

  const ppSignature = ppLinearSafe
    ? (state: DynamicState) => {
        if (state.phase.kind !== 'turn') return null;
        const pp: number[] = [];
        for (let s = 0; s < 2; s++) {
          const team = state.sides[s].pokemon;
          for (let i = 0; i < team.length; i++) {
            const p = team[i];
            if (p.fainted) continue;
            if (p.hpDist) return null;
            for (let m = 0; m < p.pp.length; m++) pp.push(p.pp[m]);
          }
        }
        return {
          groupKey: canonicalStateKey(ctx, state, undefined, true),
          pp,
          maxPpLossPerTurn,
        };
      }
    : undefined;

  interface PpTemplateOutcome {
    state: DynamicState;
    probability: number;
    dpp0: number[] | null;
    dpp1: number[] | null;
  }
  interface PpTemplateEntry {
    entries: PpTemplateOutcome[];
    remainingMass: number;
    complete: boolean;
  }
  const ppTemplateCache = canUsePpTemplateCache ? new Map<string, PpTemplateEntry>() : null;
  const PP_TEMPLATE_CACHE_LIMIT = 16384;
  const enableProgressive = options.progressive !== false;

  const instantiatePpState = (
    tpl: DynamicState,
    inPp0: number[],
    inPp1: number[],
    dpp0: number[] | null,
    dpp1: number[] | null
  ): DynamicState => {
    if (tpl.phase.kind === 'ended') return tpl;
    const s0 = tpl.sides[0];
    const s1 = tpl.sides[1];
    const p0 = s0.pokemon[0];
    const p1 = s1.pokemon[0];
    const nextP0 = dpp0 ? {...p0, pp: inPp0.map((v, i) => v + dpp0[i])} : p0;
    const nextP1 = dpp1 ? {...p1, pp: inPp1.map((v, i) => v + dpp1[i])} : p1;
    return {
      ...tpl,
      sides: [
        {...s0, pokemon: [nextP0]},
        {...s1, pokemon: [nextP1]},
      ],
    };
  };

  const instantiateCachedOutcomes = (
    state: DynamicState,
    cached: PpTemplateEntry
  ): Array<{state: DynamicState; probability: number}> => {
    const inPp0 = state.sides[0].pokemon[0].pp;
    const inPp1 = state.sides[1].pokemon[0].pp;
    return cached.entries.map(c => ({
      state: instantiatePpState(c.state, inPp0, inPp1, c.dpp0, c.dpp1),
      probability: c.probability,
    }));
  };

  const storePpTemplate = (
    tplKey: string,
    state: DynamicState,
    stepOutcomes: Array<{state: DynamicState; probability: number}>,
    remainingMass: number,
    complete: boolean
  ): void => {
    if (!ppTemplateCache) return;
    const existing = ppTemplateCache.get(tplKey);
    if (existing && existing.complete && !complete) return;
    if (ppTemplateCache.size >= PP_TEMPLATE_CACHE_LIMIT) {
      ppTemplateCache.clear();
    }
    const inPp0 = state.sides[0].pokemon[0].pp;
    const inPp1 = state.sides[1].pokemon[0].pp;
    const entries: PpTemplateOutcome[] = stepOutcomes.map(o => {
      if (o.state.phase.kind === 'ended') {
        return {state: o.state, probability: o.probability, dpp0: null, dpp1: null};
      }
      const outP0 = o.state.sides[0].pokemon[0];
      const outP1 = o.state.sides[1].pokemon[0];
      return {
        state: o.state,
        probability: o.probability,
        dpp0: outP0.fainted ? null : outP0.pp.map((v, i) => v - inPp0[i]),
        dpp1: outP1.fainted ? null : outP1.pp.map((v, i) => v - inPp1[i]),
      };
    });
    ppTemplateCache.set(tplKey, {entries, remainingMass, complete});
  };

  const formatStepOutcomes = (
    stepOutcomes: Array<{state: DynamicState; probability: number}>
  ): (Outcome | MonotoneBoxOutcome)[] => {
    if (!useBoxes) {
      const outcomes = stepOutcomes.map(o => {
        const utility = terminalUtilityFromState(o.state);
        if (utility !== null) {
          return {utility, probability: o.probability} as const;
        }
        return {snapshot: o.state as any, probability: o.probability} as const;
      }) as Outcome[];
      return bucketSmallTail(outcomes);
    }

    const outcomes: (Outcome | MonotoneBoxOutcome)[] = [];
    for (const o of stepOutcomes) {
      const utility = terminalUtilityFromState(o.state);
      if (utility !== null) {
        outcomes.push({utility, probability: o.probability});
        continue;
      }

      // Collect all Pokemon with multi-entry hpDist
      const distAxes: {side: 0 | 1; pokeIdx: number; dist: HpEntry[]}[] = [];
      let hasZeroOrNeg = false;
      let rawProduct = 1;
      for (let s = 0; s < 2; s++) {
        const sideIdx: 0 | 1 = s === 0 ? 0 : 1;
        const team = o.state.sides[sideIdx].pokemon;
        for (let idx = 0; idx < team.length; idx++) {
          const p = team[idx];
          if (p.hpDist && p.hpDist.length > 1) {
            distAxes.push({side: sideIdx, pokeIdx: idx, dist: p.hpDist});
            rawProduct *= p.hpDist.length;
            if (!hasZeroOrNeg) {
              for (let k = 0; k < p.hpDist.length; k++) {
                if (p.hpDist[k].hp <= 0) {
                  hasZeroOrNeg = true;
                  break;
                }
              }
            }
          }
        }
      }

      if (distAxes.length === 0) {
        outcomes.push({snapshot: o.state as any, probability: o.probability});
        continue;
      }

      if (o.state.phase.kind !== 'turn' || hasZeroOrNeg) {
        if (rawProduct <= 16) {
          for (const ws of expandStateHpDists(o)) {
            const u = terminalUtilityFromState(ws.state);
            if (u !== null) outcomes.push({utility: u, probability: ws.probability});
            else outcomes.push({snapshot: ws.state as any, probability: ws.probability});
          }
        } else {
          // Keep large switch-phase HpDist products lazy to avoid eager 16^k blowup.
          const lazyAxes: MultiHpAxis[] = distAxes.map(a => ({
            side: a.side,
            pokeIdx: a.pokeIdx,
            entries: a.dist,
            monotone: false,
          }));
          outcomes.push(makeMultiBoxOrSingleton(o.state, o.probability, lazyAxes));
        }
        continue;
      }

      // Partition each multi-entry axis into monotone and non-monotone chunks
      const axisChunks: {side: 0 | 1; pokeIdx: number; chunks: HpAxisChunk[]}[] = [];
      let nonMonoEagerProduct = 1;
      let totalChunkProduct = 1;
      for (let i = 0; i < distAxes.length; i++) {
        const a = distAxes[i];
        const chunks = analyzer.anyAxisAllowed
          ? partitionMonotoneAxis(o.state, a.side, a.pokeIdx, a.dist, analyzer.isPokeHpMonotone)
          : [{entries: a.dist, sum: 1, monotone: false}];
        axisChunks.push({side: a.side, pokeIdx: a.pokeIdx, chunks});
        totalChunkProduct *= chunks.length;
        let maxNonMono = 1;
        for (let c = 0; c < chunks.length; c++) {
          if (!chunks[c].monotone && chunks[c].entries.length > maxNonMono) {
            maxNonMono = chunks[c].entries.length;
          }
        }
        nonMonoEagerProduct *= maxNonMono;
      }

      // For small 1-axis non-monotone distributions (like 1v1 Sitrus Berry),
      // keep individual non-monotone HPs eager for immediate bounds; for large
      // multi-axis non-monotone products (e.g. 3v3 16x16+), keep them as lazy
      // unexpanded boxes (null corners -> [-1, 1]) that bisect on demand.
      const expandNonMonoEagerly = nonMonoEagerProduct <= 16 && totalChunkProduct * nonMonoEagerProduct <= 32;
      const finalChunks = expandNonMonoEagerly
        ? axisChunks.map(ac => ({
            side: ac.side,
            pokeIdx: ac.pokeIdx,
            chunks: ac.chunks.flatMap(ch =>
              ch.monotone || ch.entries.length <= 1
                ? [ch]
                : ch.entries.map(e => ({entries: [e], sum: e.prob, monotone: false}))
            ),
          }))
        : axisChunks;

      // Cartesian product over chunks across axes
      const emitCombos = (depth: number, prob: number, chosen: MultiHpAxis[]) => {
        if (prob <= 0) return;
        if (depth === finalChunks.length) {
          outcomes.push(makeMultiBoxOrSingleton(o.state, prob, chosen.slice()));
          return;
        }
        const ac = finalChunks[depth];
        for (let c = 0; c < ac.chunks.length; c++) {
          const ch = ac.chunks[c];
          chosen[depth] = {
            side: ac.side,
            pokeIdx: ac.pokeIdx,
            entries: ch.entries,
            monotone: ch.monotone,
          };
          emitCombos(depth + 1, prob * ch.sum, chosen);
        }
      };
      emitCombos(0, o.probability, new Array(finalChunks.length));
    }
    return bucketSmallTail(outcomes);
  };

  const adapter: BoundedAdapter = {
    snapshotBattle(battleOrState: Battle | DynamicState): DynamicState {
      return isDynamicState(battleOrState) ? battleOrState : stateFromBattle(ctx, battleOrState);
    },
    restoreBattle(state: DynamicState): DynamicState {
      // DynamicState is already compact and immutable across stepBattle calls.
      return state;
    },
    stateKey(state: DynamicState): string {
      return canonicalStateKey(ctx, state);
    },
    monotoneSignature: analyzer.monotoneSignature,
    ppSignature,
    terminalUtility(state: DynamicState): number | null {
      return terminalUtilityFromState(state);
    },
    legalActions(state: DynamicState, side: number): EngineActionEntry[] {
      const sideIdx: 0 | 1 = side === 0 ? 0 : 1;
      const raw = legalSideActions(ctx, state, sideIdx);
      if (ctx.activeCount > 1 && state.phase.kind === 'turn' && raw.length > 1) {
        const decorated = raw.map((sa, idx) => ({
          sa,
          idx,
          score: doublesActionOrderScore(ctx, state, sideIdx, sa),
        }));
        decorated.sort((a, b) => a.score - b.score || a.idx - b.idx);
        return decorated.map(d => formatSideAction(ctx, state, sideIdx, d.sa));
      }
      return raw.map(sa => formatSideAction(ctx, state, sideIdx, sa));
    },
    enumerateTurn(
      state: DynamicState,
      p1Action: EngineActionEntry,
      p2Action: EngineActionEntry,
      turnOptions: {deadline?: number} = {}
    ) {
      let stepOutcomes: Array<{state: DynamicState; probability: number}>;
      let simulatorRuns = 1;
      let cacheHits = 0;
      const useCache = ppTemplateCache !== null && state.phase.kind === 'turn';
      const tplKey = useCache
        ? `${canonicalStateKey(ctx, state, undefined, true)}|${p1Action.id}|${p2Action.id}`
        : '';
      const cached = useCache ? ppTemplateCache.get(tplKey) : undefined;
      if (cached && cached.complete) {
        stepOutcomes = instantiateCachedOutcomes(state, cached);
        cacheHits = 1;
      } else {
        const res = stepBattle(ctx, state, p1Action.sideAction, p2Action.sideAction, {
          mode: 'certified',
          hpOutputMode,
          deadline: turnOptions?.deadline,
        });
        if (!res.complete) {
          return {
            outcomes: [],
            simulatorRuns: res.stats.forks + 1,
            complete: false,
          };
        }
        simulatorRuns = res.stats.forks + 1;
        if (hasBench) {
          const resolved = resolveForcedSwitches(
            ctx,
            res.outcomes,
            0,
            true,
            hpOutputMode,
            turnOptions?.deadline
          );
          simulatorRuns += resolved.extraRuns;
          if (!resolved.complete) {
            return {
              outcomes: [],
              simulatorRuns,
              complete: false,
            };
          }
          stepOutcomes = resolved.outcomes;
        } else {
          stepOutcomes = res.outcomes;
        }
        if (useCache) storePpTemplate(tplKey, state, stepOutcomes, 0, true);
      }

      return {
        outcomes: formatStepOutcomes(stepOutcomes),
        simulatorRuns,
        cacheHits,
        complete: true,
      };
    },
  };

  if (enableProgressive) {
    adapter.createTurnCursor = (
      state: DynamicState,
      p1Action: EngineActionEntry,
      p2Action: EngineActionEntry,
      turnOptions: {deadline?: number; tolerance?: number} = {}
    ) => {
      const tol = turnOptions?.tolerance ?? 0.02;
      const maxDeferredMass = tol > 0 ? Math.min(0.002, tol * 0.1) : 0;
      const deferMinProb = maxDeferredMass > 0 ? Math.min(0.0008, maxDeferredMass * 0.4) : 0;
      const useCache = ppTemplateCache !== null && state.phase.kind === 'turn';
      const tplKey = useCache
        ? `${canonicalStateKey(ctx, state, undefined, true)}|${p1Action.id}|${p2Action.id}`
        : '';
      let stage: 0 | 1 | 2 = 0;
      let lastOutcomes: (Outcome | MonotoneBoxOutcome)[] = [];
      let lastRemaining = 1;

      return {
        advance(stepOpts: {maxRuns?: number; deadline?: number} = {}) {
          const deadline = stepOpts.deadline ?? turnOptions?.deadline;
          if (stage === 2) {
            return {
              outcomes: lastOutcomes,
              remainingProbability: 0,
              simulatorRuns: 0,
              complete: true,
            };
          }

          const cached = useCache ? ppTemplateCache.get(tplKey) : undefined;
          if (cached && cached.complete) {
            lastOutcomes = formatStepOutcomes(instantiateCachedOutcomes(state, cached));
            lastRemaining = 0;
            stage = 2;
            return {
              outcomes: lastOutcomes,
              remainingProbability: 0,
              simulatorRuns: 0,
              cacheHits: 1,
              complete: true,
            };
          }

          if (stage === 0 && maxDeferredMass > 0) {
            if (cached) {
              lastOutcomes = formatStepOutcomes(instantiateCachedOutcomes(state, cached));
              lastRemaining = cached.remainingMass;
              stage = 1;
              return {
                outcomes: lastOutcomes,
                remainingProbability: lastRemaining,
                simulatorRuns: 0,
                cacheHits: 1,
                complete: false,
              };
            }
            const res = stepBattle(ctx, state, p1Action.sideAction, p2Action.sideAction, {
              mode: 'certified',
              hpOutputMode,
              deadline,
              deferMinProb,
              maxDeferredMass,
            });
            let outList = res.outcomes;
            let remMass = res.remainingMass;
            let isComplete = res.complete;
            let simRuns = res.stats.forks + 1;
            if (hasBench) {
              const resolved = resolveForcedSwitches(ctx, outList, remMass, isComplete, hpOutputMode, deadline);
              outList = resolved.outcomes;
              remMass = resolved.remainingMass;
              isComplete = resolved.complete;
              simRuns += resolved.extraRuns;
            }
            const deadlineHit = deadline !== undefined && performance.now() >= deadline && remMass > maxDeferredMass + 1e-6;
            if (!deadlineHit && useCache) {
              storePpTemplate(tplKey, state, outList, remMass, isComplete);
            }
            lastOutcomes = formatStepOutcomes(outList);
            lastRemaining = isComplete ? 0 : Math.min(1, Math.max(0, remMass));
            stage = isComplete ? 2 : 1;
            return {
              outcomes: lastOutcomes,
              remainingProbability: lastRemaining,
              simulatorRuns: simRuns,
              complete: isComplete,
            };
          }

          // Stage 1 (or tolerance === 0): run full exact stepBattle.
          const res = stepBattle(ctx, state, p1Action.sideAction, p2Action.sideAction, {
            mode: 'certified',
            hpOutputMode,
            deadline,
          });
          let outList = res.outcomes;
          let remMass = res.remainingMass;
          let isComplete = res.complete;
          let simRuns = res.stats.forks + 1;
          if (hasBench) {
            const resolved = resolveForcedSwitches(ctx, outList, remMass, isComplete, hpOutputMode, deadline);
            outList = resolved.outcomes;
            remMass = resolved.remainingMass;
            isComplete = resolved.complete;
            simRuns += resolved.extraRuns;
          }
          if (isComplete) {
            if (useCache) storePpTemplate(tplKey, state, outList, 0, true);
            lastOutcomes = formatStepOutcomes(outList);
            lastRemaining = 0;
            stage = 2;
            return {
              outcomes: lastOutcomes,
              remainingProbability: 0,
              simulatorRuns: simRuns,
              complete: true,
            };
          }
          // Deadline hit during exact refinement: keep sound partial distribution.
          if (outList.length > 0) {
            lastOutcomes = formatStepOutcomes(outList);
            lastRemaining = Math.min(1, Math.max(0, remMass));
          }
          return {
            outcomes: lastOutcomes,
            remainingProbability: lastRemaining,
            simulatorRuns: simRuns,
            complete: false,
          };
        },
      };
    };
  }

  return adapter;
}

function makeLazyTailBucket(
  tail: (Outcome | MonotoneBoxOutcome)[],
  probability: number
): MonotoneBoxOutcome {
  return {
    probability,
    lowerSnapshot: null,
    upperSnapshot: null,
    split() {
      if (tail.length <= 4) return tail;
      const head = tail.slice(0, 4);
      const rest = tail.slice(4);
      let restProb = 0;
      for (let i = 0; i < rest.length; i++) restProb += rest[i].probability;
      return [...head, makeLazyTailBucket(rest, restProb)];
    },
  };
}

function bucketSmallTail(
  outcomes: (Outcome | MonotoneBoxOutcome)[]
): (Outcome | MonotoneBoxOutcome)[] {
  if (outcomes.length <= 8) return outcomes;
  const kept: (Outcome | MonotoneBoxOutcome)[] = [];
  const nonTerm: (Outcome | MonotoneBoxOutcome)[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if ('utility' in o && o.utility !== null && o.utility !== undefined) {
      kept.push(o);
    } else {
      nonTerm.push(o);
    }
  }
  if (nonTerm.length <= 8) return outcomes;
  nonTerm.sort((a, b) => b.probability - a.probability);
  let splitAt = nonTerm.length;
  for (let i = 4; i < nonTerm.length; i++) {
    if (nonTerm[i].probability < 0.005) {
      splitAt = i;
      break;
    }
  }
  if (nonTerm.length - splitAt < 4) return outcomes;
  for (let i = 0; i < splitAt; i++) kept.push(nonTerm[i]);
  const tail = nonTerm.slice(splitAt);
  let tailProb = 0;
  for (let i = 0; i < tail.length; i++) tailProb += tail[i].probability;
  kept.push(makeLazyTailBucket(tail, tailProb));
  return kept;
}
