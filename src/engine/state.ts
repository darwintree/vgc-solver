import type {Battle} from '@pkmn/sim';
import {toID} from '@pkmn/sim';
import {compileAbilitySpec, type CompiledAbilitySpec} from './effects/abilities';
import {compileItemSpec, type CompiledItemSpec} from './effects/items';
import {compileMoveSpec} from './effects/moves';
import {
  FeatureBit,
  type BattlePhase,
  type BoostArray,
  type DynamicState,
  type HpDist,
  type HpEntry,
  type MoveAction,
  type PendingQueuedAction,
  type PokemonState,
  type SideAction,
  type SideState,
  type SlotAction,
  type StaticBattleContext,
  type StaticMoveData,
  type StaticPokemonData,
  type StaticStats,
  type StatusId,
  type TerrainId,
  type WeatherId,
  type WeightedState,
} from './types';

const EPS = 1e-15;

export function getItemSpec(ctx: StaticBattleContext, itemId: string): CompiledItemSpec {
  const id = toID(itemId);
  let spec = ctx.itemSpecCache.get(id);
  if (!spec) {
    spec = compileItemSpec(ctx.dex, id);
    ctx.itemSpecCache.set(id, spec);
  }
  return spec;
}

export function activeItemId(sp: StaticPokemonData, p: PokemonState): string {
  if (!p.itemActive) return '';
  return p.itemOverride !== null ? p.itemOverride : sp.itemId;
}

export function activeItemSpec(ctx: StaticBattleContext, sp: StaticPokemonData, p: PokemonState): CompiledItemSpec {
  if (!p.itemActive) return getItemSpec(ctx, '');
  if (p.itemOverride !== null) return getItemSpec(ctx, p.itemOverride);
  return sp.itemSpec;
}

export function activeSpeciesId(sp: StaticPokemonData, p: PokemonState): string {
  if (p.transformed) return p.transformed.speciesId;
  if (p.formeId && sp.altFormes[p.formeId]) return sp.altFormes[p.formeId].speciesId;
  return p.megaEvolved && sp.megaForme ? sp.megaForme.speciesId : sp.speciesId;
}

export function activeMoves(sp: StaticPokemonData, p: PokemonState): readonly StaticMoveData[] {
  return p.transformed ? p.transformed.moves : sp.moves;
}

export function activeStats(sp: StaticPokemonData, p: PokemonState): StaticStats {
  let s: StaticStats = p.transformed
    ? p.transformed.stats
    : p.formeId && sp.altFormes[p.formeId]
      ? sp.altFormes[p.formeId].stats
      : p.megaEvolved && sp.megaForme
        ? sp.megaForme.stats
        : sp.stats;
  if (p.statOverride) {
    s = {
      atk: p.statOverride.atk ?? s.atk,
      def: p.statOverride.def ?? s.def,
      spa: p.statOverride.spa ?? s.spa,
      spd: p.statOverride.spd ?? s.spd,
      spe: p.statOverride.spe ?? s.spe,
    };
  }
  if (p.powerTrick) {
    return {atk: s.def, def: s.atk, spa: s.spa, spd: s.spd, spe: s.spe};
  }
  return s;
}

export function activeAbilitySpec(sp: StaticPokemonData, p: PokemonState): CompiledAbilitySpec {
  if (p.abilityOverride !== null) return compileAbilitySpec(p.abilityOverride);
  if (p.transformed) return compileAbilitySpec(p.transformed.abilityId);
  if (p.formeId && sp.altFormes[p.formeId]) return sp.altFormes[p.formeId].abilitySpec;
  return p.megaEvolved && sp.megaForme ? sp.megaForme.abilitySpec : sp.abilitySpec;
}

export function activeTypes(sp: StaticPokemonData, p: PokemonState): readonly string[] {
  const base = p.types ?? (
    p.transformed
      ? p.transformed.types
      : p.formeId && sp.altFormes[p.formeId]
        ? sp.altFormes[p.formeId].types
        : p.megaEvolved && sp.megaForme
          ? sp.megaForme.types
          : sp.baseTypes
  );
  if (!p.roosted) return base;
  const filtered = base.filter(t => t !== 'Flying');
  return filtered.length > 0 ? filtered : ['Normal'];
}

export function activeWeightHg(sp: StaticPokemonData, p: PokemonState): number {
  const kg = p.transformed
    ? p.transformed.weightkg
    : p.formeId && sp.altFormes[p.formeId]
      ? sp.altFormes[p.formeId].weightkg
      : p.megaEvolved && sp.megaForme
        ? sp.megaForme.weightkg
        : sp.weightkg;
  let hg = Math.max(1, Math.round(kg * 10));
  if (p.abilityActive && !p.gastroAcid) {
    const ab = activeAbilitySpec(sp, p);
    if (ab.heavyMetal) hg *= 2;
    else if (ab.lightMetal) hg = Math.max(1, Math.trunc(hg / 2));
  }
  return hg;
}

export function isItemEffectActive(state: DynamicState, sp: StaticPokemonData, p: PokemonState): boolean {
  if (!p.itemActive || activeItemId(sp, p) === '' || state.field.magicRoomTurns > 0) return false;
  if (p.abilityActive && !p.gastroAcid && activeAbilitySpec(sp, p).klutz) return false;
  return true;
}

export function isGrounded(sp: StaticPokemonData, p: PokemonState, state?: DynamicState): boolean {
  if (p.ingrain || p.smackedDown || (state && state.field.gravityTurns > 0)) return true;
  const curItemId = activeItemId(sp, p);
  const itemActiveNow = curItemId !== '' && (!state || isItemEffectActive(state, sp, p));
  if (itemActiveNow && curItemId === 'ironball') return true;
  if (activeTypes(sp, p).includes('Flying')) return false;
  const ab = activeAbilitySpec(sp, p);
  if (p.abilityActive && !p.gastroAcid && ab.immuneType === 'Ground') return false;
  if (p.magnetRiseTurns > 0) return false;
  if (itemActiveNow && curItemId === 'airballoon') return false;
  return true;
}

export function cloneBoosts(b: BoostArray): BoostArray {
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6]];
}

export function cloneHpDist(dist: HpDist | null): HpDist | null {
  if (!dist) return null;
  const out: HpEntry[] = new Array(dist.length);
  for (let i = 0; i < dist.length; i++) {
    out[i] = {hp: dist[i].hp, prob: dist[i].prob};
  }
  return out;
}

