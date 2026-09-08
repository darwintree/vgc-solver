import {Dex} from '@pkmn/sim';
import type {Action, Snapshot} from './types';
import {BranchingPRNG} from './branching-prng';
import {auditNativeRules} from './native-rules';
import {restoreBattle} from './showdown-adapter';

export interface TerminalEnvelope {lower: number; upper: number}

// These native callbacks have a deliberately small monotonicity proof:
// Stamina only raises Defense; Sitrus only heals its living holder; Rough
// Skin is inert for our non-contact moves; Focus Sash is inert below full HP.
// Admission binds both identity and event slot: a native healing callback
// moved to AfterMoveSecondarySelf would otherwise invalidate the HP proof.
// This is separate from the general native-source audit.
const abilityHooks = new Map([['onDamagingHit', new Set([
  (Dex.abilities.get('stamina') as any).onDamagingHit,
  (Dex.abilities.get('roughskin') as any).onDamagingHit,
])]]);
const berry = Dex.items.get('sitrusberry') as any;
const sash = Dex.items.get('focussash') as any;
const itemHooks = new Map([
  ['onUpdate', new Set([berry.onUpdate])],
  ['onTryEatItem', new Set([berry.onTryEatItem])],
  ['onEat', new Set([berry.onEat])],
  ['onDamage', new Set([sash.onDamage])],
]);
const noHooks = new Map();

function admittedHooks(effect, allowed: Map<string, Set<any>>) {
  return Object.entries(effect).every(([key, value]) => {
    if (!key.startsWith('on') || value === undefined) return true;
    if (allowed.get(key)?.has(value)) return true;
    // Numeric event callbacks such as onFractionalPriority are not sorting
    // metadata. A suffix is metadata only for an admitted handler slot.
    const event = key.replace(/(?:Priority|SubOrder|Order)$/, '');
    return typeof value === 'number' && event !== key && allowed.get(event)?.has(effect[event]);
  });
}

function plainBoosts(effect) {
  return !effect || (Object.keys(effect).every(key => key === 'boosts' || key === 'chance') &&
    effect.boosts && Object.entries(effect.boosts).every(([stat, value]) =>
      ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'].includes(stat) &&
      Number.isInteger(value)));
}

function plainDamageMove(move, first: boolean) {
  if (!move.exists || !['Physical', 'Special'].includes(move.category) || move.target !== 'normal' ||
      !(move.basePower > 0 && move.basePower <= 250) || move.flags.contact || move.flags.charge ||
      move.flags.recharge || move.flags.futuremove || move.isZ || move.isMax || move.ohko ||
      Object.values(move).some(value => typeof value === 'function')) return false;
  for (const field of ['damage', 'drain', 'heal', 'recoil', 'struggleRecoil', 'mindBlownRecoil',
    'selfdestruct', 'status', 'volatileStatus', 'sideCondition', 'slotCondition', 'weather',
    'terrain', 'pseudoWeather', 'forceSwitch', 'selfSwitch', 'condition', 'multiaccuracy',
    'smartTarget', 'critModifier', 'overrideOffensivePokemon', 'overrideDefensivePokemon',
    'overrideOffensiveStat', 'overrideDefensiveStat', 'breaksProtect', 'stealsBoosts']) {
    if (move[field]) return false;
  }
  if (!plainBoosts(move.self) || !plainBoosts(move.selfBoost)) return false;
  if (first) {
    if (move.self || move.boosts || move.secondaries?.length || move.secondary) return false;
    // This effect occurs after the entire move. It cannot strengthen the
    // victim against the response or lower the response's accuracy.
    for (const [stat, value] of Object.entries(move.selfBoost?.boosts || {})) {
      if (!['atk', 'spa', 'spe', 'def', 'spd'].includes(stat) ||
          (['def', 'spd'].includes(stat) && Number(value) > 0)) return false;
    }
  } else {
    if (move.multihit) return false;
    if ((move.secondaries || (move.secondary ? [move.secondary] : [])).some(effect => !plainBoosts(effect))) return false;
  }
  return true;
}

function maxHits(move): number | null {
  const hits = move.multihit ?? 1;
  const maximum = Array.isArray(hits) ? hits[1] : hits;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10) return null;
  if (Array.isArray(hits) && (hits.length !== 2 || !Number.isInteger(hits[0]) || hits[0] < 1 || hits[0] > maximum)) return null;
  return maximum;
}

function admittedState(battle) {
  if (battle.gen !== 9 || battle.gameType !== 'singles' || battle.ended || battle.requestState !== 'move' ||
      battle.sides.length !== 2 || battle.field.weather || battle.field.terrain ||
      Object.keys(battle.field.pseudoWeather).length || !admittedHooks(battle.format, noHooks)) return false;
  return battle.sides.every(side => side.pokemon.length === 1 && side.active.length === 1 &&
    !Object.keys(side.sideConditions).length && !Object.keys(side.slotConditions?.[0] || {}).length &&
    side.active.every(pokemon => pokemon.hp > 0 && pokemon.level <= 100 && !pokemon.status &&
      !pokemon.terastallized && !pokemon.transformed && !pokemon.addedType && pokemon.getTypes().length <= 2 &&
      !Object.keys(pokemon.volatiles).length &&
      admittedHooks(pokemon.getAbility(), abilityHooks) &&
      admittedHooks(pokemon.getItem(), itemHooks) && admittedHooks(pokemon.baseSpecies, noHooks)));
}

