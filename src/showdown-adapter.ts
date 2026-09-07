import type {PokemonSet} from '@pkmn/sim';
import type {Action, Snapshot, Transition, TransitionOptions} from './types';
import {Battle, State, toID} from '@pkmn/sim';
import {BranchingPRNG, FIXED_SEED} from './branching-prng';
import {installSimulatorOptimizations} from './simulator-optimizations';
import {auditPPBattle, createPPTransitionCache, installTracker, intersectPPIntervals, isPPAuditToken, makeCacheKey, nativeMethodsAreUsable, ppValuesWithinIntervals, readOutputPP, setOutputPPFromDelta, slotShape} from './pp-transition-cache';

const nativeBattleToJSON = Battle.prototype.toJSON;
const SERIALIZER_METHODS = Object.freeze([
  'serializeBattle', 'serializeField', 'serializeSide', 'serializePokemon',
  'serializeChoice', 'serializeActiveMove', 'serializeWithRefs',
  'isActiveMove', 'isReferable', 'toRef', 'serialize',
]);
const nativeSerializerMethods = Object.freeze(Object.fromEntries(
  SERIALIZER_METHODS.map(name => [name, State[name]])
));

function hasNativeSerializerMethods() {
  return SERIALIZER_METHODS.every(name => State[name] === nativeSerializerMethods[name]);
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

// Match JSON.stringify's value normalization without serializing the complete
// state. State.serializeWithRefs has already rejected unsupported object types.
function normalizeJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }
  if (Array.isArray(value)) {
    const result = [];
    result.length = value.length;
    for (let i = 0; i < value.length; i++) {
      const normalized = Object.prototype.hasOwnProperty.call(value, i)
        ? normalizeJSON(value[i]) : undefined;
      result[i] = normalized === undefined ? null : normalized;
    }
    return result;
  }
  if (typeof value === 'object') {
    // Build a detached plain graph. Defining __proto__ as an own data key
    // preserves JSON.stringify semantics without mutating simulator objects.
    const result = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined || typeof item === 'function') continue;
      const normalized = normalizeJSON(item);
      if (key === '__proto__') {
        Object.defineProperty(result, key, {
          value: normalized, enumerable: true, configurable: true, writable: true,
        });
      } else {
        result[key] = normalized;
      }
    }
    return result;
  }
  return undefined;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item) ?? 'null').join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Remove history/PRNG data which must not distinguish otherwise equal states. */
function canonicalizeSnapshot(raw) {
  const state = {...raw};
  state.log = [];
  state.inputLog = [];
  state.messageLog = [];
  state.hints = [];
  state.lastMoveLine = -1;
  state.sentLogPos = 0;
  state.sentEnd = false;
  state.sentRequests = true;
  state.prng = FIXED_SEED;
  state.prngSeed = FIXED_SEED;
  return state;
}

function snapshotBattle(battle: Battle): Snapshot {
  // A custom serializer may retain arbitrary aliases or rely on different
  // omission rules. Keep the established JSON fallback unless both native
  // entry points are still the audited implementations.
  const state = canonicalizeSnapshot(battle.toJSON());
  if (battle.toJSON !== nativeBattleToJSON || !hasNativeSerializerMethods()) {
    return cloneJSON(state);
  }

  // The native serializer creates a fresh graph except for Pokemon.set. Copy
  // every set independently to preserve the old JSON roundtrip semantics,
  // including splitting accidental aliases between Pokemon objects.
  for (const side of state.sides || []) {
    for (const pokemon of side.pokemon || []) {
      const set = pokemon.set;
      if (!set || typeof set !== 'object') continue;
      pokemon.set = cloneJSON(set);
    }
  }
  return normalizeJSON(state);
}