export function clonePokemon(p: PokemonState): PokemonState {
  return {
    hp: p.hp,
    hpDist: cloneHpDist(p.hpDist),
    fainted: p.fainted,
    pp: p.pp.slice(),
    status: p.status,
    statusTurns: p.statusTurns,
    boosts: cloneBoosts(p.boosts),
    itemActive: p.itemActive,
    itemOverride: p.itemOverride,
    lastItemId: p.lastItemId,
    ateBerry: p.ateBerry,
    cudchewBerry: p.cudchewBerry,
    cudchewTurns: p.cudchewTurns,
    abilityActive: p.abilityActive,
    abilityOverride: p.abilityOverride,
    gastroAcid: p.gastroAcid,
    abilityUsed: p.abilityUsed,
    megaEvolved: p.megaEvolved,
    formeId: p.formeId,
    bondTriggered: p.bondTriggered,
    illusionActive: p.illusionActive,
    transformed: p.transformed,
    savedPp: p.savedPp ? p.savedPp.slice() : null,
    disguiseBusted: p.disguiseBusted,
    proteanUsed: p.proteanUsed,
    flashFireActive: p.flashFireActive,
    unburdenActive: p.unburdenActive,
    substituteHp: p.substituteHp,
    types: p.types ? p.types.slice() : null,
    protectStreak: p.protectStreak,
    protecting: p.protecting,
    protectKind: p.protectKind,
    enduring: p.enduring,
    roosted: p.roosted,
    flinched: p.flinched,
    mustRecharge: p.mustRecharge,
    confusionTurns: p.confusionTurns,
    attractSide: p.attractSide,
    attractSlot: p.attractSlot,
    magnetRiseTurns: p.magnetRiseTurns,
    lockOnTurns: p.lockOnTurns,
    lockOnSide: p.lockOnSide,
    lockOnSlot: p.lockOnSlot,
    stockpileLayers: p.stockpileLayers,
    stockpileDef: p.stockpileDef,
    stockpileSpd: p.stockpileSpd,
    powerTrick: p.powerTrick,
    statOverride: p.statOverride ? {...p.statOverride} : null,
    usedMovesMask: p.usedMovesMask,
    imprison: p.imprison,
    octolockSide: p.octolockSide,
    octolockSlot: p.octolockSlot,
    uproarTurns: p.uproarTurns,
    encoreMoveIdx: p.encoreMoveIdx,
    encoreTurns: p.encoreTurns,
    tauntTurns: p.tauntTurns,
    throatChopTurns: p.throatChopTurns,
    choiceLockedMoveIdx: p.choiceLockedMoveIdx,
    disabledMoveIdx: p.disabledMoveIdx,
    disabledTurns: p.disabledTurns,
    tormented: p.tormented,
    leechSeedSlot: p.leechSeedSlot,
    yawnTurns: p.yawnTurns,
    cursed: p.cursed,
    perishTurns: p.perishTurns,
    trapped: p.trapped,
    partialTrapTurns: p.partialTrapTurns,
    aquaRing: p.aquaRing,
    ingrain: p.ingrain,
    smackedDown: p.smackedDown,
    focusEnergy: p.focusEnergy,
    dragonCheer: p.dragonCheer,
    charged: p.charged,
    glaiveRush: p.glaiveRush,
    syrupBombTurns: p.syrupBombTurns,
    destinyBond: p.destinyBond,
    noRetreatUsed: p.noRetreatUsed,
    timesAttacked: p.timesAttacked,
    lastMoveFailed: p.lastMoveFailed,
    chargingMoveIdx: p.chargingMoveIdx,
    lockedMoveIdx: p.lockedMoveIdx,
    lockedMoveDuration: p.lockedMoveDuration,
    lockedMoveTrueDuration: p.lockedMoveTrueDuration,
    invulnerable: p.invulnerable,
    lastMoveIdx: p.lastMoveIdx,
    lastMoveId: p.lastMoveId,
    activeTurns: p.activeTurns,
    movedThisTurn: p.movedThisTurn,
    switchedInThisTurn: p.switchedInThisTurn,
    helpingHandCount: p.helpingHandCount,
    redirectKind: p.redirectKind,
    focusPunchReady: p.focusPunchReady,
    focusPunchLost: p.focusPunchLost,
    beakBlastHeating: p.beakBlastHeating,
    electrified: p.electrified,
    emergencyExitTriggered: p.emergencyExitTriggered,
    damagedThisTurn: p.damagedThisTurn,
    damagedCategory: p.damagedCategory,
    damagedBySide: p.damagedBySide,
    damagedBySlot: p.damagedBySlot,
    statLoweredThisTurn: p.statLoweredThisTurn,
  };
}

function cloneSide(s: SideState): SideState {
  return {
    active: s.active.slice(),
    megaUsed: s.megaUsed,
    stealthRock: s.stealthRock,
    spikes: s.spikes,
    toxicSpikes: s.toxicSpikes,
    stickyWeb: s.stickyWeb,
    tailwindTurns: s.tailwindTurns,
    reflectTurns: s.reflectTurns,
    lightScreenTurns: s.lightScreenTurns,
    auroraVeilTurns: s.auroraVeilTurns,
    safeguardTurns: s.safeguardTurns,
    wishTurns: s.wishTurns.slice(),
    wishHp: s.wishHp.slice(),
    healingWish: s.healingWish.slice(),
    futureMoves: s.futureMoves.map(fm => (fm ? {...fm} : null)),
    wideGuard: s.wideGuard,
    quickGuard: s.quickGuard,
    roundUsedThisTurn: s.roundUsedThisTurn,
    pokemon: s.pokemon.map(clonePokemon),
  };
}

function clonePendingAction(a: PendingQueuedAction): PendingQueuedAction {
  return {
    side: a.side,
    action: {...a.action},
    priority: a.priority,
    speed: a.speed,
    subOrder: a.subOrder,
  };
}

function clonePhase(phase: BattlePhase): BattlePhase {
  if (phase.kind === 'turn') return {kind: 'turn'};
  if (phase.kind === 'ended') return {kind: 'ended', winner: phase.winner};
  return {
    kind: 'switch',
    pendingSlots: phase.pendingSlots.map(p => ({...p})),
    remainingActions: phase.remainingActions.map(clonePendingAction),
    needsEndOfTurn: phase.needsEndOfTurn,
  };
}

export function cloneState(state: DynamicState): DynamicState {
  return {
    field: {...state.field},
    sides: [cloneSide(state.sides[0]), cloneSide(state.sides[1])],
    phase: clonePhase(state.phase),
  };
}

function stallCounterToStreak(counter: number | undefined): number {
  if (!counter || counter <= 1) return 0;
  let streak = 0;
  let c = 1;
  while (c < counter && streak < 6) {
    c *= 3;
    streak++;
  }
  return streak;
}

function importWeather(raw: string | undefined): WeatherId {
  switch (toID(raw || '')) {
    case 'sunnyday': return 'sun';
    case 'raindance': return 'rain';
    case 'sandstorm': return 'sand';
    case 'snowscape':
    case 'snow':
    case 'hail': return 'snow';
    default: return '';
  }
}

function importTerrain(raw: string | undefined): TerrainId {
  switch (toID(raw || '')) {
    case 'electricterrain': return 'electric';
    case 'grassyterrain': return 'grassy';
    case 'mistyterrain': return 'misty';
    case 'psychicterrain': return 'psychic';
    default: return '';
  }
}

