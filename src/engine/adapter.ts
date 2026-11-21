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
 * Build a strictly sound HP-monotonicity analyzer for 1v1 singles battles from
 * co-located fail-closed optimization traits on moves, abilities, and items.
 * For any two turn-phase states in the same `groupKey`:
 * - higher `h1` (when non-null) is guaranteed to have value >= lower `h1`
 * - lower `h2` (when non-null) is guaranteed to have value >= higher `h2`
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

  let battleHasHpBerry = false;
  let battleHasBerryMutator = false;
  for (let s = 0; s < 2; s++) {
    const mon = sp[s];
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

  if (battleHasHpBerry && battleHasBerryMutator) {
    return disabled;
  }

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
      // In 1v1 singles (team.length === 1), a drain move only heals less when it KOs
      // the target, which immediately gives target minimum utility (-1) unless target
      // can counter-KO the attacker on contact/faint or attacker takes self-recoil.
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
          // Emergency Exit / Wimp Out never trigger in 1v1 singles (team.length === 1).
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
  let prevHp = -1;
  const flushMono = () => {
    if (monoEntries && monoEntries.length > 0) {
      chunks.push({entries: monoEntries, sum: monoSum});
      monoEntries = null;
      monoSum = 0;
    }
  };
  for (const e of dist) {
    if (isHpMonotone(state, side, e.hp)) {
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
      chunks.push({entries: [e], sum: e.prob});
    }
  }
  flushMono();
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
    if (!useMonotoneBoxes) {
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
      return legalSideActions(ctx, state, sideIdx).map(sa => formatSideAction(ctx, state, sideIdx, sa));
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
        stepOutcomes = res.outcomes;
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
            const deadlineHit = deadline !== undefined && performance.now() >= deadline && res.remainingMass > maxDeferredMass + 1e-6;
            if (!deadlineHit && useCache) {
              storePpTemplate(tplKey, state, res.outcomes, res.remainingMass, res.complete);
            }
            lastOutcomes = formatStepOutcomes(res.outcomes);
            lastRemaining = res.complete ? 0 : Math.min(1, Math.max(0, res.remainingMass));
            stage = res.complete ? 2 : 1;
            return {
              outcomes: lastOutcomes,
              remainingProbability: lastRemaining,
              simulatorRuns: res.stats.forks + 1,
              complete: res.complete,
            };
          }

          // Stage 1 (or tolerance === 0): run full exact stepBattle.
          const res = stepBattle(ctx, state, p1Action.sideAction, p2Action.sideAction, {
            mode: 'certified',
            hpOutputMode,
            deadline,
          });
          if (res.complete) {
            if (useCache) storePpTemplate(tplKey, state, res.outcomes, 0, true);
            lastOutcomes = formatStepOutcomes(res.outcomes);
            lastRemaining = 0;
            stage = 2;
            return {
              outcomes: lastOutcomes,
              remainingProbability: 0,
              simulatorRuns: res.stats.forks + 1,
              complete: true,
            };
          }
          // Deadline hit during exact refinement: keep sound partial distribution.
          if (res.outcomes.length > 0) {
            lastOutcomes = formatStepOutcomes(res.outcomes);
            lastRemaining = Math.min(1, Math.max(0, res.remainingMass));
          }
          return {
            outcomes: lastOutcomes,
            remainingProbability: lastRemaining,
            simulatorRuns: res.stats.forks + 1,
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