function restoreBattle(snapshot: Snapshot): Battle {
  // @pkmn/sim 0.10.11 reconstructs all mutable state except log and Pokemon.set.
  // Detach those retained references; copying the entire snapshot duplicates its work.
  return Battle.fromJSON({
    ...snapshot,
    log: snapshot.log.slice(),
    sides: snapshot.sides.map(side => ({
      ...side,
      pokemon: side.pokemon.map(pokemon => ({...pokemon, set: cloneJSON(pokemon.set)})),
    })),
  });
}

function stateKey(snapshot) {
  return stableStringify(canonicalizeSnapshot(snapshot));
}

function createBattle(p1Set: Partial<PokemonSet>, p2Set: Partial<PokemonSet>): Battle {
  const battle = new Battle({
    formatid: toID('gen9customgame'),
    debug: true,
    strictChoices: true,
    seed: FIXED_SEED,
    // Showdown supplies defaults for omitted set fields during construction.
    p1: {name: 'P1', team: [p1Set as PokemonSet]},
    p2: {name: 'P2', team: [p2Set as PokemonSet]},
  });

  if (battle.requestState === 'teampreview') {
    battle.makeChoices('team 1', 'team 1');
  }
  if (battle.requestState !== 'move' && !battle.ended) {
    throw new Error(`Expected a move request, got ${battle.requestState}`);
  }
  return battle;
}

function setHP(battle, sideID, hp) {
  const side = battle[sideID];
  const pokemon = side.active[0];
  if (!pokemon) throw new Error(`${sideID} has no active Pokemon`);
  if (!Number.isInteger(hp) || hp <= 0 || hp > pokemon.maxhp) {
    throw new Error(`Invalid HP ${hp} for ${pokemon.name} (max ${pokemon.maxhp})`);
  }
  pokemon.hp = hp;
  pokemon.fainted = false;
}

function setMovePP(battle, sideID, moveName, pp) {
  const pokemon = battle[sideID].active[0];
  const id = toID(moveName);
  if (!Number.isInteger(pp) || pp < 0) throw new Error(`Invalid PP: ${pp}`);

  let found = false;
  for (const slots of [pokemon.moveSlots, pokemon.baseMoveSlots]) {
    for (const slot of slots) {
      if (slot.id === id) {
        slot.pp = pp;
        found = true;
      }
    }
  }
  if (!found) throw new Error(`${pokemon.name} does not have ${moveName}`);
}

function refreshMoveRequest(battle) {
  for (const side of battle.sides) {
    side.clearChoice();
    side.activeRequest = undefined;
  }
  battle.makeRequest('move');
}

function legalActions(battle: Battle, sideIndex: number): Action[] {
  const side = battle.sides[sideIndex];
  const request = side.activeRequest;
  const moves = request && 'active' in request && request.active[0]?.moves;

  if (!moves) {
    if (battle.ended) return [];
    throw new Error(`No move request for ${side.id}`);
  }

  const actions = [];
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    if (move.pp > 0 && !move.disabled) {
      actions.push({
        name: move.move,
        id: move.id,
        command: `move ${i + 1}`,
      });
    }
  }

  // Showdown automatically chooses Struggle when every displayed move is unusable.
  if (actions.length === 0) {
    actions.push({name: 'Struggle', id: 'struggle', command: 'auto'});
  }
  return actions;
}

function terminalUtility(battle: Battle): number | null {
  if (!battle.ended) return null;
  if (battle.winner === battle.p1.name) return 1;
  if (battle.winner === battle.p2.name) return -1;
  return 0;
}

class TransitionDeadlineExceeded extends Error {
  constructor() {
    super('Transition deadline reached');
    this.name = 'TransitionDeadlineExceeded';
  }
}

/**
 * Enumerate exactly the finite random calls made while resolving one turn.
 * Each replay starts from the same serialized Showdown state.
 * Outcomes carry either a continuing snapshot or a terminal utility, plus probability.
 */