export function stateFromBattle(ctx: StaticBattleContext, battle: Battle): DynamicState {
  const importSide = (sideIdx: 0 | 1): SideState => {
    const rawSide = battle.sides[sideIdx];
    const staticSide = ctx.sides[sideIdx];
    // Showdown reorders side.pokemon[] on switch-in (moving active to slot 0).
    // Match each runtime Pokemon back to its fixed index in staticSide.team.
    const used = new Set<number>();
    const rawToTeamIdx = new Map<any, number>();
    for (const rp of rawSide.pokemon) {
      const rpSpecies = rp.species.id === 'mimikyubusted' ? 'mimikyu' : toID(rp.species.id);
      const rpBase = toID(rp.baseSpecies?.id || rp.species.baseSpecies || rpSpecies);
      let matchIdx = staticSide.team.findIndex(
        (sp, idx) => !used.has(idx) && sp.name === rp.name &&
          (sp.speciesId === rpSpecies || sp.speciesId === rpBase || sp.megaForme?.speciesId === rpSpecies)
      );
      if (matchIdx < 0) {
        matchIdx = staticSide.team.findIndex(
          (sp, idx) => !used.has(idx) &&
            (sp.speciesId === rpSpecies || sp.speciesId === rpBase || sp.megaForme?.speciesId === rpSpecies)
        );
      }
      if (matchIdx < 0) {
        matchIdx = staticSide.team.findIndex((_, idx) => !used.has(idx));
      }
      used.add(matchIdx);
      rawToTeamIdx.set(rp, matchIdx);
    }

    const active: number[] = [];
    for (let slot = 0; slot < ctx.activeCount; slot++) {
      const p = rawSide.active[slot];
      const idx = p ? (rawToTeamIdx.get(p) ?? -1) : -1;
      active.push(idx);
    }

    let megaUsed = false;
    const pokemon: PokemonState[] = new Array(staticSide.team.length);
    for (const p of rawSide.pokemon) {
      const idx = rawToTeamIdx.get(p)!;
      const sp = staticSide.team[idx];
      const isTransformed = !!(p as any).transformed;
      const pp = isTransformed
        ? p.moveSlots.map(ms => ms.pp ?? 0)
        : sp.moves.map((_, mi) => p.moveSlots[mi]?.pp ?? 0);
      const b = p.boosts;
      const boosts: BoostArray = [
        b.atk || 0, b.def || 0, b.spa || 0, b.spd || 0, b.spe || 0, b.accuracy || 0, b.evasion || 0,
      ];
      const stall = p.volatiles?.stall;
      const encore = p.volatiles?.encore;
      const taunt = p.volatiles?.taunt;
      const throatChop = p.volatiles?.throatchop;
      const sub = p.volatiles?.substitute;
      const choiceLock = p.volatiles?.choicelock;
      const disable = p.volatiles?.disable;
      const leech = p.volatiles?.leechseed;
      const yawn = p.volatiles?.yawn;
      const perish = p.volatiles?.perishsong;
      const pTrap = p.volatiles?.partiallytrapped;
      const syrup = p.volatiles?.syrupbomb;
      const dragonCheer = p.volatiles?.dragoncheer;

      let encoreMoveIdx = -1;
      let encoreTurns = 0;
      if (encore?.move) {
        encoreMoveIdx = sp.moves.findIndex(m => m.id === toID(encore.move));
        encoreTurns = encore.duration || 0;
      }
      let choiceLockedMoveIdx = -1;
      if (choiceLock?.move) {
        choiceLockedMoveIdx = sp.moves.findIndex(m => m.id === toID(choiceLock.move));
      }
      let disabledMoveIdx = -1;
      let disabledTurns = 0;
      if (disable?.move) {
        disabledMoveIdx = sp.moves.findIndex(m => m.id === toID(disable.move));
        disabledTurns = disable.duration || 0;
      }
      let lastMoveIdx = -1;
      if (p.lastMove?.id) {
        const lmId = toID(p.lastMove.id);
        if (lmId === 'struggle') lastMoveIdx = -2;
        else lastMoveIdx = sp.moves.findIndex(m => m.id === lmId);
      }

      const megaEvolved = !!sp.megaForme && (p.species.isMega || toID(p.species.id) === sp.megaForme.speciesId);
      if (megaEvolved) megaUsed = true;

      const curSpeciesId = toID(p.species.id);
      const formeId: string | null = !isTransformed && !megaEvolved && curSpeciesId !== sp.speciesId && sp.altFormes[curSpeciesId]
        ? curSpeciesId
        : null;

      const disguiseBusted = sp.abilityId === 'disguise' &&
        (p.species.id === 'mimikyubusted' || !!(p.abilityState as any)?.busted);

      const expectedTypes = formeId && sp.altFormes[formeId]
        ? sp.altFormes[formeId].types
        : megaEvolved && sp.megaForme
          ? sp.megaForme.types
          : sp.baseTypes;
      const typesSame = isTransformed || (p.types.length === expectedTypes.length &&
        p.types.every((t, ti) => t === expectedTypes[ti]));

      const curItemId = toID(p.item || '');
      const itemOverride: string | null = curItemId === sp.itemId ? null : curItemId;
      const itemActive = curItemId !== '';

      const curAbilityId = toID(p.ability || '');
      const expectedAbId = formeId && sp.altFormes[formeId]
        ? sp.altFormes[formeId].abilityId
        : megaEvolved && sp.megaForme
          ? sp.megaForme.abilityId
          : sp.abilityId;
      const abilityOverride: string | null = !isTransformed && curAbilityId && curAbilityId !== expectedAbId ? curAbilityId : null;
      const gastroAcid = !!p.volatiles?.gastroacid;

      const transformed: import('./types').TransformedOverlay | null = isTransformed
        ? {
            speciesId: curSpeciesId,
            types: [...p.types],
            weightkg: p.species.weightkg,
            stats: {
              atk: p.storedStats.atk,
              def: p.storedStats.def,
              spa: p.storedStats.spa,
              spd: p.storedStats.spd,
              spe: p.storedStats.spe,
            },
            abilityId: curAbilityId,
            moves: p.moveSlots.map(ms => compileMoveSpec(ctx.dex, ms.id).move),
            sourceSide: 0,
            sourceIdx: 0,
          }
        : null;

      const rawStatus = toID(p.status);
      const status = (rawStatus === 'fnt' ? '' : (rawStatus as StatusId)) || '';
      const statusTurns = status === 'tox'
        ? ((p.statusState as any)?.stage || 0)
        : ((p.statusState as any)?.time || 0);

      const confusion = p.volatiles?.confusion;
      const attract = p.volatiles?.attract;
      const magnetRise = p.volatiles?.magnetrise;
      const lockOn = p.volatiles?.lockon;
      const stockpile = p.volatiles?.stockpile;
      const octolock = p.volatiles?.octolock;
      const uproar = p.volatiles?.uproar;

      let usedMovesMask = 0;
      for (let mi = 0; mi < sp.moves.length; mi++) {
        if ((p.moveSlots[mi] as any)?.used) usedMovesMask |= 1 << mi;
      }

      const cudchewBerry = (p.abilityState as any)?.berry ? toID((p.abilityState as any).berry.id || (p.abilityState as any).berry) : '';
      const cudchewTurns = cudchewBerry ? ((p.abilityState as any)?.counter || 0) : 0;

      // Detect Power Split / Guard Split stat overrides
      const baseExpectedStats = formeId && sp.altFormes[formeId]
        ? sp.altFormes[formeId].stats
        : megaEvolved && sp.megaForme
          ? sp.megaForme.stats
          : sp.stats;
      const hasPowerTrick = !!p.volatiles?.powertrick || !!p.volatiles?.powershift;
      let statOverride: Partial<StaticStats> | null = null;
      if (!hasPowerTrick && !isTransformed && p.storedStats) {
        const diff: Partial<StaticStats> = {};
        if (p.storedStats.atk !== baseExpectedStats.atk) diff.atk = p.storedStats.atk;
        if (p.storedStats.def !== baseExpectedStats.def) diff.def = p.storedStats.def;
        if (p.storedStats.spa !== baseExpectedStats.spa) diff.spa = p.storedStats.spa;
        if (p.storedStats.spd !== baseExpectedStats.spd) diff.spd = p.storedStats.spd;
        if (p.storedStats.spe !== baseExpectedStats.spe) diff.spe = p.storedStats.spe;
        if (Object.keys(diff).length > 0) statOverride = diff;
      }

      pokemon[idx] = {
        hp: p.fainted ? 0 : p.hp,
        hpDist: null,
        fainted: p.fainted || p.hp <= 0,
        pp,
        status,
        statusTurns,
        boosts,
        itemActive,
        itemOverride,
        lastItemId: toID((p as any).lastItem || ''),
        ateBerry: !!(p as any).ateBerry,
        cudchewBerry,
        cudchewTurns,
        abilityActive: !!p.ability && !gastroAcid,
        abilityOverride,
        gastroAcid,
        abilityUsed: !!(p as any).abilityState?.used,
        megaEvolved,
        formeId,
        bondTriggered: !!(p as any).bondTriggered,
        illusionActive: !!(p as any).illusion,
        transformed,
        savedPp: null,
        disguiseBusted,
        proteanUsed: !!(p as any).abilityState?.protean,
        flashFireActive: !!p.volatiles?.flashfire,
        unburdenActive: !!p.volatiles?.unburden,
        substituteHp: sub?.hp || 0,
        types: typesSame ? null : [...p.types],
        protectStreak: stall ? stallCounterToStreak(stall.counter) : 0,
        protecting: false,
        protectKind: '',
        enduring: false,
        roosted: false,
        flinched: false,
        mustRecharge: !!p.volatiles?.mustrecharge,
        confusionTurns: confusion?.time || 0,
        attractSide: attract?.source?.side ? (attract.source.side.id === 'p1' ? 0 : 1) : -1,
        attractSlot: attract?.source ? (attract.source.position ?? 0) : -1,
        magnetRiseTurns: magnetRise?.duration || 0,
        lockOnTurns: lockOn?.duration || 0,
        lockOnSide: lockOn?.source?.side ? (lockOn.source.side.id === 'p1' ? 0 : 1) : -1,
        lockOnSlot: lockOn?.source ? (lockOn.source.position ?? 0) : -1,
        stockpileLayers: stockpile?.layers || 0,
        stockpileDef: Math.abs(stockpile?.def || 0),
        stockpileSpd: Math.abs(stockpile?.spd || 0),
        powerTrick: hasPowerTrick,
        statOverride,
        usedMovesMask,
        imprison: !!p.volatiles?.imprison,
        octolockSide: octolock?.source?.side ? (octolock.source.side.id === 'p1' ? 0 : 1) : -1,
        octolockSlot: octolock?.source ? (octolock.source.position ?? 0) : -1,
        uproarTurns: uproar?.duration || 0,
        encoreMoveIdx,
        encoreTurns,
        tauntTurns: taunt?.duration || 0,
        throatChopTurns: throatChop?.duration || 0,
        choiceLockedMoveIdx,
        disabledMoveIdx,
        disabledTurns,
        tormented: !!p.volatiles?.torment,
        leechSeedSlot: leech
          ? (typeof leech.sourceSlot === 'number'
              ? leech.sourceSlot
              : typeof leech.sourceSlot === 'string' && leech.sourceSlot.endsWith('b')
                ? 1
                : (leech.source?.position ?? 0))
          : -1,
        yawnTurns: yawn?.duration || 0,
        cursed: !!p.volatiles?.curse,
        perishTurns: perish?.duration || 0,
        trapped: !!p.volatiles?.trapped || !!p.volatiles?.noretreat,
        partialTrapTurns: pTrap?.duration || 0,
        aquaRing: !!p.volatiles?.aquaring,
        ingrain: !!p.volatiles?.ingrain,
        smackedDown: !!p.volatiles?.smackdown,
        focusEnergy: !!p.volatiles?.focusenergy,
        dragonCheer: dragonCheer?.hasDragonType ? 2 : dragonCheer ? 1 : 0,
        charged: !!p.volatiles?.charge,
        glaiveRush: !!p.volatiles?.glaiverush,
        syrupBombTurns: syrup?.duration || 0,
        destinyBond: !!p.volatiles?.destinybond,
        noRetreatUsed: !!p.volatiles?.noretreat,
        timesAttacked: (p as any).timesAttacked || 0,
        lastMoveFailed: !!(p as any).moveLastTurnResult === false && (p as any).moveLastTurnResult !== undefined,
        chargingMoveIdx: -1,
        lockedMoveIdx: p.volatiles?.lockedmove?.move
          ? sp.moves.findIndex(m => m.id === toID(p.volatiles.lockedmove.move))
          : -1,
        lockedMoveDuration: p.volatiles?.lockedmove?.duration ?? 0,
        lockedMoveTrueDuration: p.volatiles?.lockedmove?.trueDuration ?? 0,
        invulnerable: '',
        lastMoveIdx,
        lastMoveId: p.lastMove?.id ? toID(p.lastMove.id) : '',
        activeTurns: p.activeTurns || 0,
        movedThisTurn: false,
        switchedInThisTurn: false,
        helpingHandCount: 0,
        redirectKind: '',
        focusPunchReady: false,
        focusPunchLost: false,
        beakBlastHeating: false,
        electrified: false,
        emergencyExitTriggered: false,
        damagedThisTurn: 0,
        damagedCategory: '',
        damagedBySide: -1,
        damagedBySlot: -1,
        statLoweredThisTurn: false,
      };
    }

    // If any side already used mega evolution earlier (even if the mega pokemon fainted)
    if (!megaUsed && rawSide.pokemon.every(p => !p.canMegaEvo) && staticSide.team.some(sp => !!sp.megaForme)) {
      if (pokemon.some(p => p.megaEvolved)) megaUsed = true;
    }

    const wishTurns = new Array(ctx.activeCount).fill(0);
    const wishHp = new Array(ctx.activeCount).fill(0);
    const healingWish = new Array(ctx.activeCount).fill(false);
    const futureMoves: (import('./types').FutureMoveSlot | null)[] = new Array(ctx.activeCount).fill(null);
    for (let sl = 0; sl < ctx.activeCount; sl++) {
      const sc: any = rawSide.slotConditions?.[sl];
      if (sc?.Wish) {
        wishTurns[sl] = sc.Wish.duration || 0;
        wishHp[sl] = sc.Wish.hp || 0;
      }
      if (sc?.healingwish) {
        healingWish[sl] = true;
      }
      if (sc?.futuremove) {
        const srcSide: 0 | 1 = sc.futuremove.source?.side?.id === 'p1' ? 0 : 1;
        futureMoves[sl] = {
          turns: sc.futuremove.duration || 0,
          sourceSide: srcSide,
          sourceIdx: 0,
          moveId: toID(sc.futuremove.move || 'futuresight'),
        };
      }
    }

    return {
      active,
      megaUsed,
      stealthRock: !!rawSide.sideConditions?.stealthrock,
      spikes: rawSide.sideConditions?.spikes?.layers || 0,
      toxicSpikes: rawSide.sideConditions?.toxicspikes?.layers || 0,
      stickyWeb: !!rawSide.sideConditions?.stickyweb,
      tailwindTurns: rawSide.sideConditions?.tailwind?.duration || 0,
      reflectTurns: rawSide.sideConditions?.reflect?.duration || 0,
      lightScreenTurns: rawSide.sideConditions?.lightscreen?.duration || 0,
      auroraVeilTurns: rawSide.sideConditions?.auroraveil?.duration || 0,
      safeguardTurns: rawSide.sideConditions?.safeguard?.duration || 0,
      wishTurns,
      wishHp,
      healingWish,
      futureMoves,
      wideGuard: false,
      quickGuard: false,
      roundUsedThisTurn: false,
      pokemon,
    };
  };

  let phase: BattlePhase;
  if (battle.ended) {
    const winner: 0 | 1 | 2 =
      battle.winner === battle.p1.name ? 0 : battle.winner === battle.p2.name ? 1 : 2;
    phase = {kind: 'ended', winner};
  } else if (battle.requestState === 'switch') {
    const pendingSlots: import('./types').PendingSwitchSlot[] = [];
    for (const s of [0, 1] as const) {
      const req: any = battle.sides[s].activeRequest;
      if (req?.forceSwitch) {
        for (let slot = 0; slot < req.forceSwitch.length; slot++) {
          if (req.forceSwitch[slot]) {
            const activeP: any = battle.sides[s].active[slot];
            const sf = activeP?.switchFlag;
            const revive = !!battle.sides[s].slotConditions?.[slot]?.revivalblessing;
            if (revive) {
              pendingSlots.push({side: s, slot, revive: true});
            } else if (sf === 'batonpass' || sf === 'copyvolatile') {
              pendingSlots.push({side: s, slot, batonPass: true});
            } else if (sf === 'shedtail') {
              pendingSlots.push({side: s, slot, shedTailHp: Math.max(1, Math.floor((activeP?.maxhp || 4) / 4))});
            } else {
              pendingSlots.push({side: s, slot});
            }
          }
        }
      }
    }
    const qList: any[] = (battle as any).queue?.list || [];
    const needsEndOfTurn = qList.some(a => a.choice === 'residual');
    const remainingActions: PendingQueuedAction[] = [];
    for (const q of qList) {
      if (q.choice !== 'move' || !q.pokemon || !q.move) continue;
      const qSide: 0 | 1 = q.pokemon.side.id === 'p1' ? 0 : 1;
      const qSlot = q.pokemon.position ?? 0;
      const mId = toID(q.move.id || q.move);
      const mIdx = q.pokemon.moveSlots.findIndex((ms: any) => toID(ms.id) === mId);
      const act: MoveAction = {
        kind: 'move',
        slot: qSlot,
        moveIndex: mIdx >= 0 ? mIdx : -1,
        ...(q.mega ? {mega: true} : {}),
      };
      if (ctx.activeCount > 1 && typeof q.targetLoc === 'number' && q.targetLoc !== 0) {
        act.targetSide = q.targetLoc > 0 ? (qSide === 0 ? 1 : 0) : qSide;
        act.targetSlot = Math.abs(q.targetLoc) - 1;
      }
      remainingActions.push({
        side: qSide,
        action: act,
        priority: q.priority || 0,
        speed: q.speed || 0,
        subOrder: q.subOrder || 0,
      });
    }
    phase = {kind: 'switch', pendingSlots, remainingActions, needsEndOfTurn};
  } else {
    phase = {kind: 'turn'};
  }

  return {
    field: {
      weather: importWeather(battle.field.weather),
      weatherTurns: battle.field.weatherState?.duration || 0,
      terrain: importTerrain(battle.field.terrain),
      terrainTurns: battle.field.terrainState?.duration || 0,
      trickRoomTurns: battle.field.pseudoWeather?.trickroom?.duration || 0,
      gravityTurns: battle.field.pseudoWeather?.gravity?.duration || 0,
      magicRoomTurns: battle.field.pseudoWeather?.magicroom?.duration || 0,
      wonderRoomTurns: battle.field.pseudoWeather?.wonderroom?.duration || 0,
      fairyLockTurns: battle.field.pseudoWeather?.fairylock?.duration || 0,
      lastMoveId: battle.lastMove?.id ? toID(battle.lastMove.id) : '',
    },
    sides: [importSide(0), importSide(1)],
    phase,
  };
}

