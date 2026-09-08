import {Dex} from '@pkmn/sim';
import type {Action, Snapshot} from './types';
import {BranchingPRNG} from './branching-prng';
import {auditNativeRules} from './native-rules';
import {restoreBattle} from './showdown-adapter';

export interface TerminalEnvelope {lower: number; upper: number}

// These native callbacks have a deliberately small monotonicity proof:
// Stamina only raises Defense; Sitrus only heals its living holder; Rough
// Skin is inert for our non-contact moves; Focus Sash is inert below full HP.
// Torrent has only two HP regimes, both probed with native damage randomness.
// Admission binds both identity and event slot: a native healing callback
// moved to AfterMoveSecondarySelf would otherwise invalidate the HP proof.
// This is separate from the general native-source audit.
const torrent = Dex.abilities.get('torrent') as any;
const abilityHooks = new Map([['onDamagingHit', new Set([
  (Dex.abilities.get('stamina') as any).onDamagingHit,
  (Dex.abilities.get('roughskin') as any).onDamagingHit,
])],
  ['onModifyAtk', new Set([torrent.onModifyAtk])],
  ['onModifySpA', new Set([torrent.onModifySpA])],
]);
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

function admittedSecondary(effect) {
  return plainBoosts(effect) || (Object.keys(effect).every(key => key === 'chance' || key === 'status') &&
    ['par', 'brn', 'psn', 'tox', 'slp', 'frz'].includes(effect.status));
}

function secondaries(move) {
  return move.secondaries || (move.secondary ? [move.secondary] : []);
}

