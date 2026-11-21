import type {Battle} from '@pkmn/sim';
import type {
  BoundedAdapter,
  JointMonoPpSignature,
  MonotoneBoxOutcome,
  MonotoneSignature,
  ProtectContractionInfo,
} from '../bounded-solver';
import type {Action, Outcome} from '../types';
import {canRunInEngine, compileContextFromBattle} from './context';
import {
  applyBoostToStat,
  effectiveFieldWeather,
  effectiveSpeed,
  resolveMoveType,
  typeEffectiveness,
} from './damage';
import {
  activeAbilitySpec,
  activeItemSpec,
  activeMoves,
  activeStats,
  activeTypes,
  canonicalStateKey,
  cloneState,
  expandStateHpDists,
  hpMin,
  isGrounded,
  isItemEffectActive,
  legalSideActions,
  stateFromBattle,
  terminalUtilityFromState,
} from './state';
import {stepBattle} from './turn';
import type {CompiledAbilitySpec} from './effects/abilities';
import {
  ACTION_OBS_CATEGORY,
  ACTION_OBS_EXACT,
  ACTION_OBS_EXECUTED,
  ACTION_OBS_OPP_TARGET_MATTERED,
  ACTION_OBS_SLEEP_ONLY,
  type ActionObservation,
  type DynamicState,
  type HpEntry,
  type HpOutputMode,
  type SideAction,
  type SlotAction,
  type StaticBattleContext,
  type StaticPokemonData,
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
export type AxisMonoMode = 'unconditional' | 'no-drain-opp' | 'survive-self' | 'opaque';

export interface MonotoneAnalyzer {
  anyAxisAllowed: boolean;
  isHpMonotone: (state: DynamicState, s: 0 | 1, hp: number) => boolean;
  isPokeHpMonotone: (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number) => boolean;
  classifyPokeHp: (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number) => AxisMonoMode;
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
    classifyPokeHp: () => 'opaque',
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
      classifyPokeHp: (state, s, pokeIdx, hp) => (pokeIdx === 0 && isHpMonotone(state, s, hp) ? 'unconditional' : 'opaque'),
      monotoneSignature,
    };
  }

  // General multi-Pokemon (singles with bench & doubles) static traits per Pokemon
  interface MonStaticMonoInfo {
    unsafeSelfAbility: boolean;
    unsafeSelfMove: boolean;
    hasFairyAura: boolean;
    damagesAttackerOnHit: boolean;
    hasSelfRecoilItem: boolean;
    hasDrain: boolean;
    hasRecoilMove: boolean;
    hasAbilityKoBonus: boolean;
    hasMoveKoBonus: boolean;
    hasUnsafeTarget: boolean;
    breaksFoeHpMono: boolean;
    hasAllAdjacentDamage: boolean;
    canHealSelf: boolean;
    canHealOther: boolean;
    setsGrassy: boolean;
    hasStaticThresholdAbility: boolean;
  }

  let battleHasChoiceUnlocker = false;
  let battleHasPpRestorer = false;
  const info: [MonStaticMonoInfo[], MonStaticMonoInfo[]] = [[], []];
  for (let s = 0; s < 2; s++) {
    for (const mon of ctx.sides[s].team) {
      let unsafeSelfAbility = false;
      let unsafeSelfMove = false;
      let hasFairyAura = false;
      let damagesAttackerOnHit = mon.itemSpec.optTraits.damagesAttackerOnHit;
      const hasSelfRecoilItem = mon.itemSpec.optTraits.selfRecoilOnAttack;
      let hasDrain = false;
      let hasRecoilMove = false;
      let hasAbilityKoBonus = false;
      let hasMoveKoBonus = false;
      let hasUnsafeTarget = false;
      const breaksFoeHpMono = mon.itemSpec.optTraits.breaksFoeHpMonotonicity;
      let hasAllAdjacentDamage = false;
      let canHealSelf = mon.itemSpec.optTraits.canHealWithoutBerry;
      let canHealOther = false;
      let setsGrassy = false;
      let hasStaticThresholdAbility = false;

      if (mon.itemSpec.archetype === 'leppa-berry') battleHasPpRestorer = true;
      for (const m of mon.moves) {
        if (m.optTraits.hpMonotone === 'unsafe-self') unsafeSelfMove = true;
        if (m.optTraits.hpMonotone === 'unsafe-target') hasUnsafeTarget = true;
        if (m.optTraits.hasDrain) hasDrain = true;
        if (m.recoil !== null) hasRecoilMove = true;
        if (m.target === 'allAdjacent' && m.category !== 'Status') hasAllAdjacentDamage = true;
        if (m.specialKind === 'last-respects' || m.specialKind === 'fell-stinger') hasMoveKoBonus = true;
        if (m.optTraits.canHealSelf) canHealSelf = true;
        if (m.optTraits.canHealFoe || m.specialKind === 'heal-pulse' || m.specialKind === 'pollen-puff') {
          canHealOther = true;
        }
        if (m.setsTerrain === 'grassy') setsGrassy = true;
        if (
          m.knockOff ||
          m.specialKind === 'steal-item' ||
          m.specialKind === 'trick' ||
          m.specialKind === 'magic-room' ||
          m.specialKind === 'corrosive-gas' ||
          m.specialKind === 'fling' ||
          m.specialKind === 'transform' ||
          m.specialKind === 'revival-blessing' ||
          m.specialKind === 'sleep-talk' ||
          m.specialKind === 'copycat' ||
          m.specialKind === 'instruct'
        ) {
          battleHasChoiceUnlocker = true;
        }
        if (
          m.id === 'lunardance' ||
          m.specialKind === 'revival-blessing' ||
          m.specialKind === 'transform' ||
          m.specialKind === 'sleep-talk' ||
          m.specialKind === 'copycat'
        ) {
          battleHasPpRestorer = true;
        }
      }
      for (const ab of allStaticAbilities(mon)) {
        if (ab.optTraits.hpThreshold === 'unsafe-self') unsafeSelfAbility = true;
        if (ab.optTraits.hpThreshold !== 'none') hasStaticThresholdAbility = true;
        if (ab.fairyAura) hasFairyAura = true;
        if (ab.optTraits.damagesAttackerOnHit) damagesAttackerOnHit = true;
        if (ab.supremeOverlord || ab.moxie || ab.battleBond) hasAbilityKoBonus = true;
        if (ab.optTraits.canHealSelf) canHealSelf = true;
        if (ab.optTraits.canHealFoe) canHealOther = true;
        if (ab.setsTerrain === 'grassy' || ab.seedSower) setsGrassy = true;
        if (ab.magician || ab.pickpocket || ab.symbiosis || ab.imposter || ab.klutz) {
          battleHasChoiceUnlocker = true;
        }
        if (ab.imposter) battleHasPpRestorer = true;
      }

      info[s].push({
        unsafeSelfAbility,
        unsafeSelfMove,
        hasFairyAura,
        damagesAttackerOnHit,
        hasSelfRecoilItem,
        hasDrain,
        hasRecoilMove,
        hasAbilityKoBonus,
        hasMoveKoBonus,
        hasUnsafeTarget,
        breaksFoeHpMono,
        hasAllAdjacentDamage,
        canHealSelf,
        canHealOther,
        setsGrassy,
        hasStaticThresholdAbility,
      });
    }
  }

  // Inspect only permanently available moves for a live Pokemon when Choice-locked
  // with zero bench (and no item-unlocking mechanics) or when a move is at 0 PP.
  const monAvailableMoveFlags = (
    state: DynamicState,
    sideIdx: 0 | 1,
    pokeIdx: number,
    sideAliveBench: number
  ): {
    unsafeSelfMove: boolean;
    hasUnsafeTarget: boolean;
    hasDrain: boolean;
    hasRecoilMove: boolean;
    hasAllAdjacentDamage: boolean;
    hasMoveKoBonus: boolean;
  } => {
    const base = info[sideIdx][pokeIdx];
    const p = state.sides[sideIdx].pokemon[pokeIdx];
    const sp = ctx.sides[sideIdx].team[pokeIdx];
    const permanentChoiceLock =
      !battleHasChoiceUnlocker &&
      state.field.magicRoomTurns === 0 &&
      sideAliveBench === 0 &&
      !p.transformed &&
      p.choiceLockedMoveIdx >= 0 &&
      p.choiceLockedMoveIdx < sp.moves.length &&
      isItemEffectActive(state, sp, p);
    let anyZeroPp = false;
    if (!permanentChoiceLock && !battleHasPpRestorer && !p.transformed) {
      for (let mi = 0; mi < sp.moves.length; mi++) {
        if (p.pp[mi] <= 0) {
          anyZeroPp = true;
          break;
        }
      }
    }
    if (!permanentChoiceLock && !anyZeroPp) {
      return {
        unsafeSelfMove: base.unsafeSelfMove,
        hasUnsafeTarget: base.hasUnsafeTarget,
        hasDrain: base.hasDrain,
        hasRecoilMove: base.hasRecoilMove,
        hasAllAdjacentDamage: base.hasAllAdjacentDamage,
        hasMoveKoBonus: base.hasMoveKoBonus,
      };
    }
    let unsafeSelfMove = false;
    let hasUnsafeTarget = false;
    let hasDrain = false;
    let hasRecoilMove = false;
    let hasAllAdjacentDamage = false;
    let hasMoveKoBonus = false;
    const startMi = permanentChoiceLock ? p.choiceLockedMoveIdx : 0;
    const endMi = permanentChoiceLock ? p.choiceLockedMoveIdx + 1 : sp.moves.length;
    for (let mi = startMi; mi < endMi; mi++) {
      if (!battleHasPpRestorer && p.pp[mi] <= 0) continue;
      const m = sp.moves[mi];
      if (m.optTraits.hpMonotone === 'unsafe-self') unsafeSelfMove = true;
      if (m.optTraits.hpMonotone === 'unsafe-target') hasUnsafeTarget = true;
      if (m.optTraits.hasDrain) hasDrain = true;
      if (m.recoil !== null) hasRecoilMove = true;
      if (m.target === 'allAdjacent' && m.category !== 'Status') hasAllAdjacentDamage = true;
      if (m.specialKind === 'last-respects' || m.specialKind === 'fell-stinger') hasMoveKoBonus = true;
    }
    return {unsafeSelfMove, hasUnsafeTarget, hasDrain, hasRecoilMove, hasAllAdjacentDamage, hasMoveKoBonus};
  };

  const canMonHealNow = (state: DynamicState, s: 0 | 1, pokeIdx: number): boolean => {
    const side = state.sides[s];
    const p = side.pokemon[pokeIdx];
    const opp: 0 | 1 = s === 0 ? 1 : 0;
    const oppSide = state.sides[opp];
    if (info[s][pokeIdx].canHealSelf || state.field.terrain === 'grassy' || p.aquaRing || p.ingrain) return true;
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

  const monAbilityStillHasThreshold = (
    mon: StaticPokemonData,
    ab: CompiledAbilitySpec,
    hp: number,
    aliveBench: number,
    canHeal: () => boolean
  ): boolean => {
    switch (ab.optTraits.hpThreshold) {
      case 'none':
        return false;
      case 'half-maxhp-pivot':
        return aliveBench > 0;
      case 'pinch-third':
        return !!ab.pinchType && sideHasMoveOfTypeOrDynamic(mon, ab.pinchType, ab) &&
          !(hp <= Math.floor(mon.maxhp / 3) && !canHeal());
      case 'half-maxhp':
        return !(hp <= Math.floor(mon.maxhp / 2) && !canHeal());
      case 'below-maxhp':
        return !(hp < mon.maxhp && !canHeal());
      case 'unsafe-self':
        return true;
    }
  };

  const classifyPokeHp = (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number): AxisMonoMode => {
    if (state.phase.kind !== 'turn') return 'opaque';
    const side = state.sides[s];
    const p = side.pokemon[pokeIdx];
    if (!p || p.fainted || hp <= 0 || p.transformed) return 'opaque';

    const {alive: myAlive, aliveBench} = countAliveAndBench(state, s);
    const myInfo = info[s][pokeIdx];
    if (myInfo.unsafeSelfAbility) return 'opaque';
    if (myInfo.unsafeSelfMove && monAvailableMoveFlags(state, s, pokeIdx, aliveBench).unsafeSelfMove) return 'opaque';

    const mon = ctx.sides[s].team[pokeIdx];
    const itemSpec = p.itemActive ? activeItemSpec(ctx, mon, p) : null;
    if (itemSpec?.optTraits.hpThresholdBerry || p.cudchewBerry !== '') return 'opaque';

    let canHealCached: boolean | null = null;
    const canHeal = () => {
      if (canHealCached === null) canHealCached = canMonHealNow(state, s, pokeIdx);
      return canHealCached;
    };

    if (p.abilityActive && !p.gastroAcid) {
      if (monAbilityStillHasThreshold(mon, activeAbilitySpec(mon, p), hp, aliveBench, canHeal)) return 'opaque';
    }
    if (!side.megaUsed && mon.megaForme) {
      if (monAbilityStillHasThreshold(mon, mon.megaForme.abilitySpec, hp, aliveBench, canHeal)) return 'opaque';
    }

    // Fail-closed for unconditional monotonicity when aliveBench > 0 or when
    // ally/foe KO-dependent mechanics exist; survive-self remains sound whenever
    // the witness never faints this Pokemon.
    let unconditionalBlockedByNonDrain = aliveBench > 0 || (myAlive > 1 && myInfo.hasFairyAura);

    // Check alive teammates on side `s`
    if (myAlive > 1) {
      for (let j = 0; j < side.pokemon.length; j++) {
        if (j === pokeIdx || side.pokemon[j].fainted) continue;
        const allyStatic = info[s][j];
        if (allyStatic.hasAbilityKoBonus) unconditionalBlockedByNonDrain = true;
        if (allyStatic.hasAllAdjacentDamage || allyStatic.hasMoveKoBonus || allyStatic.hasUnsafeTarget) {
          const af = monAvailableMoveFlags(state, s, j, aliveBench);
          if (af.hasUnsafeTarget) return 'opaque';
          if (af.hasAllAdjacentDamage || af.hasMoveKoBonus) {
            unconditionalBlockedByNonDrain = true;
          }
        }
      }
    }

    // Check alive opposing Pokemon
    let blockedByFoeDrain = false;
    const opp: 0 | 1 = s === 0 ? 1 : 0;
    const oppSide = state.sides[opp];
    const {aliveBench: oppAliveBench} = countAliveAndBench(state, opp);
    for (let j = 0; j < oppSide.pokemon.length; j++) {
      const fp = oppSide.pokemon[j];
      if (fp.fainted) continue;
      const foeStatic = info[opp][j];
      if (foeStatic.breaksFoeHpMono) return 'opaque';
      const needMoveCheck =
        foeStatic.hasUnsafeTarget ||
        (foeStatic.hasDrain && (myAlive > 1 || myInfo.damagesAttackerOnHit || foeStatic.hasSelfRecoilItem)) ||
        (myAlive > 1 && foeStatic.hasRecoilMove);
      if (!needMoveCheck) continue;
      const ff = monAvailableMoveFlags(state, opp, j, oppAliveBench);
      if (ff.hasUnsafeTarget) return 'opaque';
      if (ff.hasDrain && (myAlive > 1 || myInfo.damagesAttackerOnHit || foeStatic.hasSelfRecoilItem)) {
        blockedByFoeDrain = true;
      }
      if (myAlive > 1 && ff.hasRecoilMove) {
        // Check dynamically whether foe can still trigger an HP-threshold effect from recoil.
        const foeMon = ctx.sides[opp].team[j];
        const foeItem = fp.itemActive ? activeItemSpec(ctx, foeMon, fp) : null;
        if (foeItem?.optTraits.hpThresholdBerry || fp.cudchewBerry !== '' || ff.unsafeSelfMove || foeStatic.unsafeSelfAbility) {
          unconditionalBlockedByNonDrain = true;
        } else if (foeStatic.hasStaticThresholdAbility) {
          let foeHealCached: boolean | null = null;
          const foeCanHeal = () => {
            if (foeHealCached === null) foeHealCached = canMonHealNow(state, opp, j);
            return foeHealCached;
          };
          const fHp = fp.hpDist ? fp.hpDist[fp.hpDist.length - 1].hp : fp.hp;
          if (fp.abilityActive && !fp.gastroAcid &&
              monAbilityStillHasThreshold(foeMon, activeAbilitySpec(foeMon, fp), fHp, oppAliveBench, foeCanHeal)) {
            unconditionalBlockedByNonDrain = true;
          } else if (!oppSide.megaUsed && foeMon.megaForme &&
              monAbilityStillHasThreshold(foeMon, foeMon.megaForme.abilitySpec, fHp, oppAliveBench, foeCanHeal)) {
            unconditionalBlockedByNonDrain = true;
          }
        }
      }
    }

    if (!unconditionalBlockedByNonDrain && !blockedByFoeDrain) return 'unconditional';
    if (!unconditionalBlockedByNonDrain && blockedByFoeDrain) return 'no-drain-opp';
    return 'survive-self';
  };

  const isPokeHpMonotone = (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number): boolean =>
    classifyPokeHp(state, s, pokeIdx, hp) === 'unconditional';

  // General multi-Pokemon N-D monotone signature across all alive monotone Pokemon
  // (reuses 1D/2D fast paths when <=1 monotone mon per side, and N-D signed vector otherwise).
  const monotoneSignature = (state: DynamicState): MonotoneSignature | null => {
    if (state.phase.kind !== 'turn') return null;
    let maskHpBits = 0;
    const vec: number[] = [];
    let s0Count = 0;
    let s1Count = 0;
    let s0Hp = 0;
    let s1Hp = 0;

    for (let s = 0; s < 2; s++) {
      const sideIdx: 0 | 1 = s === 0 ? 0 : 1;
      const team = state.sides[sideIdx].pokemon;
      for (let i = 0; i < team.length; i++) {
        const p = team[i];
        if (p.fainted) continue;
        if (p.hpDist) return null;
        if (isPokeHpMonotone(state, sideIdx, i, p.hp)) {
          maskHpBits |= 1 << (sideIdx * 6 + i);
          vec.push(sideIdx === 0 ? p.hp : -p.hp);
          if (sideIdx === 0) {
            s0Count++;
            s0Hp = p.hp;
          } else {
            s1Count++;
            s1Hp = p.hp;
          }
        }
      }
    }

    if (vec.length === 0) return null;
    const groupKey = canonicalStateKey(ctx, state, undefined, false, undefined, maskHpBits);
    if (s0Count <= 1 && s1Count <= 1) {
      return {
        groupKey,
        h1: s0Count === 1 ? s0Hp : null,
        h2: s1Count === 1 ? s1Hp : null,
      };
    }
    return {
      groupKey,
      h1: null,
      h2: null,
      vec,
    };
  };

  return {
    anyAxisAllowed: true,
    isHpMonotone: (state, s, hp) => isPokeHpMonotone(state, s, state.sides[s].active[0], hp),
    isPokeHpMonotone,
    classifyPokeHp,
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
  mode: AxisMonoMode;
  noLowerCond?: boolean;
  noUpperCond?: boolean;
}

interface HpAxisChunk {
  entries: HpEntry[];
  sum: number;
  mode: AxisMonoMode;
}

function computeFaintMask(_ctx: StaticBattleContext, parentState: DynamicState, childState: DynamicState): number {
  let mask = 0;
  for (let s = 0; s < 2; s++) {
    const pTeam = parentState.sides[s].pokemon;
    const cTeam = childState.sides[s].pokemon;
    const base = s * 6;
    for (let i = 0; i < pTeam.length; i++) {
      if (!pTeam[i].fainted && cTeam[i].fainted) {
        mask |= 1 << (base + i);
      }
    }
  }
  return mask;
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
  classifyPokeHp: (state: DynamicState, s: 0 | 1, pokeIdx: number, hp: number) => AxisMonoMode
): HpAxisChunk[] {
  const chunks: HpAxisChunk[] = [];
  let curEntries: HpEntry[] | null = null;
  let curSum = 0;
  let curMode: AxisMonoMode = 'opaque';
  let prevHp = -1;
  const flush = () => {
    if (curEntries && curEntries.length > 0) {
      chunks.push({entries: curEntries, sum: curSum, mode: curMode});
      curEntries = null;
      curSum = 0;
    }
  };
  for (const e of dist) {
    const mode = classifyPokeHp(state, side, pokeIdx, e.hp);
    // Split disjoint HP clusters (e.g. a 1/24 crit cluster sitting far below
    // the 23/24 non-crit range) on cornered modes so rare tails never widen the main box.
    if (curEntries && (mode !== curMode || (mode !== 'opaque' && prevHp >= 0 && e.hp - prevHp > 6))) {
      flush();
    }
    if (!curEntries) {
      curEntries = [];
      curMode = mode;
    }
    curEntries.push(e);
    curSum += e.prob;
    prevHp = e.hp;
  }
  flush();
  return chunks;
}

function makeMultiBoxOrSingleton(
  ctx: StaticBattleContext,
  parentState: DynamicState,
  baseState: DynamicState,
  probability: number,
  axes: MultiHpAxis[]
): Outcome | MonotoneBoxOutcome {
  let anyVarying = false;
  let canLower = true;
  let canUpper = true;
  let lowerReqNoFaintMask = 0;
  let lowerReqNoDrain = false;
  let upperReqNoFaintMask = 0;
  let upperReqNoDrain = false;

  for (let i = 0; i < axes.length; i++) {
    const a = axes[i];
    if (a.entries.length <= 1) continue;
    anyVarying = true;
    if (a.mode === 'unconditional') continue;
    if (a.mode === 'no-drain-opp') {
      if (a.noLowerCond) {
        canLower = false;
      } else if (a.side === 1) {
        lowerReqNoDrain = true;
      } else {
        lowerReqNoFaintMask |= 1 << a.pokeIdx;
      }
      if (a.noUpperCond) {
        canUpper = false;
      } else if (a.side === 1) {
        upperReqNoFaintMask |= 1 << (6 + a.pokeIdx);
      } else {
        upperReqNoDrain = true;
      }
      continue;
    }
    if (a.mode === 'survive-self') {
      if (a.side === 0) {
        if (a.noLowerCond) canLower = false;
        else lowerReqNoFaintMask |= 1 << a.pokeIdx;
        canUpper = false;
      } else {
        canLower = false;
        if (a.noUpperCond) canUpper = false;
        else upperReqNoFaintMask |= 1 << (6 + a.pokeIdx);
      }
      continue;
    }
    canLower = false;
    canUpper = false;
  }

  if (!anyVarying) {
    const snap = materializeHpVector(baseState, axes, null);
    const faintMask = computeFaintMask(ctx, parentState, snap);
    const utility = terminalUtilityFromState(snap);
    if (utility !== null) {
      return faintMask ? {utility, probability, faintMask} : {utility, probability};
    }
    return faintMask ? {snapshot: snap as any, probability, faintMask} : {snapshot: snap as any, probability};
  }

  const lowerSnapshot = canLower ? (materializeHpVector(baseState, axes, false) as any) : null;
  const upperSnapshot = canUpper ? (materializeHpVector(baseState, axes, true) as any) : null;
  const faintMask = computeFaintMask(ctx, parentState, baseState);

  return {
    probability,
    lowerSnapshot,
    upperSnapshot,
    ...(faintMask ? {faintMask} : {}),
    ...(canLower && lowerReqNoFaintMask ? {lowerReqNoFaintMask} : {}),
    ...(canLower && lowerReqNoDrain ? {lowerReqNoDrain: true} : {}),
    ...(canUpper && upperReqNoFaintMask ? {upperReqNoFaintMask} : {}),
    ...(canUpper && upperReqNoDrain ? {upperReqNoDrain: true} : {}),
    split: (violatedSide?: 'lower' | 'upper' | 'both') => {
      let splitAxisIdx = -1;
      const vLo = violatedSide === 'lower' || violatedSide === 'both';
      const vHi = violatedSide === 'upper' || violatedSide === 'both';
      if (!canLower || !canUpper || vLo || vHi) {
        // Peel axes blocking missing corners or whose conditional witness was violated.
        const blockingIdxs: number[] = [];
        for (let i = 0; i < axes.length; i++) {
          const a = axes[i];
          if (a.entries.length <= 1) continue;
          const isLowerCond = a.mode === 'no-drain-opp' || (a.mode === 'survive-self' && a.side === 0);
          const isUpperCond = a.mode === 'no-drain-opp' || (a.mode === 'survive-self' && a.side === 1);
          const blocksLower = (!canLower && (a.mode === 'opaque' || a.noLowerCond || (a.mode === 'survive-self' && a.side === 1))) ||
            (vLo && isLowerCond);
          const blocksUpper = (!canUpper && (a.mode === 'opaque' || a.noUpperCond || (a.mode === 'survive-self' && a.side === 0))) ||
            (vHi && isUpperCond);
          if (blocksLower || blocksUpper) blockingIdxs.push(i);
        }
        const downgradeAxis = (a: MultiHpAxis, entries: HpEntry[]): MultiHpAxis => ({
          ...a,
          entries,
          ...(vLo && (a.mode === 'no-drain-opp' || (a.mode === 'survive-self' && a.side === 0)) ? {noLowerCond: true} : {}),
          ...(vHi && (a.mode === 'no-drain-opp' || (a.mode === 'survive-self' && a.side === 1)) ? {noUpperCond: true} : {}),
        });
        if (blockingIdxs.length >= 2) {
          const out: (Outcome | MonotoneBoxOutcome)[] = [];
          let curAxes = axes;
          let curProb = probability;
          for (let k = 0; k < blockingIdxs.length; k++) {
            const axIdx = blockingIdxs[k];
            const target = curAxes[axIdx];
            const len = target.entries.length;
            let total = 0;
            for (let i = 0; i < len; i++) total += target.entries[i].prob;
            const medIdx = len >>> 1;
            const medEntry = target.entries[medIdx];
            const remEntries: HpEntry[] = [];
            let remSum = 0;
            for (let i = 0; i < len; i++) {
              if (i !== medIdx) {
                remEntries.push(target.entries[i]);
                remSum += target.entries[i].prob;
              }
            }
            if (remEntries.length > 0 && remSum > 0) {
              const remAxes = curAxes.slice();
              remAxes[axIdx] = downgradeAxis(target, remEntries);
              out.push(makeMultiBoxOrSingleton(ctx, parentState, baseState, curProb * (remSum / total), remAxes));
            }
            const nextAxes = curAxes.slice();
            nextAxes[axIdx] = {...target, entries: [medEntry]};
            curAxes = nextAxes;
            curProb *= medEntry.prob / total;
          }
          if (curProb > 0) {
            out.push(makeMultiBoxOrSingleton(ctx, parentState, baseState, curProb, curAxes));
          }
          return out;
        }
        if (blockingIdxs.length === 1) {
          splitAxisIdx = blockingIdxs[0];
          const target = axes[splitAxisIdx];
          const len = target.entries.length;
          let total = 0;
          for (let i = 0; i < len; i++) total += target.entries[i].prob;
          if (len <= 4) {
            const out: (Outcome | MonotoneBoxOutcome)[] = new Array(len);
            for (let i = 0; i < len; i++) {
              const e = target.entries[i];
              const nextAxes = axes.slice();
              nextAxes[splitAxisIdx] = {...target, entries: [e]};
              out[i] = makeMultiBoxOrSingleton(ctx, parentState, baseState, probability * (e.prob / total), nextAxes);
            }
            return out;
          }
          const i0 = 0;
          const i1 = Math.floor(len / 3);
          const i2 = Math.floor((2 * len) / 3);
          const i3 = len - 1;
          const picked = new Set([i0, i1, i2, i3]);
          const out: (Outcome | MonotoneBoxOutcome)[] = [];
          const remEntries: HpEntry[] = [];
          let remSum = 0;
          for (let i = 0; i < len; i++) {
            const e = target.entries[i];
            if (picked.has(i)) {
              const nextAxes = axes.slice();
              nextAxes[splitAxisIdx] = {...target, entries: [e]};
              out.push(makeMultiBoxOrSingleton(ctx, parentState, baseState, probability * (e.prob / total), nextAxes));
            } else {
              remEntries.push(e);
              remSum += e.prob;
            }
          }
          if (remEntries.length > 0 && remSum > 0) {
            const remAxes = axes.slice();
            remAxes[splitAxisIdx] = downgradeAxis(target, remEntries);
            out.push(makeMultiBoxOrSingleton(ctx, parentState, baseState, probability * (remSum / total), remAxes));
          }
          return out;
        }
      }

      let bestLen = 0;
      for (let i = 0; i < axes.length; i++) {
        const a = axes[i];
        if (a.entries.length <= 1) continue;
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
        makeMultiBoxOrSingleton(ctx, parentState, baseState, probability * (sL / total), leftAxes),
        makeMultiBoxOrSingleton(ctx, parentState, baseState, probability * (sR / total), rightAxes),
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
  let hasDrain = false;
  let hasTailwind = false;
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
      const p = state.sides[sideIdx].pokemon[pokeIdx];
      if (act.moveIndex < 0) {
        names.push('Struggle');
        ids.push('struggle');
        cmds.push('auto');
      } else {
        const move = activeMoves(sp, p)[act.moveIndex] ?? sp.moves[act.moveIndex];
        const sk = move.specialKind;
        if (
          move.optTraits.hasDrain ||
          sk === 'sleep-talk' ||
          sk === 'copycat' ||
          sk === 'instruct' ||
          sk === 'transform'
        ) {
          hasDrain = true;
        }
        if (
          sk === 'tailwind' ||
          sk === 'sleep-talk' ||
          sk === 'copycat' ||
          sk === 'instruct' ||
          sk === 'transform'
        ) {
          hasTailwind = true;
        }
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
    ...(hasDrain ? {hasDrain: true} : {}),
    ...(hasTailwind ? {hasTailwind: true} : {}),
  };
}

/**
 * Sound physics-based action ordering for doubles: keeps every legal action
 * intact while ranking high-accuracy fast OHKOs and multi-target coverage first,
 * penalizing redundant double-target overkill and blocked priority (e.g. under
 * Psychic Terrain), and putting failing Fake Out and ally-damaging moves last.
 */
function createDoublesActionScorer(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1
): (sideAction: SideAction) => number {
  const oppSide: 0 | 1 = sideIdx === 0 ? 1 : 0;
  const mySide = state.sides[sideIdx];
  const foeSide = state.sides[oppSide];
  const weather = effectiveFieldWeather(ctx, state);
  const terrain = state.field.terrain;

  // Count fainted allies for Last Respects
  let myFainted = 0;
  for (let i = 0; i < mySide.pokemon.length; i++) {
    if (mySide.pokemon[i].fainted) myFainted++;
  }

  // Alive foe info per active slot
  const foeSlots: Array<{
    slot: number;
    idx: number;
    hp: number;
    speed: number;
    types: readonly string[];
    grounded: boolean;
    def: number;
    spd: number;
    ab: CompiledAbilitySpec;
    abActive: boolean;
    sash: boolean;
  } | null> = [];
  let aliveFoeCount = 0;
  for (let tsl = 0; tsl < foeSide.active.length; tsl++) {
    const fIdx = foeSide.active[tsl];
    if (fIdx < 0) {
      foeSlots.push(null);
      continue;
    }
    const fp = foeSide.pokemon[fIdx];
    if (fp.fainted || fp.hp <= 0) {
      foeSlots.push(null);
      continue;
    }
    const fSp = ctx.sides[oppSide].team[fIdx];
    const fStats = activeStats(fSp, fp);
    const fAb = activeAbilitySpec(fSp, fp);
    const fAbActive = fp.abilityActive && !fp.gastroAcid;
    const fHp = Math.max(1, fp.hp);
    const hasSash = fHp === fSp.maxhp && isItemEffectActive(state, fSp, fp) &&
      activeItemSpec(ctx, fSp, fp).archetype === 'focus-sash';
    foeSlots.push({
      slot: tsl,
      idx: fIdx,
      hp: fHp,
      speed: effectiveSpeed(ctx, state, oppSide, fIdx),
      types: activeTypes(fSp, fp),
      grounded: isGrounded(fSp, fp, state),
      def: Math.max(1, applyBoostToStat(fStats.def, fp.boosts[1])),
      spd: Math.max(1, applyBoostToStat(fStats.spd, fp.boosts[3])),
      ab: fAb,
      abActive: fAbActive,
      sash: hasSash,
    });
    aliveFoeCount++;
  }

  const slotMoveCache = new Map<string, {score: number; ohkoFoeSlot: number; ko0: number; ko1: number}>();

  const evalMoveAct = (act: SlotAction & {kind: 'move'}): {score: number; ohkoFoeSlot: number; ko0: number; ko1: number} => {
    const cacheKey = `${act.slot}:${act.moveIndex}:${act.targetSide ?? -1}:${act.targetSlot ?? -1}:${act.mega ? 1 : 0}`;
    const hit = slotMoveCache.get(cacheKey);
    if (hit) return hit;

    const pokeIdx = mySide.active[act.slot];
    if (pokeIdx < 0) {
      const r = {score: 0, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }
    const poke = mySide.pokemon[pokeIdx];
    const sp = ctx.sides[sideIdx].team[pokeIdx];
    if (act.moveIndex < 0) {
      const r = {score: 150, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }
    const moves = activeMoves(sp, poke);
    const move = moves[act.moveIndex];
    if (!move) {
      const r = {score: 0, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }
    if (act.targetSide === sideIdx && act.targetSlot !== act.slot &&
        move.category !== 'Status' && move.specialKind !== 'pollen-puff') {
      const r = {score: 1000, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }
    if (move.specialKind === 'fake-out' && poke.activeTurns > 0) {
      const r = {score: 450, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
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
      const r = {score: 180 + poke.protectStreak * 80, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }
    if (move.category === 'Status') {
      let s = 110;
      if (move.specialKind === 'trick-room' && state.field.trickRoomTurns > 0) s = 350;
      else if (move.specialKind === 'tailwind' && mySide.tailwindTurns > 0) s = 350;
      else if (move.id === 'followme' || move.id === 'ragepowder') s = 95;
      else if (move.specialKind === 'helping-hand') s = 105;
      const r = {score: s - (act.mega ? 6 : 0), ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }

    // Offensive move against foe(s)
    const useMega = !!act.mega && !!sp.megaForme && !poke.megaEvolved && !mySide.megaUsed;
    const stats = useMega ? sp.megaForme!.stats : activeStats(sp, poke);
    const atkAb = useMega ? sp.megaForme!.abilitySpec : activeAbilitySpec(sp, poke);
    const atkAbActive = useMega || (poke.abilityActive && !poke.gastroAcid);
    const atkTypes = useMega ? sp.megaForme!.types : activeTypes(sp, poke);
    const atkItem = isItemEffectActive(state, sp, poke) ? activeItemSpec(ctx, sp, poke) : null;
    const mySpeed = effectiveSpeed(ctx, state, sideIdx, pokeIdx);
    const myGrounded = isGrounded(sp, poke, state);

    let prio = move.priority;
    if (atkAbActive && atkAb.galeWings && move.type === 'Flying' && hpMin(poke) === sp.maxhp) prio += 1;
    if (move.specialKind === 'grassy-glide' && terrain === 'grassy' && myGrounded) prio += 1;

    const {type: moveType, ateBoosted} = resolveMoveType(ctx, state, sideIdx, pokeIdx, move);
    let bp = move.basePower || 60;
    if (move.specialKind === 'last-respects') bp = 50 + 50 * myFainted;
    else if (move.specialKind === 'weather-ball' && weather !== '') bp = 100;
    else if (move.specialKind === 'terrain-pulse' && terrain !== '' && myGrounded) bp = 100;
    else if (move.id === 'lowkick' || move.id === 'grassknot') bp = 80;
    else if (move.specialKind === 'electro-shot' && weather !== 'rain' && poke.chargingMoveIdx < 0) bp *= 0.45;
    if (move.multihit) {
      bp *= Array.isArray(move.multihit) ? 3.1 : move.multihit;
    }
    if (ateBoosted) bp *= 1.2;
    if (atkAbActive && atkAb.technician && bp <= 60) bp *= 1.5;
    if (atkAbActive && atkAb.toughClaws && move.contact) bp *= 1.3;
    if (atkAbActive && atkAb.sheerForce && move.secondaries.length > 0) bp *= 1.3;

    const isPhys = move.category === 'Physical';
    let offStat = Math.max(1, applyBoostToStat(isPhys ? stats.atk : stats.spa, poke.boosts[isPhys ? 0 : 2]));
    if (isPhys && poke.status === 'brn' && !(atkAbActive && atkAb.guts)) offStat *= 0.5;
    if (isPhys && atkAbActive && atkAb.hugePower) offStat *= 2;
    const stab = atkTypes.includes(moveType) ? (atkAbActive && atkAb.adaptability ? 2.0 : 1.5) : 1.0;
    let mod = stab;
    if (atkItem?.archetype === 'life-orb') mod *= 1.3;
    else if (atkItem?.archetype === 'type-boost' && atkItem.affectedType === moveType) mod *= 1.2;
    else if (atkItem?.archetype === 'muscle-band' && isPhys) mod *= 1.1;
    else if (atkItem?.archetype === 'wise-glasses' && !isPhys) mod *= 1.1;
    if (weather === 'rain') {
      if (moveType === 'Water') mod *= 1.5;
      else if (moveType === 'Fire') mod *= 0.5;
    } else if (weather === 'sun') {
      if (moveType === 'Fire') mod *= 1.5;
      else if (moveType === 'Water') mod *= 0.5;
    }
    if (myGrounded) {
      if (terrain === 'grassy' && moveType === 'Grass') mod *= 1.3;
      else if (terrain === 'electric' && moveType === 'Electric') mod *= 1.3;
      else if (terrain === 'psychic' && moveType === 'Psychic') mod *= 1.3;
    }

    const isSpread = move.target === 'allAdjacentFoes' || move.target === 'allAdjacent';
    const spreadMod = isSpread && aliveFoeCount > 1 ? 0.75 : 1.0;
    const targets: number[] = [];
    if (isSpread) {
      for (let tsl = 0; tsl < foeSlots.length; tsl++) {
        if (foeSlots[tsl]) targets.push(tsl);
      }
    } else if (act.targetSide === oppSide && act.targetSlot !== undefined && foeSlots[act.targetSlot]) {
      targets.push(act.targetSlot);
    } else {
      for (let tsl = 0; tsl < foeSlots.length; tsl++) {
        if (foeSlots[tsl]) {
          targets.push(tsl);
          break;
        }
      }
    }

    if (targets.length === 0) {
      const r = {score: 260, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }

    const scrappy = atkAbActive && !!atkAb.scrappy;
    const noGuard = atkAbActive && !!atkAb.noGuard;
    const isSucker = move.specialKind === 'sucker-punch';
    let totalBenefit = 0;
    let ohkoFoeSlot = -1;
    let ko0 = 0;
    let ko1 = 0;
    for (let ti = 0; ti < targets.length; ti++) {
      const f = foeSlots[targets[ti]]!;
      if (prio > 0 && terrain === 'psychic' && f.grounded) continue;
      if (f.abActive && !atkAb.moldBreaker) {
        if (f.ab.immuneType === moveType) continue;
        if (moveType === 'Ground' && f.ab.eelevate) continue;
        if (moveType === 'Fire' && f.ab.flashFire) continue;
        if (moveType === 'Water' && f.ab.drySkin) continue;
        if (move.sound && f.ab.soundproof) continue;
        if (move.bullet && f.ab.bulletproof) continue;
      }
      const eff = typeEffectiveness(ctx, moveType, f.types, scrappy, move.specialKind);
      if (eff.immune) continue;
      const typeMult = eff.mod >= 0 ? (1 << eff.mod) : (1 / (1 << -eff.mod));
      const defStat = isPhys ? f.def : f.spd;
      const rawDmg = (((22 * bp * offStat) / defStat) / 50 + 2) * mod * spreadMod * typeMult;
      const acc = (noGuard || (f.abActive && f.ab.noGuard) || move.accuracy === true)
        ? 1.0
        : Math.min(1, move.accuracy / 100);
      const koFrac = Math.min(1.2, (rawDmg / f.hp));
      const likelyOhko = rawDmg >= f.hp * 0.95 && !f.sash;
      const outspeeds = prio > 0 || mySpeed > f.speed;
      let val = koFrac * 90 * acc;
      if (likelyOhko) {
        val += 60 * acc;
        if (outspeeds) val += 25 * acc;
        if (acc >= 0.999) val += 22;
        const reliableKo = isSucker ? acc * 0.5 : acc;
        if (f.slot === 0) ko0 = Math.max(ko0, reliableKo);
        else if (f.slot === 1) ko1 = Math.max(ko1, reliableKo);
        if (!isSpread && !isSucker && acc >= 0.95 && rawDmg >= f.hp * 1.08 && ohkoFoeSlot < 0) {
          ohkoFoeSlot = f.slot;
        }
      } else if (outspeeds) {
        val += 10 * acc;
      }
      if (move.specialKind === 'fake-out') val += 40;
      if (isSucker) val -= 34;
      totalBenefit += val;
    }

    if (totalBenefit <= 0) {
      const r = {score: 360, ohkoFoeSlot: -1, ko0: 0, ko1: 0};
      slotMoveCache.set(cacheKey, r);
      return r;
    }
    const finalScore = -totalBenefit - (act.mega ? 6 : 0) - (prio > 0 ? 4 : 0);
    const r = {score: finalScore, ohkoFoeSlot, ko0, ko1};
    slotMoveCache.set(cacheKey, r);
    return r;
  };

  return (sideAction: SideAction): number => {
    let score = 0;
    let firstOhkoSlot = -1;
    let firstTargetSlot = -1;
    let cov0 = 0;
    let cov1 = 0;
    for (let i = 0; i < sideAction.length; i++) {
      const act = sideAction[i];
      if (act.kind === 'pass') {
        score += 300;
        continue;
      }
      if (act.kind === 'switch') {
        score += 240;
        continue;
      }
      const res = evalMoveAct(act);
      score += res.score;
      cov0 = 1 - (1 - cov0) * (1 - res.ko0);
      cov1 = 1 - (1 - cov1) * (1 - res.ko1);
      const tSlot = act.targetSide === oppSide && act.targetSlot !== undefined ? act.targetSlot : -1;
      if (i === 0) {
        firstOhkoSlot = res.ohkoFoeSlot;
        firstTargetSlot = tSlot;
      } else if (aliveFoeCount > 1 && tSlot >= 0 && tSlot === firstTargetSlot) {
        // Penalize redundant overkill on a single foe when one slot already OHKOs it.
        if (firstOhkoSlot === tSlot || res.ohkoFoeSlot === tSlot) {
          score += 65;
        }
      }
    }
    if (aliveFoeCount > 1) {
      score -= 90 * (cov0 * cov1) + 25 * (cov0 + cov1);
    }
    return score;
  };
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

  // Exact PP-template transition cache across 1v1, multi-Pokemon singles, and doubles
  // (maskPp buckets PP >= 3 as '+', which is exact whenever maxPpLossPerTurn <= 2).
  const canUsePpTemplateCache = ppLinearSafe && maxPpLossPerTurn <= 2;

  let canMaskProtectStreak = canUsePpTemplateCache;
  let battleHasMidTurnSwitch = false;
  if (canMaskProtectStreak) {
    for (let s = 0; s < 2 && canMaskProtectStreak; s++) {
      for (const mon of ctx.sides[s].team) {
        if (mon.itemSpec.archetype === 'eject-button' || mon.itemSpec.archetype === 'red-card') {
          battleHasMidTurnSwitch = true;
        }
        for (const ab of allStaticAbilities(mon)) {
          if (ab.optTraits.hpThreshold === 'half-maxhp-pivot') battleHasMidTurnSwitch = true;
        }
        for (const m of mon.moves) {
          if (m.specialKind === 'encore' || m.specialKind === 'revival-blessing') {
            canMaskProtectStreak = false;
            break;
          }
          if (m.selfSwitch || m.forceSwitch) battleHasMidTurnSwitch = true;
        }
      }
    }
  }

  const protectMaskForTurn = (
    state: DynamicState,
    p1Action: SideAction,
    p2Action: SideAction
  ): number => {
    if (!canMaskProtectStreak) return 0;
    if (battleHasMidTurnSwitch && (countAliveAndBench(state, 0).aliveBench > 0 || countAliveAndBench(state, 1).aliveBench > 0)) {
      return 0;
    }
    let mask = 0;
    const actions: readonly [SideAction, SideAction] = [p1Action, p2Action];
    for (let s = 0; s < 2; s++) {
      const side = state.sides[s];
      const sa = actions[s];
      for (let k = 0; k < sa.length; k++) {
        const slotAct = sa[k];
        const pokeIdx = side.active[slotAct.slot];
        if (pokeIdx < 0) continue;
        const p = side.pokemon[pokeIdx];
        if (p.fainted || p.transformed) continue;
        if (slotAct.kind === 'move' && slotAct.moveIndex >= 0) {
          const mv = activeMoves(ctx.sides[s].team[pokeIdx], p)[slotAct.moveIndex];
          if (mv && (mv.protect || mv.specialKind === 'endure')) continue;
        }
        mask |= 1 << (s * 6 + pokeIdx);
      }
    }
    return mask;
  };

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

  const monHasEndure: [boolean[], boolean[]] = [
    ctx.sides[0].team.map(mon => mon.moves.some(m => m.specialKind === 'endure')),
    ctx.sides[1].team.map(mon => mon.moves.some(m => m.specialKind === 'endure')),
  ];
  const monHasFakeOut: [boolean[], boolean[]] = [
    ctx.sides[0].team.map(mon => mon.moves.some(m => m.specialKind === 'fake-out')),
    ctx.sides[1].team.map(mon => mon.moves.some(m => m.specialKind === 'fake-out')),
  ];

  const jointMonoPpSignature = ppLinearSafe
    ? (state: DynamicState): JointMonoPpSignature | null => {
        if (state.phase.kind !== 'turn') return null;
        const pp: number[] = [];
        const vec: number[] = [];
        const sides: number[] = [];
        const bits: number[] = [];
        const modes: number[] = [];
        let maskHpBits = 0;
        let modeTag = 0;
        let turn0Mask = 0;
        for (let s = 0; s < 2; s++) {
          const sideIdx: 0 | 1 = s === 0 ? 0 : 1;
          const side = state.sides[sideIdx];
          const team = side.pokemon;
          for (let sl = 0; sl < side.active.length; sl++) {
            const idx = side.active[sl];
            if (idx >= 0 && !team[idx].fainted && team[idx].activeTurns === 0 && monHasFakeOut[sideIdx][idx]) {
              turn0Mask |= 1 << (sideIdx * 6 + idx);
            }
          }
          for (let i = 0; i < team.length; i++) {
            const p = team[i];
            if (p.fainted) continue;
            if (p.hpDist) return null;
            for (let m = 0; m < p.pp.length; m++) pp.push(p.pp[m]);
            const modeStr = analyzer.classifyPokeHp(state, sideIdx, i, p.hp);
            if (modeStr === 'opaque') continue;
            if (modeStr !== 'unconditional' && monHasEndure[sideIdx][i]) continue;
            const modeNum = modeStr === 'unconditional' ? 0 : modeStr === 'no-drain-opp' ? 1 : 2;
            const bit = 1 << (sideIdx * 6 + i);
            maskHpBits |= bit;
            modeTag = modeTag * 4 + (modeNum + 1);
            vec.push(sideIdx === 0 ? p.hp : -p.hp);
            sides.push(sideIdx);
            bits.push(bit);
            modes.push(modeNum);
          }
        }
        if (vec.length === 0 || pp.length === 0) return null;
        const base = canonicalStateKey(ctx, state, undefined, true, undefined, maskHpBits);
        const groupKey = turn0Mask
          ? `${base}|J:${maskHpBits}:${modeTag}|T:${turn0Mask}`
          : `${base}|J:${maskHpBits}:${modeTag}`;
        return {
          groupKey,
          vec,
          sides,
          bits,
          modes,
          pp,
          maxPpLossPerTurn,
        };
      }
    : undefined;

  interface PpTemplateOutcome {
    state: DynamicState;
    probability: number;
    /** Per-side, per-Pokemon PP delta arrays (null when fainted or unchanged from template input). */
    dpp: [(number[] | null)[], (number[] | null)[]];
  }
  interface PpTemplateEntry {
    entries: PpTemplateOutcome[];
    remainingMass: number;
    complete: boolean;
    actionObs?: ActionObservation;
  }
  const ppTemplateCache = canUsePpTemplateCache ? new Map<string, PpTemplateEntry>() : null;
  const PP_TEMPLATE_CACHE_LIMIT = 16384;
  const enableProgressive = options.progressive !== false;

  const instantiatePpState = (
    tpl: DynamicState,
    inState: DynamicState,
    dpp: [(number[] | null)[], (number[] | null)[]]
  ): DynamicState => {
    if (tpl.phase.kind === 'ended') return tpl;
    let sidesOut: [DynamicState['sides'][0], DynamicState['sides'][1]] | null = null;
    for (let s = 0; s < 2; s++) {
      const tplSide = tpl.sides[s];
      const inSide = inState.sides[s];
      const sideDpp = dpp[s];
      let pokesOut: DynamicState['sides'][0]['pokemon'] | null = null;
      for (let i = 0; i < tplSide.pokemon.length; i++) {
        const delta = sideDpp[i];
        if (!delta) continue;
        const tplP = tplSide.pokemon[i];
        const inPp = inSide.pokemon[i].pp;
        let sameAsTpl = true;
        for (let m = 0; m < inPp.length; m++) {
          if (inPp[m] + delta[m] !== tplP.pp[m]) {
            sameAsTpl = false;
            break;
          }
        }
        if (sameAsTpl) continue;
        if (!pokesOut) pokesOut = tplSide.pokemon.slice();
        const nextPp = new Array<number>(inPp.length);
        for (let m = 0; m < inPp.length; m++) nextPp[m] = inPp[m] + delta[m];
        pokesOut[i] = {...tplP, pp: nextPp};
      }
      if (pokesOut) {
        if (!sidesOut) sidesOut = [tpl.sides[0], tpl.sides[1]];
        sidesOut[s] = {...tplSide, pokemon: pokesOut};
      }
    }
    return sidesOut ? {...tpl, sides: sidesOut} : tpl;
  };

  const instantiateCachedOutcomes = (
    state: DynamicState,
    cached: PpTemplateEntry
  ): Array<{state: DynamicState; probability: number}> => {
    const out = new Array<{state: DynamicState; probability: number}>(cached.entries.length);
    for (let i = 0; i < cached.entries.length; i++) {
      const c = cached.entries[i];
      out[i] = {
        state: instantiatePpState(c.state, state, c.dpp),
        probability: c.probability,
      };
    }
    return out;
  };

  const storePpTemplate = (
    tplKey: string,
    state: DynamicState,
    stepOutcomes: Array<{state: DynamicState; probability: number}>,
    remainingMass: number,
    complete: boolean,
    actionObs?: ActionObservation
  ): void => {
    if (!ppTemplateCache) return;
    const existing = ppTemplateCache.get(tplKey);
    if (existing && existing.complete && !complete) return;
    if (ppTemplateCache.size >= PP_TEMPLATE_CACHE_LIMIT) {
      ppTemplateCache.clear();
    }
    const entries: PpTemplateOutcome[] = stepOutcomes.map(o => {
      if (o.state.phase.kind === 'ended') {
        return {state: o.state, probability: o.probability, dpp: [[], []]};
      }
      const dpp: [(number[] | null)[], (number[] | null)[]] = [[], []];
      for (let s = 0; s < 2; s++) {
        const inTeam = state.sides[s].pokemon;
        const outTeam = o.state.sides[s].pokemon;
        const arr = new Array<number[] | null>(outTeam.length);
        for (let i = 0; i < outTeam.length; i++) {
          const inP = inTeam[i];
          const outP = outTeam[i];
          if (inP.fainted || outP.fainted) {
            arr[i] = null;
          } else {
            const delta = new Array<number>(outP.pp.length);
            for (let m = 0; m < outP.pp.length; m++) delta[m] = outP.pp[m] - inP.pp[m];
            arr[i] = delta;
          }
        }
        dpp[s] = arr;
      }
      return {state: o.state, probability: o.probability, dpp};
    });
    ppTemplateCache.set(tplKey, {entries, remainingMass, complete, actionObs});
  };

  const slotActionsEqual = (a: SlotAction, b: SlotAction): boolean => {
    if (a.kind !== b.kind || a.slot !== b.slot) return false;
    if (a.kind === 'pass') return true;
    if (a.kind === 'switch') return b.kind === 'switch' && a.benchIndex === b.benchIndex;
    return b.kind === 'move' &&
      a.moveIndex === b.moveIndex &&
      !!a.mega === !!b.mega &&
      a.targetSide === b.targetSide &&
      a.targetSlot === b.targetSlot;
  };

  const computeEquivalentSideIndices = (
    state: DynamicState,
    sideIdx: 0 | 1,
    chosen: EngineActionEntry,
    allActions: EngineActionEntry[] | undefined,
    obs: ActionObservation | undefined
  ): number[] | undefined => {
    if (!obs || !allActions || allActions.length <= 1 || state.phase.kind !== 'turn') return undefined;
    const chosenSa = chosen.sideAction;
    const oppSide: 0 | 1 = sideIdx === 0 ? 1 : 0;
    let anyFoldable = false;
    for (let k = 0; k < chosenSa.length; k++) {
      const act = chosenSa[k];
      if (act.kind !== 'move') continue;
      const slotId = sideIdx * 2 + act.slot;
      const flags = obs.flags[slotId];
      if ((flags & (ACTION_OBS_EXECUTED | ACTION_OBS_EXACT)) === 0 && !act.mega && act.moveIndex >= 0) {
        anyFoldable = true;
        break;
      }
      if (ctx.activeCount === 2 && act.targetSide === oppSide && (flags & ACTION_OBS_OPP_TARGET_MATTERED) === 0) {
        anyFoldable = true;
        break;
      }
    }
    if (!anyFoldable) return undefined;

    const side = state.sides[sideIdx];
    const indices: number[] = [];
    for (let idx = 0; idx < allActions.length; idx++) {
      const candSa = allActions[idx].sideAction;
      if (candSa.length !== chosenSa.length) continue;
      let match = true;
      for (let k = 0; k < chosenSa.length; k++) {
        const ca = chosenSa[k];
        const da = candSa[k];
        if (slotActionsEqual(ca, da)) continue;
        if (ca.kind !== 'move' || da.kind !== 'move' || ca.slot !== da.slot) {
          match = false;
          break;
        }
        const slotId = sideIdx * 2 + ca.slot;
        const flags = obs.flags[slotId];
        // Mode 1: Unacted / sleep-immobilized slot folding
        if ((flags & (ACTION_OBS_EXECUTED | ACTION_OBS_EXACT)) === 0) {
          if (ca.mega || da.mega || ca.moveIndex < 0 || da.moveIndex < 0) {
            match = false;
            break;
          }
          const pokeIdx = side.active[ca.slot];
          if (pokeIdx < 0) { match = false; break; }
          const p = side.pokemon[pokeIdx];
          const sp = ctx.sides[sideIdx].team[pokeIdx];
          const moves = activeMoves(sp, p);
          const cMv = moves[ca.moveIndex];
          const dMv = moves[da.moveIndex];
          if (!cMv || !dMv) { match = false; break; }
          if (dMv.specialKind === 'focus-punch' || dMv.specialKind === 'beak-blast' || dMv.specialKind === 'grassy-glide') {
            match = false;
            break;
          }
          if ((flags & ACTION_OBS_SLEEP_ONLY) !== 0 && (dMv.specialKind === 'snore' || dMv.specialKind === 'sleep-talk')) {
            match = false;
            break;
          }
          const ab = activeAbilitySpec(sp, p);
          let dPrio = dMv.priority;
          if (p.abilityActive && !p.gastroAcid && ab.prankster && dMv.category === 'Status') dPrio += 1;
          if (p.abilityActive && !p.gastroAcid && ab.galeWings && dMv.type === 'Flying' && hpMin(p) === sp.maxhp) dPrio += 1;
          const dSub = p.abilityActive && !p.gastroAcid && ab.stall ? -1 : 0;
          if (dPrio !== obs.priority[slotId] || dSub !== obs.subOrder[slotId]) {
            match = false;
            break;
          }
          if ((flags & ACTION_OBS_CATEGORY) !== 0 && (dMv.category === 'Status') !== (cMv.category === 'Status')) {
            match = false;
            break;
          }
          continue;
        }
        // Mode 2: Opponent target-slot folding (+1 vs +2 identical)
        if (ctx.activeCount === 2 &&
            (flags & ACTION_OBS_OPP_TARGET_MATTERED) === 0 &&
            ca.moveIndex === da.moveIndex &&
            !!ca.mega === !!da.mega &&
            ca.targetSide === oppSide &&
            da.targetSide === oppSide) {
          continue;
        }
        match = false;
        break;
      }
      if (match) indices.push(idx);
    }
    return indices.length > 1 ? indices : undefined;
  };

  const formatStepOutcomes = (
    parentState: DynamicState,
    stepOutcomes: Array<{state: DynamicState; probability: number}>
  ): (Outcome | MonotoneBoxOutcome)[] => {
    if (!useBoxes) {
      const outcomes = stepOutcomes.map(o => {
        const faintMask = computeFaintMask(ctx, parentState, o.state);
        const utility = terminalUtilityFromState(o.state);
        if (utility !== null) {
          return faintMask ? {utility, probability: o.probability, faintMask} : {utility, probability: o.probability};
        }
        return faintMask ? {snapshot: o.state as any, probability: o.probability, faintMask} : {snapshot: o.state as any, probability: o.probability};
      }) as Outcome[];
      return bucketSmallTail(outcomes);
    }

    const outcomes: (Outcome | MonotoneBoxOutcome)[] = [];
    for (const o of stepOutcomes) {
      const utility = terminalUtilityFromState(o.state);
      if (utility !== null) {
        const faintMask = computeFaintMask(ctx, parentState, o.state);
        outcomes.push(faintMask ? {utility, probability: o.probability, faintMask} : {utility, probability: o.probability});
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
        const faintMask = computeFaintMask(ctx, parentState, o.state);
        outcomes.push(faintMask ? {snapshot: o.state as any, probability: o.probability, faintMask} : {snapshot: o.state as any, probability: o.probability});
        continue;
      }

      if (o.state.phase.kind !== 'turn' || hasZeroOrNeg) {
        if (rawProduct <= 16) {
          for (const ws of expandStateHpDists(o)) {
            const faintMask = computeFaintMask(ctx, parentState, ws.state);
            const u = terminalUtilityFromState(ws.state);
            if (u !== null) {
              outcomes.push(faintMask ? {utility: u, probability: ws.probability, faintMask} : {utility: u, probability: ws.probability});
            } else {
              outcomes.push(faintMask ? {snapshot: ws.state as any, probability: ws.probability, faintMask} : {snapshot: ws.state as any, probability: ws.probability});
            }
          }
        } else {
          // Keep large switch-phase HpDist products lazy to avoid eager 16^k blowup.
          const lazyAxes: MultiHpAxis[] = distAxes.map(a => ({
            side: a.side,
            pokeIdx: a.pokeIdx,
            entries: a.dist,
            mode: 'opaque' as const,
          }));
          outcomes.push(makeMultiBoxOrSingleton(ctx, parentState, o.state, o.probability, lazyAxes));
        }
        continue;
      }

      // Partition each multi-entry axis into unconditional, witness-conditioned, and opaque chunks
      const axisChunks: {side: 0 | 1; pokeIdx: number; chunks: HpAxisChunk[]}[] = [];
      let opaqueEagerProduct = 1;
      let totalChunkProduct = 1;
      for (let i = 0; i < distAxes.length; i++) {
        const a = distAxes[i];
        const chunks = analyzer.anyAxisAllowed
          ? partitionMonotoneAxis(o.state, a.side, a.pokeIdx, a.dist, analyzer.classifyPokeHp)
          : [{entries: a.dist, sum: 1, mode: 'opaque' as const}];
        axisChunks.push({side: a.side, pokeIdx: a.pokeIdx, chunks});
        totalChunkProduct *= chunks.length;
        let maxOpaque = 1;
        for (let c = 0; c < chunks.length; c++) {
          if (chunks[c].mode === 'opaque' && chunks[c].entries.length > maxOpaque) {
            maxOpaque = chunks[c].entries.length;
          }
        }
        opaqueEagerProduct *= maxOpaque;
      }

      // For small 1-axis truly opaque distributions (like 1v1 Sitrus Berry),
      // keep individual opaque HPs eager for immediate bounds; conditional and
      // large multi-axis boxes stay collapsed with sound corners/lazy bisection.
      const expandOpaqueEagerly = opaqueEagerProduct <= 16 && totalChunkProduct * opaqueEagerProduct <= 32;
      const finalChunks = expandOpaqueEagerly
        ? axisChunks.map(ac => ({
            side: ac.side,
            pokeIdx: ac.pokeIdx,
            chunks: ac.chunks.flatMap(ch =>
              ch.mode !== 'opaque' || ch.entries.length <= 1
                ? [ch]
                : ch.entries.map(e => ({entries: [e], sum: e.prob, mode: 'opaque' as const}))
            ),
          }))
        : axisChunks;

      // Cartesian product over chunks across axes
      const emitCombos = (depth: number, prob: number, chosen: MultiHpAxis[]) => {
        if (prob <= 0) return;
        if (depth === finalChunks.length) {
          outcomes.push(makeMultiBoxOrSingleton(ctx, parentState, o.state, prob, chosen.slice()));
          return;
        }
        const ac = finalChunks[depth];
        for (let c = 0; c < ac.chunks.length; c++) {
          const ch = ac.chunks[c];
          chosen[depth] = {
            side: ac.side,
            pokeIdx: ac.pokeIdx,
            entries: ch.entries,
            mode: ch.mode,
          };
          emitCombos(depth + 1, prob * ch.sum, chosen);
        }
      };
      emitCombos(0, o.probability, new Array(finalChunks.length));
    }
    return bucketSmallTail(outcomes);
  };

  const isTerrainInert = (state: DynamicState): boolean => {
    const terr = state.field.terrain;
    if (terr === '') return true;
    if (terr === 'grassy') return false;
    let battleAnyHeal = false;
    for (let s = 0; s < 2 && !battleAnyHeal; s++) {
      const sd = state.sides[s];
      for (let k = 0; k < sd.wishTurns.length; k++) if (sd.wishTurns[k] > 0) battleAnyHeal = true;
      for (let i = 0; i < sd.pokemon.length; i++) {
        const p = sd.pokemon[i];
        if (p.fainted) continue;
        if (p.aquaRing || p.ingrain || p.leechSeedSlot >= 0 || p.cudchewBerry !== '') {
          battleAnyHeal = true;
          break;
        }
        const sp = ctx.sides[s].team[i];
        const it = p.itemActive ? activeItemSpec(ctx, sp, p) : null;
        if (it && (it.optTraits.canHealWithoutBerry || it.optTraits.hpThresholdBerry)) {
          battleAnyHeal = true;
          break;
        }
        for (const ab of allStaticAbilities(sp)) {
          if (ab.optTraits.canHealSelf || ab.optTraits.canHealFoe || ab.setsTerrain === 'grassy' || ab.seedSower) {
            battleAnyHeal = true;
            break;
          }
        }
        for (const mv of sp.moves) {
          if (mv.optTraits.canHealSelf || mv.optTraits.canHealFoe || mv.optTraits.hasDrain || mv.setsTerrain === 'grassy') {
            battleAnyHeal = true;
            break;
          }
        }
      }
    }
    for (let s = 0; s < 2; s++) {
      const sd = state.sides[s];
      const team = ctx.sides[s].team;
      for (let i = 0; i < sd.pokemon.length; i++) {
        const p = sd.pokemon[i];
        if (p.fainted) continue;
        if (p.transformed) return false;
        const sp = team[i];
        const curItem = p.itemActive ? activeItemSpec(ctx, sp, p) : null;
        if (curItem && (curItem.archetype === 'terrain-seed' || curItem.archetype === 'terrain-extender')) return false;
        if (sp.itemSpec.archetype === 'terrain-seed' || sp.itemSpec.archetype === 'terrain-extender') return false;
        if (terr === 'misty' && (
          sp.itemSpec.flingStatus || curItem?.flingStatus ||
          state.sides[0].toxicSpikes > 0 || state.sides[1].toxicSpikes > 0
        )) {
          return false;
        }
        const abs = allStaticAbilities(sp);
        if (p.abilityOverride) abs.push(activeAbilitySpec(sp, p));
        for (let ai = 0; ai < abs.length; ai++) {
          const ab = abs[ai];
          if (ab.setsTerrain || ab.seedSower || ab.mimicry || ab.speedDoubleTerrain || ab.grassPelt || ab.imposter) {
            return false;
          }
          if (terr === 'psychic') {
            if (ab.prankster) return false;
            if (ab.galeWings && (p.hp >= sp.maxhp || battleAnyHeal)) return false;
          } else if (terr === 'electric') {
            if (ab.effectSpore) return false;
          } else if (terr === 'misty') {
            if (ab.effectSpore || ab.contactStatus || ab.toxicDebris || ab.poisonTouch || ab.synchronize) {
              return false;
            }
          }
        }
        const moves = sp.moves;
        for (let mi = 0; mi < moves.length; mi++) {
          const mv = moves[mi];
          const sk = mv.specialKind;
          if (
            sk === 'set-terrain' || sk === 'terrain-pulse' || sk === 'steel-roller' ||
            sk === 'sleep-talk' || sk === 'copycat' || sk === 'instruct' || sk === 'transform'
          ) {
            return false;
          }
          if (terr === 'psychic') {
            if (sk === 'expanding-force' || mv.optTraits.dynamicMoveType) return false;
            if (mv.type === 'Psychic' && mv.category !== 'Status') return false;
            if (mv.priority > 0 && mv.target !== 'self' && mv.target !== 'allySide' &&
                mv.target !== 'adjacentAlly' && mv.target !== 'adjacentAllyOrSelf') {
              return false;
            }
          } else if (terr === 'electric') {
            if (sk === 'rising-voltage' || mv.optTraits.dynamicMoveType) return false;
            if (mv.type === 'Electric' && mv.category !== 'Status') return false;
            if (mv.statusInflict === 'slp' || sk === 'yawn' || sk === 'rest' || mv.id === 'direclaw') return false;
            for (let si = 0; si < mv.secondaries.length; si++) {
              if (mv.secondaries[si].status === 'slp') return false;
            }
          } else if (terr === 'misty') {
            if (mv.id === 'mistyexplosion' || mv.optTraits.dynamicMoveType) return false;
            if (mv.type === 'Dragon' && mv.category !== 'Status') return false;
            if (mv.statusInflict !== null || mv.volatileStatus === 'confusion' ||
                sk === 'yawn' || sk === 'rest' || sk === 'tri-attack' || sk === 'fling' ||
                sk === 'toxic-spikes' || mv.id === 'direclaw') {
              return false;
            }
            for (let si = 0; si < mv.secondaries.length; si++) {
              const sec = mv.secondaries[si];
              if (sec.status || sec.volatileStatus === 'confusion') return false;
            }
          }
        }
      }
    }
    return true;
  };

  const protectContractionInfo = canUsePpTemplateCache
    ? (state: DynamicState): ProtectContractionInfo | null => {
        if (state.phase.kind !== 'turn') return null;
        const f = state.field;
        if (f.weatherTurns > 0 || f.trickRoomTurns > 0 ||
            f.gravityTurns > 0 || f.magicRoomTurns > 0 || f.wonderRoomTurns > 0 ||
            f.fairyLockTurns > 0) {
          return null;
        }
        const inertTerrain = f.terrainTurns > 0;
        if (inertTerrain && !isTerrainInert(state)) return null;
        const tw0 = state.sides[0].tailwindTurns;
        const tw1 = state.sides[1].tailwindTurns;
        if (tw0 !== tw1) return null;
        const equalTailwind = tw0 > 0;
        for (let s = 0; s < 2; s++) {
          const sd = state.sides[s];
          if (sd.reflectTurns > 0 || sd.lightScreenTurns > 0 ||
              sd.auroraVeilTurns > 0 || sd.safeguardTurns > 0) {
            return null;
          }
          for (let k = 0; k < sd.wishTurns.length; k++) if (sd.wishTurns[k] > 0) return null;
          for (let k = 0; k < sd.futureMoves.length; k++) if (sd.futureMoves[k] !== null) return null;
        }
        if (battleHasMidTurnSwitch &&
            (countAliveAndBench(state, 0).aliveBench > 0 || countAliveAndBench(state, 1).aliveBench > 0)) {
          return null;
        }
        let stallingSide: 0 | 1 | -1 = -1;
        const stallingSlots: number[] = [];
        const stallingPokeIdxs: number[] = [];
        const stallingStreaks: number[] = [];
        for (let s = 0; s < 2; s++) {
          const sideIdx: 0 | 1 = s === 0 ? 0 : 1;
          const side = state.sides[sideIdx];
          for (let sl = 0; sl < side.active.length; sl++) {
            const idx = side.active[sl];
            if (idx < 0) continue;
            const p = side.pokemon[idx];
            if (p.fainted) continue;
            // activeTurns only gates Fake Out / First Impression; require > 0 only when the mon has one.
            if (p.hpDist || p.transformed || (p.activeTurns <= 0 && monHasFakeOut[sideIdx][idx])) return null;
            if (p.protectStreak > 0) {
              if (stallingSide !== -1 && stallingSide !== sideIdx) return null;
              stallingSide = sideIdx;
              stallingSlots.push(sl);
              stallingPokeIdxs.push(idx);
              stallingStreaks.push(p.protectStreak);
            }
          }
        }
        if (stallingSide === -1 || stallingSlots.length === 0 || stallingSlots.length > 2) {
          return null;
        }
        const streak = stallingStreaks.length === 2
          ? Math.min(stallingStreaks[0], stallingStreaks[1])
          : stallingStreaks[0];
        const maxStreak = stallingStreaks.length === 2
          ? Math.max(stallingStreaks[0], stallingStreaks[1])
          : stallingStreaks[0];
        if (streak < 1 || streak >= 6 || maxStreak > 6) {
          return null;
        }
        const stallSlotsCount: 1 | 2 = stallingSlots.length === 2 ? 2 : 1;
        const streaks: [number] | [number, number] = stallSlotsCount === 2
          ? [stallingStreaks[0], stallingStreaks[1]]
          : [stallingStreaks[0]];
        for (let t = 0; t < stallingPokeIdxs.length; t++) {
          const stallP = state.sides[stallingSide].pokemon[stallingPokeIdxs[t]];
          if (stallP.status !== '' || stallP.confusionTurns > 0 || stallP.attractSide >= 0 || stallP.encoreMoveIdx >= 0) {
            return null;
          }
        }
        // Fail closed dynamically if any alive mon on stallingSide has Encore (could force
        // stallP into Protect on a non-stall row) or if any alive mon has Revival Blessing.
        // Under equal positive Tailwind, also forbid stalling-side Tailwind/indirect callers,
        // Gyro Ball/Electro Ball, Trick Room (if 13-bit wrap possible), and speeds that could
        // hit the 8192 13-bit wraparound after doubling.
        let battleHasMoveLocker = false;
        for (let s = 0; s < 2; s++) {
          const side = state.sides[s];
          const team = ctx.sides[s].team;
          for (let i = 0; i < side.pokemon.length; i++) {
            const p = side.pokemon[i];
            if (p.fainted) continue;
            const sp = team[i];
            if (s === stallingSide && (
              p.choiceLockedMoveIdx >= 0 || p.disabledMoveIdx >= 0 || p.tormented ||
              p.tauntTurns > 0 || p.throatChopTurns > 0
            )) {
              battleHasMoveLocker = true;
            }
            if (equalTailwind) {
              if (sp.stats.spe > 340) return null;
              if (!side.megaUsed && sp.megaForme && sp.megaForme.stats.spe > 340) return null;
              for (const afKey in sp.altFormes) {
                if (sp.altFormes[afKey].stats.spe > 340) return null;
              }
            }
            const moves = sp.moves;
            for (let mi = 0; mi < moves.length; mi++) {
              const sk = moves[mi].specialKind;
              if (sk === 'revival-blessing') return null;
              if (s === stallingSide && sk === 'encore') return null;
              if (sk === 'encore' || sk === 'disable' || sk === 'torment' || sk === 'imprison' || sk === 'throat-chop' || sk === 'gravity') {
                battleHasMoveLocker = true;
              }
              if (equalTailwind) {
                if (sk === 'gyro-ball' || sk === 'electro-ball') return null;
                if (sk === 'trick-room' && !ctx.ruleset.trickRoomNegatesSpeed) return null;
                if (s === stallingSide && (
                  sk === 'tailwind' || sk === 'sleep-talk' || sk === 'copycat' ||
                  sk === 'instruct' || sk === 'transform'
                )) {
                  return null;
                }
              }
            }
          }
        }

        let stallBits = 0;
        for (let t = 0; t < stallingPokeIdxs.length; t++) {
          stallBits |= 1 << (stallingSide * 6 + stallingPokeIdxs[t]);
        }
        const baseKey = canonicalStateKey(ctx, state, undefined, true, undefined, 0, stallBits, equalTailwind, inertTerrain);
        const oppSide: 0 | 1 = stallingSide === 0 ? 1 : 0;
        const stallMovesBySlot = stallingPokeIdxs.map(idx =>
          activeMoves(ctx.sides[stallingSide].team[idx], state.sides[stallingSide].pokemon[idx])
        );
        let stallHasContactProtect = false;
        for (let t = 0; t < stallMovesBySlot.length; t++) {
          const mvs = stallMovesBySlot[t];
          for (let mi = 0; mi < mvs.length; mi++) {
            const mv = mvs[mi];
            if (mv.protect && mv.id !== 'protect' && mv.id !== 'detect') {
              stallHasContactProtect = true;
            }
          }
        }

        const stallActionMask = (entry: EngineActionEntry): 0 | 1 | 2 | 3 => {
          const sa = entry.sideAction;
          let mask = 0;
          for (let k = 0; k < sa.length; k++) {
            const act = sa[k];
            if (act.kind !== 'move' || act.moveIndex < 0) continue;
            for (let t = 0; t < stallingSlots.length; t++) {
              if (act.slot === stallingSlots[t]) {
                const mv = stallMovesBySlot[t][act.moveIndex];
                if (mv && (mv.protect || mv.specialKind === 'endure')) mask |= 1 << t;
                break;
              }
            }
          }
          return mask as 0 | 1 | 2 | 3;
        };

        const stallActionCount = (entry: EngineActionEntry): 0 | 1 | 2 => {
          const mask = stallActionMask(entry);
          return mask === 3 ? 2 : mask === 0 ? 0 : 1;
        };

        const isOpponentActionEligible = (entry: EngineActionEntry): boolean => {
          const sa = entry.sideAction;
          const oppStateSide = state.sides[oppSide];
          for (let k = 0; k < sa.length; k++) {
            const act = sa[k];
            if (act.kind === 'switch') return false;
            if (act.kind === 'move') {
              if (act.mega || act.moveIndex < 0) return false;
              const pokeIdx = oppStateSide.active[act.slot];
              if (pokeIdx < 0) return false;
              const mv = activeMoves(ctx.sides[oppSide].team[pokeIdx], oppStateSide.pokemon[pokeIdx])[act.moveIndex];
              if (!mv || mv.protect || mv.specialKind === 'endure' || mv.specialKind === 'encore') return false;
              if (equalTailwind && (
                mv.specialKind === 'tailwind' || mv.specialKind === 'sleep-talk' ||
                mv.specialKind === 'copycat' || mv.specialKind === 'instruct' || mv.specialKind === 'transform'
              )) {
                return false;
              }
              if (stallHasContactProtect && mv.contact && mv.protectable) return false;
            }
          }
          return true;
        };

        const maxSafeStreak = (
          opponentAction: EngineActionEntry,
          selfShiftActions: EngineActionEntry[],
          maxProofDepth: number
        ): number => {
          const reqPpAtLast = Math.max(3, maxPpLossPerTurn * maxProofDepth + 1);
          let minPp = Infinity;
          const oppStateSide = state.sides[oppSide];
          for (let k = 0; k < opponentAction.sideAction.length; k++) {
            const act = opponentAction.sideAction[k];
            if (act.kind !== 'move') continue;
            if (act.moveIndex < 0) return streak;
            const pokeIdx = oppStateSide.active[act.slot];
            if (pokeIdx < 0) return streak;
            const pp = oppStateSide.pokemon[pokeIdx].pp[act.moveIndex];
            if (pp < minPp) minPp = pp;
          }
          const stallStateSide = state.sides[stallingSide];
          for (let a = 0; a < selfShiftActions.length; a++) {
            const sa = selfShiftActions[a].sideAction;
            for (let k = 0; k < sa.length; k++) {
              const act = sa[k];
              if (act.kind !== 'move') continue;
              if (act.moveIndex < 0 || act.mega) return streak;
              const pokeIdx = stallStateSide.active[act.slot];
              if (pokeIdx < 0) return streak;
              const p = stallStateSide.pokemon[pokeIdx];
              const mvs = activeMoves(ctx.sides[stallingSide].team[pokeIdx], p);
              const mv = mvs[act.moveIndex];
              // Lower Protect/Endure PP on stallingSide can only remove Protect as a legal move
              // (strictly weaker for stallingSide) provided Struggle is impossible within the proof horizon.
              if (!battleHasMoveLocker && mv && (mv.protect || mv.specialKind === 'endure')) {
                let hasSafeBackupAttack = false;
                for (let mi = 0; mi < mvs.length; mi++) {
                  if (mi === act.moveIndex) continue;
                  const bm = mvs[mi];
                  if (bm.category !== 'Status' && !bm.protect && bm.specialKind !== 'endure' &&
                      bm.specialKind !== 'fake-out' && bm.specialKind !== 'steel-roller' &&
                      p.pp[mi] >= reqPpAtLast) {
                    hasSafeBackupAttack = true;
                    break;
                  }
                }
                if (hasSafeBackupAttack) continue;
              }
              const pp = p.pp[act.moveIndex];
              if (pp < minPp) minPp = pp;
            }
          }
          if (!Number.isFinite(minPp)) return streak;
          let targetK = streak;
          for (let cand = streak + 1; cand <= 6; cand++) {
            if (minPp - (cand - 1 - streak) * maxPpLossPerTurn >= reqPpAtLast) {
              targetK = cand;
            } else {
              break;
            }
          }
          return targetK;
        };

        const inspectOutcome = (
          outState: DynamicState
        ): {valid: boolean; succCount: 0 | 1 | 2; succMask: 0 | 1 | 2 | 3; baseKey: string} | null => {
          if (!outState || !outState.sides) return null;
          if (equalTailwind && outState.sides[0].tailwindTurns !== outState.sides[1].tailwindTurns) {
            return {valid: false, succCount: 0, succMask: 0, baseKey: ''};
          }
          if (inertTerrain && outState.field.terrain !== '' && outState.field.terrain !== f.terrain) {
            return {valid: false, succCount: 0, succMask: 0, baseKey: ''};
          }
          const team = outState.sides[stallingSide].pokemon;
          let succ = 0;
          let succMask = 0;
          for (let t = 0; t < stallingPokeIdxs.length; t++) {
            const outP = team[stallingPokeIdxs[t]];
            if (!outP || outP.fainted) continue;
            const expectedSucc = Math.min(6, stallingStreaks[t] + 1);
            if (outP.protectStreak === expectedSucc) {
              succ++;
              succMask |= 1 << t;
            } else if (outP.protectStreak > 0) {
              return {valid: false, succCount: 0, succMask: 0, baseKey: ''};
            }
          }
          const succCount: 0 | 1 | 2 = succ === 2 ? 2 : succ === 1 ? 1 : 0;
          if (succCount === stallSlotsCount && outState.phase.kind === 'turn') {
            return {
              valid: true,
              succCount,
              succMask: succMask as 0 | 1 | 2 | 3,
              baseKey: canonicalStateKey(ctx, outState, undefined, true, undefined, 0, stallBits, equalTailwind, inertTerrain),
            };
          }
          return {valid: true, succCount, succMask: succMask as 0 | 1 | 2 | 3, baseKey: ''};
        };

        return {
          stallingSide,
          stallSlotsCount,
          streak,
          streaks,
          baseKey,
          ...(equalTailwind ? {equalTailwind: true} : {}),
          stallActionCount,
          stallActionMask,
          isOpponentActionEligible,
          maxSafeStreak,
          inspectOutcome,
        };
      }
    : undefined;

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
    jointMonoPpSignature,
    protectContractionInfo,
    terminalUtility(state: DynamicState): number | null {
      return terminalUtilityFromState(state);
    },
    legalActions(state: DynamicState, side: number): EngineActionEntry[] {
      const sideIdx: 0 | 1 = side === 0 ? 0 : 1;
      const raw = legalSideActions(ctx, state, sideIdx);
      if (ctx.activeCount > 1 && state.phase.kind === 'turn' && raw.length > 1) {
        const scorer = createDoublesActionScorer(ctx, state, sideIdx);
        const decorated = raw.map((sa, idx) => ({
          sa,
          idx,
          score: scorer(sa),
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
      turnOptions: {deadline?: number; actions1?: EngineActionEntry[]; actions2?: EngineActionEntry[]} = {}
    ) {
      let stepOutcomes: Array<{state: DynamicState; probability: number}>;
      let simulatorRuns = 1;
      let cacheHits = 0;
      let actionObs: ActionObservation | undefined;
      const useCache = ppTemplateCache !== null && state.phase.kind === 'turn';
      const tplKey = useCache
        ? `${canonicalStateKey(ctx, state, undefined, true, undefined, 0, protectMaskForTurn(state, p1Action.sideAction, p2Action.sideAction))}|${p1Action.id}|${p2Action.id}`
        : '';
      const cached = useCache ? ppTemplateCache.get(tplKey) : undefined;
      if (cached && cached.complete) {
        stepOutcomes = instantiateCachedOutcomes(state, cached);
        actionObs = cached.actionObs;
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
        actionObs = res.actionObs;
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
        if (useCache) storePpTemplate(tplKey, state, stepOutcomes, 0, true, actionObs);
      }

      const equivalentRows = computeEquivalentSideIndices(state, 0, p1Action, turnOptions?.actions1, actionObs);
      const equivalentCols = computeEquivalentSideIndices(state, 1, p2Action, turnOptions?.actions2, actionObs);

      return {
        outcomes: formatStepOutcomes(state, stepOutcomes),
        simulatorRuns,
        cacheHits,
        complete: true,
        ...(equivalentRows ? {equivalentRows} : {}),
        ...(equivalentCols ? {equivalentCols} : {}),
      };
    },
  };

  if (enableProgressive) {
    adapter.createTurnCursor = (
      state: DynamicState,
      p1Action: EngineActionEntry,
      p2Action: EngineActionEntry,
      turnOptions: {deadline?: number; tolerance?: number; actions1?: EngineActionEntry[]; actions2?: EngineActionEntry[]} = {}
    ) => {
      const tol = turnOptions?.tolerance ?? 0.02;
      const maxDeferredMass = tol > 0 ? Math.min(0.004, tol * 0.1) : 0;
      const deferMinProb = maxDeferredMass > 0 ? Math.min(0.0012, maxDeferredMass * 0.4) : 0;
      const useCache = ppTemplateCache !== null && state.phase.kind === 'turn';
      const tplKey = useCache
        ? `${canonicalStateKey(ctx, state, undefined, true, undefined, 0, protectMaskForTurn(state, p1Action.sideAction, p2Action.sideAction))}|${p1Action.id}|${p2Action.id}`
        : '';
      let stage: 0 | 1 | 2 = 0;
      let lastOutcomes: (Outcome | MonotoneBoxOutcome)[] = [];
      let lastRemaining = 1;

      const eqForObs = (obs: ActionObservation | undefined) => {
        if (!obs) return {};
        const equivalentRows = computeEquivalentSideIndices(state, 0, p1Action, turnOptions?.actions1, obs);
        const equivalentCols = computeEquivalentSideIndices(state, 1, p2Action, turnOptions?.actions2, obs);
        return {
          ...(equivalentRows ? {equivalentRows} : {}),
          ...(equivalentCols ? {equivalentCols} : {}),
        };
      };

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
            lastOutcomes = formatStepOutcomes(state, instantiateCachedOutcomes(state, cached));
            lastRemaining = 0;
            stage = 2;
            return {
              outcomes: lastOutcomes,
              remainingProbability: 0,
              simulatorRuns: 0,
              cacheHits: 1,
              complete: true,
              ...eqForObs(cached.actionObs),
            };
          }

          if (stage === 0 && maxDeferredMass > 0) {
            if (cached) {
              lastOutcomes = formatStepOutcomes(state, instantiateCachedOutcomes(state, cached));
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
            const obs = isComplete ? res.actionObs : undefined;
            if (hasBench) {
              const resolved = resolveForcedSwitches(ctx, outList, remMass, isComplete, hpOutputMode, deadline);
              outList = resolved.outcomes;
              remMass = resolved.remainingMass;
              isComplete = resolved.complete;
              simRuns += resolved.extraRuns;
            }
            const finalObs = isComplete ? obs : undefined;
            const deadlineHit = deadline !== undefined && performance.now() >= deadline && remMass > maxDeferredMass + 1e-6;
            if (!deadlineHit && useCache) {
              storePpTemplate(tplKey, state, outList, remMass, isComplete, finalObs);
            }
            lastOutcomes = formatStepOutcomes(state, outList);
            lastRemaining = isComplete ? 0 : Math.min(1, Math.max(0, remMass));
            stage = isComplete ? 2 : 1;
            return {
              outcomes: lastOutcomes,
              remainingProbability: lastRemaining,
              simulatorRuns: simRuns,
              complete: isComplete,
              ...eqForObs(finalObs),
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
          const obs = isComplete ? res.actionObs : undefined;
          if (hasBench) {
            const resolved = resolveForcedSwitches(ctx, outList, remMass, isComplete, hpOutputMode, deadline);
            outList = resolved.outcomes;
            remMass = resolved.remainingMass;
            isComplete = resolved.complete;
            simRuns += resolved.extraRuns;
          }
          if (isComplete) {
            if (useCache) storePpTemplate(tplKey, state, outList, 0, true, obs);
            lastOutcomes = formatStepOutcomes(state, outList);
            lastRemaining = 0;
            stage = 2;
            return {
              outcomes: lastOutcomes,
              remainingProbability: 0,
              simulatorRuns: simRuns,
              complete: true,
              ...eqForObs(obs),
            };
          }
          // Deadline hit during exact refinement: keep sound partial distribution.
          if (outList.length > 0) {
            lastOutcomes = formatStepOutcomes(state, outList);
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