/**
 * Compact deterministic state key that omits protocol/log/PRNG data and any
 * optional historical field whose reader bit is not set in ctx.featureMask.
 */
export function canonicalStateKey(
  ctx: StaticBattleContext,
  state: DynamicState,
  maskActiveHp?: readonly [boolean, boolean],
  maskPp = false
): string {
  const fm = ctx.featureMask;
  const trackFieldLastMove = (fm & FeatureBit.FIELD_LAST_MOVE) !== 0;
  const trackLastMoveId = (fm & FeatureBit.LAST_MOVE_ID) !== 0;
  const trackLastMoveFailed = (fm & FeatureBit.LAST_MOVE_FAILED) !== 0;
  const trackLastItem = (fm & FeatureBit.LAST_ITEM) !== 0;
  const trackAteBerry = (fm & FeatureBit.ATE_BERRY) !== 0;
  const trackSide0LastMove = (fm & FeatureBit.SIDE0_LAST_MOVE_IDX) !== 0;
  const trackSide1LastMove = (fm & FeatureBit.SIDE1_LAST_MOVE_IDX) !== 0;
  const trackTimesAttacked = (fm & FeatureBit.TIMES_ATTACKED) !== 0;
  const trackStall = (fm & FeatureBit.PROTECT_STALL) !== 0;
  const trackEncore = (fm & FeatureBit.ENCORE) !== 0;
  const trackDisguise = (fm & FeatureBit.DISGUISE) !== 0;
  const trackRecharge = (fm & FeatureBit.RECHARGE) !== 0;
  const trackMega = (fm & FeatureBit.MEGA) !== 0;
  const trackSub = (fm & FeatureBit.SUBSTITUTE) !== 0;
  const trackTaunt = (fm & FeatureBit.TAUNT) !== 0;
  const trackChoice = (fm & FeatureBit.CHOICE_LOCK) !== 0;
  const trackHazards = (fm & FeatureBit.HAZARDS) !== 0;

  if (state.phase.kind === 'ended') {
    return `E:${state.phase.winner}`;
  }

  const f = state.field;
  let out = `${state.phase.kind}`;
  if (state.phase.kind === 'switch') {
    const ps = state.phase.pendingSlots
      .map(x => `${x.side}.${x.slot}${x.revive ? 'R' : ''}${x.batonPass ? 'B' : ''}${x.shedTailHp ? `S${x.shedTailHp}` : ''}`)
      .join(',');
    const ra = state.phase.remainingActions
      .map(x => `${x.side}:${x.action.slot}:${x.action.moveIndex}:${x.action.mega ? 1 : 0}:${ctx.activeCount > 1 ? (x.action.targetSide ?? '') : ''}:${ctx.activeCount > 1 ? (x.action.targetSlot ?? '') : ''}:${x.priority}:${x.speed}`)
      .join(';');
    out += `[${ps}|${ra}|${state.phase.needsEndOfTurn ? 1 : 0}]`;
  }
  if (f.weather || f.terrain || f.trickRoomTurns || f.gravityTurns || f.magicRoomTurns || f.wonderRoomTurns || f.fairyLockTurns || (trackFieldLastMove && f.lastMoveId)) {
    out += `|F:${f.weather}${f.weatherTurns},${f.terrain}${f.terrainTurns},${f.trickRoomTurns}`;
    if (f.gravityTurns || f.magicRoomTurns || f.wonderRoomTurns || f.fairyLockTurns) {
      out += `,${f.gravityTurns},${f.magicRoomTurns},${f.wonderRoomTurns},${f.fairyLockTurns}`;
    }
    if (trackFieldLastMove && f.lastMoveId) out += `,LM:${f.lastMoveId}`;
  }

  for (let s = 0; s < 2; s++) {
    const side = state.sides[s];
    const trackSideLastMoveIdx = s === 0 ? trackSide0LastMove : trackSide1LastMove;
    const maskSideHp = maskActiveHp ? maskActiveHp[s] : false;
    out += `|S${s}:${side.active.join(',')}`;
    if (trackMega && side.megaUsed) out += `/M1`;
    const sr = trackHazards && side.stealthRock ? 1 : 0;
    const spk = trackHazards ? side.spikes : 0;
    const tspk = trackHazards ? side.toxicSpikes : 0;
    const sw = trackHazards && side.stickyWeb ? 1 : 0;
    if (sr || spk || tspk || sw ||
        side.tailwindTurns || side.reflectTurns || side.lightScreenTurns || side.auroraVeilTurns || side.safeguardTurns) {
      out += `/${sr},${spk},${tspk},${sw},${side.tailwindTurns},${side.reflectTurns},${side.lightScreenTurns},${side.auroraVeilTurns}`;
      if (side.safeguardTurns) out += `,${side.safeguardTurns}`;
    }
    for (let sl = 0; sl < side.wishTurns.length; sl++) {
      if (side.wishTurns[sl] > 0) out += `/W${sl}:${side.wishTurns[sl]}:${side.wishHp[sl]}`;
      if (side.healingWish[sl]) out += `/HW${sl}`;
      const fmSlot = side.futureMoves[sl];
      if (fmSlot) out += `/FM${sl}:${fmSlot.turns}:${fmSlot.sourceSide}.${fmSlot.sourceIdx}`;
    }
    for (let i = 0; i < side.pokemon.length; i++) {
      const p = side.pokemon[i];
      if (p.fainted) {
        out += `;X`;
        continue;
      }
      const hpStr = maskSideHp && i === side.active[0]
        ? '*'
        : (p.hpDist
          ? `D(${p.hpDist.map(e => `${e.hp}:${e.prob.toFixed(9)}`).join(',')})`
          : `${p.hp}`);
      const ppStr = maskPp
        ? p.pp.map(v => (v >= 3 ? '+' : v)).join(',')
        : p.pp.join(',');
      out += `;${hpStr}/${ppStr}`;
      if (p.status) out += `/${p.status}${p.statusTurns || ''}`;
      else out += `/`;
      const b = p.boosts;
      const b2 = ctx.trackSpaBoost[s] ? b[2] : 0;
      const b3 = ctx.trackSpdBoost[s] ? b[3] : 0;
      if (b[0] || b[1] || b2 || b3 || b[4] || b[5] || b[6]) {
        out += `/${b[0]},${b[1]},${b2},${b3},${b[4]},${b[5]},${b[6]}`;
      }
      if (!p.itemActive && ctx.sides[s].team[i].itemId) out += `/I0`;
      if (p.itemOverride !== null && p.itemOverride !== '') out += `/IO:${p.itemOverride}`;
      if (trackLastItem && p.lastItemId) out += `/LI:${p.lastItemId}`;
      if (trackAteBerry && p.ateBerry) out += `/AB`;
      if (p.cudchewBerry) out += `/CC:${p.cudchewBerry}:${p.cudchewTurns}`;
      if (p.abilityOverride !== null) out += `/AO:${p.abilityOverride}`;
      if (p.gastroAcid) out += `/GA`;
      if (trackMega && p.megaEvolved) out += `/MG`;
      if (p.formeId) out += `/FM:${p.formeId}`;
      if (p.bondTriggered) out += `/BB`;
      if (p.transformed) out += `/TF:${p.transformed.speciesId}:${p.transformed.abilityId}:${p.transformed.types.join(',')}`;
      if (trackDisguise && p.disguiseBusted) out += `/DB`;
      if (trackSub && p.substituteHp > 0) out += `/SB${p.substituteHp}`;
      if (trackStall && p.protectStreak) out += `/PS${p.protectStreak}`;
      if (trackEncore && p.encoreMoveIdx >= 0) out += `/EN${p.encoreMoveIdx}:${p.encoreTurns}`;
      if (trackTaunt && p.tauntTurns > 0) out += `/TN${p.tauntTurns}`;
      if (p.throatChopTurns > 0) out += `/TC${p.throatChopTurns}`;
      if (trackChoice && p.choiceLockedMoveIdx >= 0) out += `/CL${p.choiceLockedMoveIdx}`;
      if (trackSideLastMoveIdx && p.lastMoveIdx !== -1) out += `/LM${p.lastMoveIdx}`;
      if (trackLastMoveId && p.lastMoveId) out += `/LMI:${p.lastMoveId}`;
      if (trackLastMoveFailed && p.lastMoveFailed) out += `/LF`;
      if (trackTimesAttacked && p.timesAttacked > 0) out += `/TA${p.timesAttacked}`;
      if (trackRecharge && p.mustRecharge) out += `/RC`;
      if (p.confusionTurns > 0) out += `/CF${p.confusionTurns}`;
      if (p.attractSide >= 0) out += `/AT${p.attractSide}.${p.attractSlot}`;
      if (p.magnetRiseTurns > 0) out += `/MR${p.magnetRiseTurns}`;
      if (p.lockOnTurns > 0) out += `/LO${p.lockOnTurns}:${p.lockOnSide}.${p.lockOnSlot}`;
      if (p.stockpileLayers > 0) out += `/SP${p.stockpileLayers}:${p.stockpileDef}:${p.stockpileSpd}`;
      if (p.powerTrick) out += `/PW`;
      if (p.statOverride) out += `/SO:${p.statOverride.atk ?? ''},${p.statOverride.def ?? ''},${p.statOverride.spa ?? ''},${p.statOverride.spd ?? ''}`;
      if (p.imprison) out += `/IM`;
      if (p.octolockSide >= 0) out += `/OL${p.octolockSide}.${p.octolockSlot}`;
      if (p.uproarTurns > 0) out += `/UP${p.uproarTurns}`;
      if (p.disabledMoveIdx >= 0) out += `/DS${p.disabledMoveIdx}:${p.disabledTurns}`;
      if (p.tormented) out += `/TM`;
      if (p.leechSeedSlot >= 0) out += `/LS${p.leechSeedSlot}`;
      if (p.yawnTurns > 0) out += `/YW${p.yawnTurns}`;
      if (p.cursed) out += `/CR`;
      if (p.perishTurns > 0) out += `/PH${p.perishTurns}`;
      if (p.trapped) out += `/TR`;
      if (p.partialTrapTurns > 0) out += `/PT${p.partialTrapTurns}`;
      if (p.aquaRing) out += `/AQ`;
      if (p.ingrain) out += `/IG`;
      if (p.smackedDown) out += `/SD`;
      if (p.focusEnergy) out += `/FE`;
      if (p.dragonCheer) out += `/DC${p.dragonCheer}`;
      if (p.charged) out += `/CG`;
      if (p.glaiveRush) out += `/GR`;
      if (p.syrupBombTurns > 0) out += `/SY${p.syrupBombTurns}`;
      if (p.destinyBond) out += `/DBN`;
      if (p.chargingMoveIdx >= 0) out += `/CH${p.chargingMoveIdx}${p.invulnerable}`;
      if (p.lockedMoveIdx >= 0) out += `/LK${p.lockedMoveIdx}:${p.lockedMoveDuration}:${p.lockedMoveTrueDuration}`;
      if (p.flashFireActive) out += `/FF`;
      if (p.unburdenActive) out += `/UB`;
      if (p.proteanUsed) out += `/PR`;
      if (p.abilityUsed) out += `/AU`;
      if (p.types) out += `/T${p.types.join(',')}`;
    }
  }
  return out;
}

