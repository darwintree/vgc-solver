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
  MoveSpecialKind,
  SideAction,
  StaticBattleContext,
  StaticPokemonData,
} from './types';

export interface EngineActionEntry extends Action {
  sideAction: SideAction;
}

export interface EngineAdapterOptions {
  hpOutputMode?: HpOutputMode;
}

const GLOBAL_NON_MONOTONE_MOVES = new Set<MoveSpecialKind>([
  'pain-split',
  'copycat',
  'transform',
  'sleep-talk',
  'skill-swap',
  'role-play',
  'entrainment',
  'worry-seed',
  'simple-beam',
  'gastro-acid',
]);

const SELF_NON_MONOTONE_MOVES = new Set<MoveSpecialKind>([
  'flail',
  'endeavor',
  'rest',
]);

const BERRY_RESTORE_OR_TRANSFER_MOVES = new Set<MoveSpecialKind>([
  'recycle',
  'trick',
  'steal-item',
  'steal-berry',
  'teatime',
]);

const SELF_HEAL_MOVES = new Set<MoveSpecialKind>([
  'heal-half',
  'roost',
  'heal-weather',
  'rest',
  'wish',
  'swallow',
  'aqua-ring',
  'ingrain',
  'leech-seed',
  'strength-sap',
  'pain-split',
  'pollen-puff',
  'heal-pulse',
  'healing-wish',
  'revival-blessing',
  'set-terrain',
]);

function abilityMutatesAbilities(ab: CompiledAbilitySpec): boolean {
  return !!(ab.mummy || ab.wanderingSpirit || ab.trace || ab.imposter || ab.receiver);
}

function abilityRestoresOrTransfersBerry(ab: CompiledAbilitySpec): boolean {
  return !!(ab.harvest || ab.magician || ab.pickpocket || ab.symbiosis);
}

function abilityCanHeal(ab: CompiledAbilitySpec): boolean {
  return !!(
    ab.rainDish ||
    ab.iceBody ||
    ab.drySkin ||
    ab.poisonHeal ||
    ab.immuneHealQuarter ||
    ab.regenerator ||
    ab.hospitality ||
    ab.setsTerrain === 'grassy' ||
    ab.seedSower ||
    ab.cheekPouch
  );
}

function allStaticAbilities(sp: StaticPokemonData): CompiledAbilitySpec[] {
  return sp.megaForme ? [sp.abilitySpec, sp.megaForme.abilitySpec] : [sp.abilitySpec];
}

function sideHasMoveOfTypeOrDynamic(sp: StaticPokemonData, targetType: string, ab: CompiledAbilitySpec): boolean {
  for (const m of sp.moves) {
    if (m.category === 'Status') continue;
    if (m.type === targetType) return true;
    if (m.specialKind === 'weather-ball' || m.specialKind === 'terrain-pulse' ||
        m.specialKind === 'aura-wheel' || m.specialKind === 'raging-bull') return true;
    if (ab.liquidVoice && targetType === 'Water' && m.sound) return true;
    if (ab.ateType === targetType && m.type === 'Normal') return true;
  }
  return false;
}

/**
 * Build a strictly sound HP-monotonicity signature function for 1v1 singles
 * battles. For any two turn-phase states in the same `groupKey`:
 * - higher `h1` (when non-null) is guaranteed to have value >= lower `h1`
 * - lower `h2` (when non-null) is guaranteed to have value >= higher `h2`
 *
 * Any mechanic that can invert HP ordering (HP-threshold berries while active,
 * pinch/half-HP abilities while HP > threshold or healing remains possible,
 * Flail/Endeavor/Pain Split/Hard Press/Rest/Drain/Shell Bell, or ability/berry
 * mutators) conservatively disables the affected axis (returning null for it).
 */
export interface MonotoneAnalyzer {
  anyAxisAllowed: boolean;
  isHpMonotone: (state: DynamicState, s: 0 | 1, hp: number) => boolean;
  monotoneSignature: (state: DynamicState) => MonotoneSignature | null;
}