function noDamageOverflow(source, target, move) {
  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  const attack = source.calculateStat(attackStat, Math.max(0, source.boosts[attackStat]));
  // Include any permitted post-move defense drop, even the worst -6 stage.
  const defense = target.calculateStat(defenseStat, -6);
  // No admitted hook modifies damage. Two types, native STAB and critical
  // damage give at most 4 * 1.5 * 1.5; exclude native 16-bit wraparound.
  return ((2 * source.level / 5 + 2) * move.basePower * attack / defense / 50 + 2) * 9 < 65536;
}

/** Internal range evaluator; callers must establish the native envelope admission. */
export function damageRange(battle, source, target, move, deadline): {min: number; max: number} | null {
  if (!noDamageOverflow(source, target, move)) return null;
  const nativeRandom = battle.random;
  let min = Infinity;
  let max = -Infinity;
  try {
    // With the admitted hooks, post-random damage only applies positive
    // STAB/type factors, truncation and the minimum-one clamp. The overflow
    // guard excludes the native 16-bit wrap, so each fixed-crit branch is
    // monotone in the random roll. Its extrema occur at the two endpoints.
    for (const crit of [false, true]) for (const roll of [0, 15]) {
      if (performance.now() >= deadline) return null;
      // Only the audited damage randomizer can ask for random here.
      battle.random = n => {
        if (n !== 16) throw new Error('Unexpected randomness in terminal envelope damage');
        return roll;
      };
      const probe = battle.dex.getActiveMove(move);
      probe.willCrit = crit;
      battle.setActiveMove(probe, source, target);
      const damage = battle.actions.getDamage(source, target, probe, true);
      if (typeof damage !== 'number' || !Number.isFinite(damage)) return null;
      min = Math.min(min, damage);
      max = Math.max(max, damage);
    }
  } finally {
    battle.random = nativeRandom;
  }
  return {min, max};
}

function hitProbability(battle, source, target, move) {
  let probability = 1;
  let supported = true;
  battle.prng = new BranchingPRNG([], 0, alternatives => {
    if (alternatives.some(alternative => alternative.decision.kind !== 'chance')) supported = false;
    const hit = alternatives.find(alternative => alternative.decision.value === true);
    probability *= hit?.probability ?? 0;
    return hit ?? alternatives[0];
  });
  battle.setActiveMove(move, source, target);
  const result = battle.actions.hitStepAccuracy([target], source, move);
  return supported && result[0] ? probability : 0;
}

/**
 * A solve-scoped producer of bounded certificates, never distributions.
 * Admission is native and state-based; unsupported mechanics return null.
 */
export function createTerminalEnvelope(battle, audited = auditNativeRules(battle)) {
  if (!audited || !admittedState(battle)) return null;
  return (snapshot: Snapshot, action1: Action, action2: Action, deadline = Infinity): TerminalEnvelope | null => {
    if (performance.now() >= deadline) return null;
    const probe: any = restoreBattle(snapshot);
    if (!admittedState(probe)) return null;
    const moves = [probe.dex.getActiveMove(action1.id), probe.dex.getActiveMove(action2.id)];
    // Resolve the actual native action ordering. Ties are outside this first
    // certificate; no randomly chosen order becomes a certainty claim.
    const actions = moves.map((move, side) => ({choice: 'move', move,
      pokemon: probe.sides[side].active[0], targetLoc: 1, fractionalPriority: 0, priority: 0, speed: 0}));
    for (const action of actions) probe.getActionSpeed(action);
    const comparison = actions[0].priority - actions[1].priority || actions[0].speed - actions[1].speed;
    if (!comparison) return null;
    const first = comparison > 0 ? 0 : 1;
    const second = 1 - first;
    if (!plainDamageMove(moves[first], true) || !plainDamageMove(moves[second], false)) return null;
    const source = actions[first].pokemon;
    const responder = actions[second].pokemon;
    const hits = maxHits(moves[first]);
    if (hits === null || (source.getItem().onDamage === sash.onDamage && source.hp === source.maxhp)) return null;
    // A healing attacker could regain its Sash or escape the initial HP KO
    // threshold. Sitrus on the responder is safe; on the attacker, decline.
    if (source.getItem().onUpdate === berry.onUpdate) return null;
    const firstDamage = damageRange(probe, source, responder, moves[first], deadline);
    if (!firstDamage || firstDamage.max * hits >= responder.hp) return null;
    const responseDamage = damageRange(probe, responder, source, moves[second], deadline);
    if (!responseDamage || responseDamage.min < source.hp) return null;
    const hitMass = hitProbability(probe, responder, source, moves[second]);
    if (!(hitMass > 0)) return null;
    // On a miss, all future outcomes remain possible. Include rounding slack
    // for interval arithmetic; the PRNG facade supplies exact uint32 mass.
    const margin = hitMass === 1 ? 0 : 1e-12;
    return second === 0
      ? {lower: Math.max(-1, 2 * hitMass - 1 - margin), upper: 1}
      : {lower: -1, upper: Math.min(1, 1 - 2 * hitMass + margin)};
  };
}