export function setNormalizedHpDist(p: PokemonState, entries: HpEntry[]): void {
  const byHp = new Map<number, number>();
  let total = 0;
  for (const e of entries) {
    if (e.prob <= EPS) continue;
    const clamped = e.hp < 0 ? 0 : e.hp;
    byHp.set(clamped, (byHp.get(clamped) ?? 0) + e.prob);
    total += e.prob;
  }
  if (byHp.size === 0 || total <= EPS) {
    p.hp = 0;
    p.hpDist = null;
    p.fainted = true;
    return;
  }
  const sorted = [...byHp.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 1) {
    p.hp = sorted[0][0];
    p.hpDist = null;
    p.fainted = p.hp <= 0;
    return;
  }
  const dist: HpEntry[] = sorted.map(([hp, prob]) => ({hp, prob: prob / total}));
  p.hp = dist[0].hp;
  p.hpDist = dist;
  p.fainted = false;
}

export function getHpEntries(p: PokemonState): readonly HpEntry[] {
  if (p.hpDist) return p.hpDist;
  return [{hp: p.hp, prob: 1}];
}

export function hpMin(p: PokemonState): number {
  return p.hpDist ? p.hpDist[0].hp : p.hp;
}

export function hpMax(p: PokemonState): number {
  return p.hpDist ? p.hpDist[p.hpDist.length - 1].hp : p.hp;
}