export function createMonotoneAnalyzer(ctx: StaticBattleContext): MonotoneAnalyzer {
  const disabled: MonotoneAnalyzer = {
    anyAxisAllowed: false,
    isHpMonotone: () => false,
    monotoneSignature: () => null,
  };
  if (ctx.activeCount !== 1 || ctx.sides[0].team.length !== 1 || ctx.sides[1].team.length !== 1) {
    return disabled;
  }

  const sp: [StaticPokemonData, StaticPokemonData] = [ctx.sides[0].team[0], ctx.sides[1].team[0]];

  // Global disqualifiers (ability copy/swap, move copy, symmetric HP inversion)
  let battleHasHpBerry = false;
  let battleHasBerryRestore = false;
  for (let s = 0; s < 2; s++) {
    const mon = sp[s];
    if (mon.itemSpec.archetype === 'sitrus-berry' || mon.itemSpec.archetype === 'oran-berry') {
      battleHasHpBerry = true;
    }
    for (const m of mon.moves) {
      if (GLOBAL_NON_MONOTONE_MOVES.has(m.specialKind)) return disabled;
      if (BERRY_RESTORE_OR_TRANSFER_MOVES.has(m.specialKind)) battleHasBerryRestore = true;
    }
    for (const ab of allStaticAbilities(mon)) {
      if (abilityMutatesAbilities(ab)) return disabled;
      if (abilityRestoresOrTransfersBerry(ab)) battleHasBerryRestore = true;
    }
  }

  // If a berry exists and any restore/transfer mechanic exists, neither side can
  // safely treat a consumed berry as permanently gone.
  if (battleHasHpBerry && battleHasBerryRestore) {
    return disabled;
  }

  const staticAxisAllowed: [boolean, boolean] = [true, true];
  const canHealWithoutBerry: [boolean, boolean] = [false, false];

  for (let s = 0; s < 2; s++) {
    const self = sp[s];
    const foe = sp[1 - s];

    for (const m of self.moves) {
      if (SELF_NON_MONOTONE_MOVES.has(m.specialKind)) staticAxisAllowed[s] = false;
      if (SELF_HEAL_MOVES.has(m.specialKind) || m.drain !== null) canHealWithoutBerry[s] = true;
    }
    if (self.itemSpec.archetype === 'leftovers' || self.itemSpec.archetype === 'shell-bell') {
      canHealWithoutBerry[s] = true;
    }
    for (const ab of allStaticAbilities(self)) {
      if (abilityCanHeal(ab)) canHealWithoutBerry[s] = true;
    }

    for (const m of foe.moves) {
      if (m.specialKind === 'hard-press' || m.drain !== null) staticAxisAllowed[s] = false;
      if (m.specialKind === 'set-terrain' || m.specialKind === 'heal-pulse' || m.specialKind === 'pollen-puff') {
        canHealWithoutBerry[s] = true;
      }
    }
    if (foe.itemSpec.archetype === 'shell-bell') {
      staticAxisAllowed[s] = false;
    }
    for (const ab of allStaticAbilities(foe)) {
      if (ab.setsTerrain === 'grassy' || ab.seedSower) canHealWithoutBerry[s] = true;
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
    const hasActiveHpBerry = !!itemSpec && (itemSpec.archetype === 'sitrus-berry' || itemSpec.archetype === 'oran-berry');
    if (hasActiveHpBerry || p.cudchewBerry !== '') return false;

    const canHealNow =
      canHealWithoutBerry[s] ||
      state.field.terrain === 'grassy' ||
      p.aquaRing ||
      p.ingrain ||
      side.wishTurns[0] > 0 ||
      state.sides[1 - s].pokemon[0].leechSeedSlot >= 0;

    const checkAbility = (ab: CompiledAbilitySpec): boolean => {
      if (ab.pinchType && sideHasMoveOfTypeOrDynamic(mon, ab.pinchType, ab)) {
        if (hp > Math.floor(mon.maxhp / 3) || canHealNow) return false;
      }
      if (ab.berserk || ab.shieldsDown || ab.gulpMissile || ab.emergencyExit) {
        if (hp > Math.floor(mon.maxhp / 2) || canHealNow) return false;
      }
      if (ab.galeWings) {
        if (hp >= mon.maxhp || canHealNow) return false;
      }
      return true;
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
    monotoneSignature,
  };
}

export function createMonotoneSignature(
  ctx: StaticBattleContext
): (state: DynamicState) => MonotoneSignature | null {
  return createMonotoneAnalyzer(ctx).monotoneSignature;
}

function materializeHpPair(baseState: DynamicState, hp0: number, hp1: number): DynamicState {
  const st = cloneState(baseState);
  const p0 = st.sides[0].pokemon[0];
  p0.hp = hp0;
  p0.hpDist = null;
  p0.fainted = hp0 <= 0;
  const p1 = st.sides[1].pokemon[0];
  p1.hp = hp1;
  p1.hpDist = null;
  p1.fainted = hp1 <= 0;
  return st;
}

interface HpAxisChunk {
  entries: HpEntry[];
  sum: number;
}

function partitionMonotoneAxis(
  state: DynamicState,
  side: 0 | 1,
  dist: HpEntry[],
  isHpMonotone: (state: DynamicState, s: 0 | 1, hp: number) => boolean
): HpAxisChunk[] {
  const chunks: HpAxisChunk[] = [];
  let monoEntries: HpEntry[] | null = null;
  let monoSum = 0;
  for (const e of dist) {
    if (isHpMonotone(state, side, e.hp)) {
      if (!monoEntries) monoEntries = [];
      monoEntries.push(e);
      monoSum += e.prob;
    } else {
      chunks.push({entries: [e], sum: e.prob});
    }
  }
  if (monoEntries && monoEntries.length > 0) {
    chunks.push({entries: monoEntries, sum: monoSum});
  }
  return chunks;
}

function makeBoxOrSingleton(
  baseState: DynamicState,
  probability: number,
  e0: HpEntry[],
  e1: HpEntry[]
): Outcome | MonotoneBoxOutcome {
  if (e0.length === 1 && e1.length === 1) {
    return {
      snapshot: materializeHpPair(baseState, e0[0].hp, e1[0].hp) as any,
      probability,
    };
  }
  // Worst corner for P1: smallest h1, largest h2. Best corner for P1: largest h1, smallest h2.
  const lowerSnapshot = materializeHpPair(baseState, e0[0].hp, e1[e1.length - 1].hp) as any;
  const upperSnapshot = materializeHpPair(baseState, e0[e0.length - 1].hp, e1[0].hp) as any;
  return {
    probability,
    lowerSnapshot,
    upperSnapshot,
    split: () => {
      if (e0.length >= e1.length) {
        const mid = e0.length >>> 1;
        const left = e0.slice(0, mid);
        const right = e0.slice(mid);
        let sL = 0;
        for (const e of left) sL += e.prob;
        let sR = 0;
        for (const e of right) sR += e.prob;
        const total = sL + sR;
        return [
          makeBoxOrSingleton(baseState, probability * (sL / total), left, e1),
          makeBoxOrSingleton(baseState, probability * (sR / total), right, e1),
        ];
      }
      const mid = e1.length >>> 1;
      const left = e1.slice(0, mid);
      const right = e1.slice(mid);
      let sL = 0;
      for (const e of left) sL += e.prob;
      let sR = 0;
      for (const e of right) sR += e.prob;
      const total = sL + sR;
      return [
        makeBoxOrSingleton(baseState, probability * (sL / total), e0, left),
        makeBoxOrSingleton(baseState, probability * (sR / total), e0, right),
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
  const useMonotoneBoxes = options.hpOutputMode === undefined && analyzer.anyAxisAllowed;
  const hpOutputMode: HpOutputMode = useMonotoneBoxes ? 'distributional' : (options.hpOutputMode ?? 'discrete');

  const isDynamicState = (value: any): value is DynamicState =>
    !!value && typeof value === 'object' && 'field' in value && 'sides' in value && 'phase' in value;

  return {
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
    terminalUtility(state: DynamicState): number | null {
      return terminalUtilityFromState(state);
    },
    legalActions(state: DynamicState, side: number): EngineActionEntry[] {
      const sideIdx: 0 | 1 = side === 0 ? 0 : 1;
      return legalSideActions(ctx, state, sideIdx).map(sa => formatSideAction(ctx, state, sideIdx, sa));
    },
    enumerateTurn(
      state: DynamicState,
      p1Action: EngineActionEntry,
      p2Action: EngineActionEntry,
      turnOptions: {deadline?: number} = {}
    ) {
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
      if (!useMonotoneBoxes) {
        const outcomes = res.outcomes.map(o => {
          const utility = terminalUtilityFromState(o.state);
          if (utility !== null) {
            return {utility, probability: o.probability} as const;
          }
          return {snapshot: o.state as any, probability: o.probability} as const;
        }) as Outcome[];
        return {
          outcomes,
          simulatorRuns: res.stats.forks + 1,
          complete: true,
        };
      }

      const outcomes: (Outcome | MonotoneBoxOutcome)[] = [];
      for (const o of res.outcomes) {
        const utility = terminalUtilityFromState(o.state);
        if (utility !== null) {
          outcomes.push({utility, probability: o.probability});
          continue;
        }
        const p0 = o.state.sides[0].pokemon[0];
        const p1 = o.state.sides[1].pokemon[0];
        const d0: HpEntry[] = p0.hpDist ?? [{hp: p0.hp, prob: 1}];
        const d1: HpEntry[] = p1.hpDist ?? [{hp: p1.hp, prob: 1}];
        if (o.state.phase.kind !== 'turn' || d0.some(e => e.hp <= 0) || d1.some(e => e.hp <= 0)) {
          for (const ws of expandStateHpDists(o)) {
            const u = terminalUtilityFromState(ws.state);
            if (u !== null) outcomes.push({utility: u, probability: ws.probability});
            else outcomes.push({snapshot: ws.state as any, probability: ws.probability});
          }
          continue;
        }
        const chunks0 = partitionMonotoneAxis(o.state, 0, d0, analyzer.isHpMonotone);
        const chunks1 = partitionMonotoneAxis(o.state, 1, d1, analyzer.isHpMonotone);
        for (const c0 of chunks0) {
          for (const c1 of chunks1) {
            const boxProb = o.probability * c0.sum * c1.sum;
            if (boxProb <= 0) continue;
            outcomes.push(makeBoxOrSingleton(o.state, boxProb, c0.entries, c1.entries));
          }
        }
      }
      return {
        outcomes,
        simulatorRuns: res.stats.forks + 1,
        complete: true,
      };
    },
  };
}