function enumerateTurn(snapshot: Snapshot, p1Action: Pick<Action, 'command'>, p2Action: Pick<Action, 'command'>, options: TransitionOptions = {}): Transition {
  const maxRuns = options.maxSimulatorRunsPerTransition ?? 100000;
  const deadline = Number.isFinite(options.deadline) ? options.deadline : null;
  const isCancelled = deadline === null ? null : () => performance.now() >= deadline;
  let runs = 0;
  const incomplete = (): Transition => ({outcomes: [], simulatorRuns: runs, complete: false});
  if (isCancelled?.()) return incomplete();
  const outcomeKey = options.outcomeKey ?? stateKey;
  const ppCache = options.ppCache;
  let ppEligible = false;
  if (ppCache) {
    // Cache lookup is after the audit. Without the solve-scoped token, audit
    // this transition before consulting any existing template.
    ppEligible = isPPAuditToken(options.ppAudit);
    if (!ppEligible) {
      const auditBattle = restoreBattle(snapshot);
      ppEligible = nativeMethodsAreUsable(auditBattle);
    }
  }
  const cacheKey = ppEligible ? makeCacheKey(snapshot, p1Action, p2Action, stateKey, ppCache) : null;
  const inputShape = ppEligible ? slotShape(snapshot) : null;

  if (ppEligible && cacheKey) {
    const template = ppCache.templates.get(cacheKey);
    if (template && template.inputShape === inputShape) {
      const inputPP = readOutputPP(snapshot);
      if (ppValuesWithinIntervals(inputPP, template.intervals)) {
        const replayed = [];
        let replayable = true;
        for (const outcomeTemplate of template.outcomes) {
          if (isCancelled?.()) return incomplete();
          const outcome = outcomeTemplate.snapshot
            ? {snapshot: cloneJSON(outcomeTemplate.snapshot)}
            : {utility: outcomeTemplate.utility};
          if (outcome.snapshot && !setOutputPPFromDelta(outcome.snapshot, inputPP, outcomeTemplate.deltas)) {
            replayable = false;
            break;
          }
          replayed.push({...outcome, probability: outcomeTemplate.probability});
        }
        if (replayable) {
          ppCache.cacheHits++;
          return {outcomes: replayed, simulatorRuns: 0, cacheHits: 1};
        }
      }
      ppCache.rejected++;
    }
    ppCache.cacheMisses++;
  }

  const pending = [{decisions: [], probability: 1}];
  const outcomes = new Map();
  const templateBranches = [];
  let cacheSafe = ppEligible;

  while (pending.length) {
    if (isCancelled?.()) return incomplete();
    if (++runs > maxRuns) {
      throw new Error(`Random branch limit (${maxRuns}) exceeded`);
    }

    const branch = pending.pop();
    const battle = restoreBattle(snapshot);
    // Audit and install the PP accessors before simulator optimizations add
    // their private wrappers; event identity remains untouched during replay.
    const tracker = ppEligible ? installTracker(battle, true) : null;
    if (ppCache && !tracker) cacheSafe = false;
    installSimulatorOptimizations(battle, {eventPlan: options.eventPlan || null});
    const prng = new BranchingPRNG(branch.decisions, 0, (alternatives, source) => {
      if (isCancelled?.()) throw new TransitionDeadlineExceeded();
      for (let index = 1; index < alternatives.length; index++) {
        const alternative = alternatives[index];
        const probability = branch.probability * alternative.probability;
        if (probability === 0) continue;
        pending.push({
          decisions: [...source.decisions, alternative.decision],
          probability,
        });
      }
      branch.probability *= alternatives[0].probability;
      return alternatives[0];
    });
    // The facade implements the public PRNG methods; native private rng state is unused.
    battle.prng = prng as unknown as Battle['prng'];

    let utility;
    let next;
    let captured;
    try {
      battle.makeChoices(p1Action.command, p2Action.command);
      if (isCancelled?.()) throw new TransitionDeadlineExceeded();
      if (prng.cursor !== prng.decisions.length) {
        throw new Error('Random replay completed without consuming its full prefix');
      }
      utility = terminalUtility(battle);
      if (tracker) tracker.enterSnapshot();
      next = utility === null ? snapshotBattle(battle) : null;
      if (tracker) {
        captured = tracker.capture();
        if (next && (slotShape(next) !== inputShape || !tracker.identityIntact())) tracker.markUnsafe();
      }
    } catch (error) {
      if (error instanceof TransitionDeadlineExceeded) return incomplete();
      throw error;
    } finally {
      if (tracker && !tracker.finish()) cacheSafe = false;
    }

    if (ppCache && tracker && !tracker.safe) cacheSafe = false;
    const key = next ? outcomeKey(next) : `terminal:${utility}`;
    if (ppCache && tracker && captured) {
      templateBranches.push({
        key,
        snapshot: next,
        utility,
        probability: branch.probability,
        intervals: captured.intervals,
        deltas: captured.deltas,
      });
    }

    const existing = outcomes.get(key);
    if (existing) {
      existing.probability += branch.probability;
    } else {
      const outcome = next ? {snapshot: next} : {utility};
      outcomes.set(key, {...outcome, probability: branch.probability});
    }
  }

  const result = [...outcomes.values()];
  const total = result.reduce((sum, outcome) => sum + outcome.probability, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`Transition probabilities sum to ${total}, not 1`);
  }
  for (const outcome of result) outcome.probability /= total;

  if (ppCache && cacheSafe && templateBranches.length === runs) {
    if (isCancelled?.()) return incomplete();
    const inputPP = readOutputPP(snapshot);
    const slotCount = inputPP.length;
    const intervals = Array.from({length: slotCount}, () => ({min: 0, max: Infinity}));
    const grouped = new Map();
    let templateValid = true;
    for (const branch of templateBranches) {
      if (isCancelled?.()) return incomplete();
      if (!branch.intervals || branch.intervals.length !== slotCount ||
          !branch.deltas || branch.deltas.length !== slotCount ||
          !intersectPPIntervals(intervals, branch.intervals)) {
        templateValid = false;
        break;
      }
      const values = inputPP.map((value, index) => value - branch.deltas[index]);
      if (values.some((value, index) => !Number.isSafeInteger(value) || value < 0 ||
          !Number.isSafeInteger(branch.deltas[index]) || branch.deltas[index] < 0) ||
          (branch.snapshot && readOutputPP(branch.snapshot).some((value, index) => value !== values[index]))) {
        templateValid = false;
        break;
      }
      const key = branch.key;
      let outcome = grouped.get(key);
      if (!outcome) {
        outcome = branch.snapshot
          ? {snapshot: branch.snapshot, guards: [], probability: 0}
          : {utility: branch.utility, guards: [], probability: 0};
        grouped.set(key, outcome);
      }
      outcome.probability += branch.probability;
      outcome.guards.push(branch.deltas);
    }
    if (templateValid) {
      if (isCancelled?.()) return incomplete();
      const total = [...grouped.values()].reduce((sum, outcome) => sum + outcome.probability, 0);
      for (const outcome of grouped.values()) {
        if (isCancelled?.()) return incomplete();
        outcome.probability /= total;
        const deltas = outcome.guards[0] || Array(slotCount).fill(0);
        if (outcome.guards.some(candidate => candidate.length !== deltas.length ||
            candidate.some((value, index) => value !== deltas[index]))) {
          templateValid = false;
          break;
        }
        outcome.deltas = deltas;
        delete outcome.guards;
      }
      if (templateValid) ppCache.templates.set(cacheKey, {inputShape, intervals, outcomes: [...grouped.values()]});
    }
  }
  return {outcomes: result, simulatorRuns: runs, cacheHits: 0};
}

export {
  createBattle,
  enumerateTurn,
  legalActions,
  refreshMoveRequest,
  restoreBattle,
  setHP,
  setMovePP,
  snapshotBattle,
  stateKey,
  canonicalizeSnapshot,
  stableStringify,
  terminalUtility,
  createPPTransitionCache,
  auditPPBattle,
};