export function splitBranchByHpPredicate(
  ws: WeightedState,
  sideIdx: 0 | 1,
  pokeIdx: number,
  predicate: (hp: number) => boolean
): {matched: WeightedState | null; unmatched: WeightedState | null; didSplit: boolean} {
  const p = ws.state.sides[sideIdx].pokemon[pokeIdx];
  if (!p.hpDist) {
    return predicate(p.hp)
      ? {matched: ws, unmatched: null, didSplit: false}
      : {matched: null, unmatched: ws, didSplit: false};
  }

  const yes: HpEntry[] = [];
  const no: HpEntry[] = [];
  let yesProb = 0;
  let noProb = 0;
  for (const e of p.hpDist) {
    if (predicate(e.hp)) {
      yes.push(e);
      yesProb += e.prob;
    } else {
      no.push(e);
      noProb += e.prob;
    }
  }
  if (yes.length === 0) return {matched: null, unmatched: ws, didSplit: false};
  if (no.length === 0) return {matched: ws, unmatched: null, didSplit: false};

  const sYes = cloneState(ws.state);
  setNormalizedHpDist(sYes.sides[sideIdx].pokemon[pokeIdx], yes);
  const sNo = cloneState(ws.state);
  setNormalizedHpDist(sNo.sides[sideIdx].pokemon[pokeIdx], no);

  return {
    matched: {state: sYes, probability: ws.probability * yesProb},
    unmatched: {state: sNo, probability: ws.probability * noProb},
    didSplit: true,
  };
}