function plainDamageMove(move, first: boolean) {
  if (!move.exists || !['Physical', 'Special'].includes(move.category) || move.target !== 'normal' ||
      !(move.basePower > 0 && move.basePower <= 250) ||
      !(move.accuracy === true || Number.isInteger(move.accuracy)) || move.flags.contact || move.flags.charge ||
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
    if (move.self || move.boosts || secondaries(move).some(effect => !admittedSecondary(effect))) return false;
    if (move.multihit && secondaries(move).length) return false;
    // This effect occurs after the entire move. It cannot strengthen the
    // victim against the response or lower the response's accuracy.
    for (const [stat, value] of Object.entries(move.selfBoost?.boosts || {})) {
      if (!['atk', 'spa', 'spe', 'def', 'spd'].includes(stat) ||
          (['def', 'spd'].includes(stat) && Number(value) > 0)) return false;
    }
  } else {
    if (move.multihit) return false;
    if (secondaries(move).some(effect => !admittedSecondary(effect))) return false;
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

function torrentRelevant(source, move) {
  const event = move.category === 'Physical' ? 'onModifyAtk' : 'onModifySpA';
  return move.type === 'Water' && source.getAbility()[event] === torrent[event];
}

function noDamageOverflow(source, target, move) {
  const attackStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defenseStat = move.category === 'Physical' ? 'def' : 'spd';
  let attack = source.calculateStat(attackStat, Math.max(0, source.boosts[attackStat]));
  if (torrentRelevant(source, move)) attack = Math.ceil(attack * 1.5);
  // Include any permitted post-move defense drop, even the worst -6 stage.
  const defense = target.calculateStat(defenseStat, -6);
  // Torrent is bounded above in attack. Two types, native STAB and critical
  // damage give at most 4 * 1.5 * 1.5; exclude native 16-bit wraparound.
  return ((2 * source.level / 5 + 2) * move.basePower * attack / defense / 50 + 2) * 9 < 65536;
}

interface DamageProfile {
  maximum: number;
  koLower: number;
  koUpper: number;
}

function possibleHP(pokemon) {
  const item = pokemon.getItem();
  const heal = item.onUpdate === berry.onUpdate && item.onEat === berry.onEat && pokemon.hp <= pokemon.maxhp / 2
    ? Math.ceil(pokemon.baseMaxhp / 4) : 0;
  return {lower: pokemon.hp, upper: Math.min(pokemon.maxhp, pokemon.hp + heal)};
}

/** Exact native damage randomness, bounded across every admitted HP regime. */
function damageProfile(battle, source, target, move, targetHP, deadline): DamageProfile | null {
  if (!noDamageOverflow(source, target, move)) return null;
  const originalHP = source.hp;
  const originalPRNG = battle.prng;
  const hpRegimes = torrentRelevant(source, move) ? [1, source.maxhp] : [source.hp];
  let maximum = 0;
  let koLower = 1;
  let koUpper = 0;
  try {
    for (const hp of hpRegimes) {
      source.hp = hp;
      const pending = [{decisions: [], probability: 1}];
      let lowerMass = 0;
      let upperMass = 0;
      let allKO = true;
      let anyKO = false;
      let runs = 0;
      while (pending.length) {
        if (performance.now() >= deadline || ++runs > 64) return null;
        const branch = pending.pop();
        battle.prng = new BranchingPRNG(branch.decisions, 0, (alternatives, random) => {
          for (const alternative of alternatives.slice(1)) {
            pending.push({decisions: [...random.decisions, alternative.decision],
              probability: branch.probability * alternative.probability});
          }
          branch.probability *= alternatives[0].probability;
          return alternatives[0];
        });
        const probe = battle.dex.getActiveMove(move);
        battle.setActiveMove(probe, source, target);
        const nativeDamage = battle.actions.getDamage(source, target, probe, true);
        const damage = nativeDamage === false ? 0 : nativeDamage;
        if (typeof damage !== 'number' || !Number.isFinite(damage)) return null;
        maximum = Math.max(maximum, damage);
        if (damage >= targetHP.upper) lowerMass += branch.probability;
        else allKO = false;
        if (damage >= targetHP.lower) {
          upperMass += branch.probability;
          anyKO = true;
        }
      }
      // Do not promote a rounded sum to certainty. allKO/anyKO inspect every
      // native crit and damage leaf, including guaranteed/no-crit moves.
      koLower = Math.min(koLower, allKO ? 1 : Math.max(0, lowerMass - 1e-12));
      koUpper = Math.max(koUpper, anyKO ? Math.min(1, upperMass + 1e-12) : 0);
    }
  } finally {
    source.hp = originalHP;
    battle.prng = originalPRNG;
  }
  // Raw getDamage precedes the Focus Sash Damage hook. If full HP is
  // possible, its raw KO mass is not a certified terminal lower mass.
  if (target.getItem().onDamage === sash.onDamage && targetHP.upper === target.maxhp) koLower = 0;
  return {maximum, koLower, koUpper};
}

/** Union bound on secondary occurrence, valid conditional on any safe prefix. */
function secondaryUpper(move): number | null {
  let upper = 0;
  for (const effect of secondaries(move)) {
    const chance = effect.chance ?? 100;
    if (!Number.isInteger(chance)) return null;
    let probability = chance >= 100 ? 1 : 0;
    const prng = new BranchingPRNG([], 0, alternatives => {
      probability = alternatives.find(alternative => alternative.decision.value === true)?.probability ?? 0;
      return alternatives[0];
    });
    prng.randomChance(chance, 100);
    upper = Math.min(1, upper + probability);
  }
  return Math.min(1, upper + (upper > 0 && upper < 1 ? 1e-12 : 0));
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
    if (hits === null) return null;
    const firstHP = possibleHP(source);
    const responseHP = possibleHP(responder);
    const firstDamage = damageProfile(probe, source, responder, moves[first], responseHP, deadline);
    if (!firstDamage) return null;
    let firstKOLower = 0;
    let firstKOUpper = 0;
    if (hits === 1) {
      const firstHit = hitProbability(probe, source, responder, moves[first]);
      firstKOLower = firstHit * firstDamage.koLower;
      firstKOUpper = firstHit * firstDamage.koUpper;
    } else if (firstDamage.maximum * hits >= responseHP.lower) {
      return null;
    }
    const responseDamage = damageProfile(probe, responder, source, moves[second], firstHP, deadline);
    if (!responseDamage) return null;
    const secondary = secondaryUpper(moves[first]);
    if (secondary === null) return null;
    const responseHit = hitProbability(probe, responder, source, moves[second]);
    // These are conditional lower bounds on disjoint terminal events, not
    // assumed independent guesses. The response uses 1-aUpper, never 1-aLower.
    const responseKO = (1 - firstKOUpper) * (1 - secondary) * responseHit * responseDamage.koLower;
    const firstMass = firstKOLower === 1 ? 1 : Math.max(0, firstKOLower - 1e-12);
    const responseMass = responseKO === 1 ? 1 : Math.max(0, responseKO - 1e-12);
    if (firstMass === 0 && responseMass === 0) return null;
    return first === 0
      ? {lower: 2 * firstMass - 1, upper: 1 - 2 * responseMass}
      : {lower: 2 * responseMass - 1, upper: 1 - 2 * firstMass};
  };
}