export function expandStateHpDists(ws: WeightedState): WeightedState[] {
  let current: WeightedState[] = [ws];
  for (let s = 0; s < 2; s++) {
    const teamLen = ws.state.sides[s].pokemon.length;
    for (let i = 0; i < teamLen; i++) {
      let anyDist = false;
      for (const item of current) {
        if (item.state.sides[s].pokemon[i].hpDist) {
          anyDist = true;
          break;
        }
      }
      if (!anyDist) continue;
      const next: WeightedState[] = [];
      for (const item of current) {
        const dist = item.state.sides[s].pokemon[i].hpDist;
        if (!dist) {
          next.push(item);
          continue;
        }
        for (const e of dist) {
          const st = cloneState(item.state);
          const pk = st.sides[s].pokemon[i];
          pk.hp = e.hp;
          pk.hpDist = null;
          pk.fainted = e.hp <= 0;
          next.push({state: st, probability: item.probability * e.prob});
        }
      }
      current = next;
    }
  }
  return current;
}

export function terminalUtilityFromState(state: DynamicState): number | null {
  if (state.phase.kind !== 'ended') return null;
  if (state.phase.winner === 0) return 1;
  if (state.phase.winner === 1) return -1;
  return 0;
}

export function isSideDefeated(side: SideState): boolean {
  return side.pokemon.every(p => p.fainted);
}

export function legalBenchSwitches(side: SideState): number[] {
  const activeSet = new Set(side.active);
  const out: number[] = [];
  for (let i = 0; i < side.pokemon.length; i++) {
    if (!side.pokemon[i].fainted && !activeSet.has(i)) {
      out.push(i);
    }
  }
  return out;
}

export function canSlotMegaEvolve(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  slot: number
): boolean {
  if (!ctx.ruleset.megaEvolutionEnabled) return false;
  const side = state.sides[sideIdx];
  if (side.megaUsed) return false;
  const pokeIdx = side.active[slot];
  if (pokeIdx < 0) return false;
  const p = side.pokemon[pokeIdx];
  const sp = ctx.sides[sideIdx].team[pokeIdx];
  return !p.fainted && !p.megaEvolved && p.itemActive && !!sp.megaForme;
}

export function legalSlotActions(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  slot: number
): SlotAction[] {
  const side = state.sides[sideIdx];
  const oppSideIdx: 0 | 1 = sideIdx === 0 ? 1 : 0;
  const pokeIdx = side.active[slot];

  if (state.phase.kind === 'switch') {
    const pending = state.phase.pendingSlots.find(p => p.side === sideIdx && p.slot === slot);
    if (!pending) return [{kind: 'pass', slot}];
    if (pending.revive) {
      const faintedBench: SlotAction[] = [];
      for (let i = 0; i < side.pokemon.length; i++) {
        if (side.pokemon[i].fainted && !side.active.includes(i)) {
          faintedBench.push({kind: 'switch', slot, benchIndex: i});
        }
      }
      return faintedBench.length > 0 ? faintedBench : [{kind: 'pass', slot}];
    }
    return legalBenchSwitches(side).map(benchIndex => ({kind: 'switch', slot, benchIndex}));
  }

  if (pokeIdx < 0 || side.pokemon[pokeIdx].fainted) {
    return [{kind: 'pass', slot}];
  }

  const poke = side.pokemon[pokeIdx];
  const staticPoke = ctx.sides[sideIdx].team[pokeIdx];
  const moves = activeMoves(staticPoke, poke);
  const actions: SlotAction[] = [];

  if (poke.mustRecharge) {
    actions.push({kind: 'move', slot, moveIndex: 0});
    return actions;
  }
  if (poke.chargingMoveIdx >= 0) {
    actions.push({kind: 'move', slot, moveIndex: poke.chargingMoveIdx, targetSide: oppSideIdx, targetSlot: 0});
    return actions;
  }
  if (poke.lockedMoveIdx >= 0) {
    actions.push({kind: 'move', slot, moveIndex: poke.lockedMoveIdx, targetSide: oppSideIdx, targetSlot: 0});
    return actions;
  }
  if (poke.uproarTurns > 0) {
    const uproarIdx = moves.findIndex(m => m.id === 'uproar');
    if (uproarIdx >= 0) {
      actions.push({kind: 'move', slot, moveIndex: uproarIdx, targetSide: oppSideIdx, targetSlot: 0});
      return actions;
    }
  }

  // Collect Imprison-blocked move IDs from opposing active Pokemon
  const oppSide = state.sides[oppSideIdx];
  let imprisonedMoves: Set<string> | null = null;
  for (const oIdx of oppSide.active) {
    if (oIdx < 0) continue;
    const op = oppSide.pokemon[oIdx];
    if (!op.fainted && op.imprison) {
      if (!imprisonedMoves) imprisonedMoves = new Set();
      for (const om of activeMoves(ctx.sides[oppSideIdx].team[oIdx], op)) {
        if (om.id !== 'struggle') imprisonedMoves.add(om.id);
      }
    }
  }

  const canMega = canSlotMegaEvolve(ctx, state, sideIdx, slot);
  const megaOptions: (false | true)[] = canMega ? [false, true] : [false];

  let usableMoves = 0;
  for (let mi = 0; mi < moves.length; mi++) {
    if (poke.pp[mi] <= 0) continue;
    if (poke.encoreMoveIdx >= 0 && poke.encoreMoveIdx !== mi) continue;
    if (poke.choiceLockedMoveIdx >= 0 && poke.choiceLockedMoveIdx !== mi && isItemEffectActive(state, staticPoke, poke)) continue;
    if (poke.disabledMoveIdx === mi && poke.disabledTurns > 0) continue;
    if (poke.tormented && poke.lastMoveIdx === mi) continue;
    const move = moves[mi];
    if (imprisonedMoves && imprisonedMoves.has(move.id)) continue;
    if (poke.tauntTurns > 0 && move.category === 'Status') continue;
    if (poke.throatChopTurns > 0 && move.sound) continue;
    usableMoves++;

    for (const mega of megaOptions) {
      const megaFlag = mega ? true : undefined;
      if (ctx.activeCount === 1 ||
          move.target === 'self' ||
          move.target === 'allAdjacentFoes' ||
          move.target === 'allAdjacent' ||
          move.target === 'foeSide' ||
          move.target === 'allySide' ||
          move.target === 'randomNormal') {
        actions.push({
          kind: 'move',
          slot,
          moveIndex: mi,
          mega: megaFlag,
          targetSide: move.target === 'self' || move.target === 'allySide' ? sideIdx : oppSideIdx,
          targetSlot: 0,
        });
      } else {
        for (let ts = 0; ts < ctx.activeCount; ts++) {
          actions.push({kind: 'move', slot, moveIndex: mi, mega: megaFlag, targetSide: oppSideIdx, targetSlot: ts});
        }
        if (move.target === 'normal' || move.target === 'any' || move.target === 'adjacentAllyOrSelf') {
          const allySlot = slot === 0 ? 1 : 0;
          if (side.active[allySlot] >= 0 && !side.pokemon[side.active[allySlot]].fainted) {
            actions.push({kind: 'move', slot, moveIndex: mi, mega: megaFlag, targetSide: sideIdx, targetSlot: allySlot});
          }
        }
      }
    }
  }

  if (usableMoves === 0) {
    actions.push({kind: 'move', slot, moveIndex: -1, targetSide: oppSideIdx, targetSlot: 0});
  }

  // Check trapping (Ghost-types escape all trapping; Shadow Tag doesn't trap another Shadow Tag; Shed Shell escapes)
  const myTypes = activeTypes(staticPoke, poke);
  const isGhost = myTypes.includes('Ghost');
  const myAb = activeAbilitySpec(staticPoke, poke);
  const hasShedShell = isItemEffectActive(state, staticPoke, poke) && activeItemId(staticPoke, poke) === 'shedshell';
  let shadowTagged = false;
  if (!isGhost && !hasShedShell && !(poke.abilityActive && !poke.gastroAcid && myAb.shadowTag)) {
    for (const oIdx of oppSide.active) {
      if (oIdx < 0) continue;
      const op = oppSide.pokemon[oIdx];
      if (!op.fainted && op.abilityActive && !op.gastroAcid && activeAbilitySpec(ctx.sides[oppSideIdx].team[oIdx], op).shadowTag) {
        shadowTagged = true;
        break;
      }
    }
  }
  const octolockTrapped = poke.octolockSide !== -1 && poke.octolockSlot >= 0 &&
    state.sides[poke.octolockSide].active[poke.octolockSlot] >= 0 &&
    !state.sides[poke.octolockSide].pokemon[state.sides[poke.octolockSide].active[poke.octolockSlot]].fainted;
  const isTrapped = !isGhost && !hasShedShell && (
    poke.trapped ||
    poke.ingrain ||
    poke.partialTrapTurns > 0 ||
    state.field.fairyLockTurns > 0 ||
    octolockTrapped ||
    shadowTagged
  );
  if (!isTrapped) {
    for (const benchIndex of legalBenchSwitches(side)) {
      actions.push({kind: 'switch', slot, benchIndex});
    }
  }

  return actions;
}

export function legalSideActions(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1
): SideAction[] {
  if (state.phase.kind === 'ended') return [];
  if (ctx.activeCount === 1) {
    return legalSlotActions(ctx, state, sideIdx, 0).map(a => [a]);
  }
  const s0 = legalSlotActions(ctx, state, sideIdx, 0);
  const s1 = legalSlotActions(ctx, state, sideIdx, 1);
  const out: SideAction[] = [];
  for (const a0 of s0) {
    for (const a1 of s1) {
      if (a0.kind === 'switch' && a1.kind === 'switch' && a0.benchIndex === a1.benchIndex) continue;
      // Only one slot may Mega Evolve per turn
      if (a0.kind === 'move' && a0.mega && a1.kind === 'move' && a1.mega) continue;
      out.push([a0, a1]);
    }
  }
  return out;
}

export function parseShowdownCommand(
  ctx: StaticBattleContext,
  state: DynamicState,
  sideIdx: 0 | 1,
  command: string
): SideAction {
  const parts = command.split(',').map(s => s.trim()).filter(Boolean);
  const oppSideIdx: 0 | 1 = sideIdx === 0 ? 1 : 0;
  const actions: SlotAction[] = [];

  for (let slot = 0; slot < ctx.activeCount; slot++) {
    const part = parts[slot] ?? 'pass';
    if (part === 'pass') {
      actions.push({kind: 'pass', slot});
      continue;
    }
    if (part === 'auto' || part === 'default') {
      const legal = legalSlotActions(ctx, state, sideIdx, slot);
      actions.push(legal[0] ?? {kind: 'pass', slot});
      continue;
    }
    const tokens = part.split(/\s+/);
    if (tokens[0] === 'switch') {
      const benchIndex = Number(tokens[1]) - 1;
      actions.push({kind: 'switch', slot, benchIndex});
      continue;
    }
    if (tokens[0] === 'move') {
      const pokeIdx = state.sides[sideIdx].active[slot];
      const sp = ctx.sides[sideIdx].team[pokeIdx];
      const poke = state.sides[sideIdx].pokemon[pokeIdx];
      const moves = activeMoves(sp, poke);
      let moveIndex = -1;
      if (/^\d+$/.test(tokens[1])) {
        moveIndex = Number(tokens[1]) - 1;
      } else {
        const id = toID(tokens[1]);
        moveIndex = id === 'struggle' ? -1 : moves.findIndex(m => m.id === id);
      }
      let targetSide: 0 | 1 = oppSideIdx;
      let targetSlot = 0;
      let mega = false;
      for (let ti = 2; ti < tokens.length; ti++) {
        const tok = tokens[ti];
        if (tok === 'mega' || tok === 'megaevo') {
          mega = true;
        } else if (/^[+-]?\d+$/.test(tok)) {
          const t = Number(tok);
          if (t > 0) {
            targetSide = oppSideIdx;
            targetSlot = t - 1;
          } else if (t < 0) {
            targetSide = sideIdx;
            targetSlot = -t - 1;
          }
        }
      }
      const action: MoveAction = {
        kind: 'move',
        slot,
        moveIndex,
        mega: mega ? true : undefined,
        targetSide,
        targetSlot,
      };
      actions.push(action);
      continue;
    }
    throw new Error(`Unsupported Showdown command fragment: ${part}`);
  }
  return actions;
}
