import type {Snapshot, StateKey, Outcome} from './types';
import {Pokemon, Side} from '@pkmn/sim';
import {auditNativeRules} from './native-rules';

interface PPInterval {min: number; max: number}
interface TrackedSlot {
  value: number;
  slotIndex: number;
  interval: PPInterval;
  delta: number;
}
interface PPIdentity {
  side: Side;
  index: number;
  pokemon: Pokemon;
  moveSlots: Pokemon['moveSlots'];
  baseMoveSlots: Pokemon['baseMoveSlots'];
  slots: Pokemon['moveSlots'];
}
interface PPTracker {
  safe: boolean;
  phase: string;
  currentSlot: TrackedSlot | null;
  slots: TrackedSlot[];
  slotByObject: WeakMap<object, TrackedSlot>;
  requestDescriptors: (() => void)[];
  restores: (() => void)[];
  identity: PPIdentity[];
  markUnsafe(): void;
  identityIntact(): boolean;
  finish(): boolean;
  enterSnapshot(): void;
  capture(): {intervals: PPInterval[]; deltas: number[]};
}
interface PPTemplate {
  inputShape: string;
  intervals: PPInterval[];
  outcomes: (Outcome & {deltas: number[]})[];
}

const NATIVE_DEDUCT_PP = Pokemon.prototype.deductPP;
const NATIVE_GET_MOVES = Pokemon.prototype.getMoves;
const NATIVE_GET_MOVE_DATA = Pokemon.prototype.getMoveData;
const NATIVE_EMIT_REQUEST = Side.prototype.emitRequest;
const PP_AUDIT_TOKEN = Symbol('native-pp-audit');

function ppBucket(value) {
  if (value === 0) return 0;
  if (Number.isSafeInteger(value) && value > 0) return 1;
  return null;
}

function canonicalizePPKey(snapshot) {
  // Mirror canonicalizeSnapshot's history normalization; this private key
  // may conservatively miss on property-order differences.
  const state = {...snapshot};
  state.log = [];
  state.inputLog = [];
  state.messageLog = [];
  state.hints = [];
  state.lastMoveLine = -1;
  state.sentLogPos = 0;
  state.sentEnd = false;
  state.sentRequests = true;
  return state;
}

function walkPokemon(snapshot, fn) {
  for (let si = 0; si < (snapshot.sides || []).length; si++) {
    const side = snapshot.sides[si];
    for (let pi = 0; pi < (side.pokemon || []).length; pi++) fn(side.pokemon[pi], si, pi);
  }
}

function slotShape(snapshot) {
  const result = [];
  walkPokemon(snapshot, (pokemon, si, pi) => {
    const slots = Array.isArray(pokemon.moveSlots) ? pokemon.moveSlots : [];
    const base = Array.isArray(pokemon.baseMoveSlots) ? pokemon.baseMoveSlots : null;
    result.push({
      si, pi,
      moves: slots.map(slot => ({id: slot.id, move: slot.move, maxpp: slot.maxpp})),
      base: base && base.map(slot => ({id: slot.id, move: slot.move, maxpp: slot.maxpp})),
      alias: base === null ? null : base.map((slot, i) => slots[i] === slot),
    });
  });
  return JSON.stringify(result);
}

function ppBaseKey(snapshot, stateKey?: StateKey) {
  // Only PP slots change. Snapshot graphs are already JSON-normalized, so
  // unrelated subtrees can be read directly by the serializer.
  const copy = canonicalizePPKey(snapshot);
  if (snapshot.sides) copy.sides = snapshot.sides.map(side => ({
    ...side,
    pokemon: side.pokemon?.map(pokemon => {
      const result = {...pokemon};
      for (const name of ['moveSlots', 'baseMoveSlots']) {
        if (Array.isArray(pokemon[name])) {
          result[name] = pokemon[name].map(slot => ({...slot, pp: ppBucket(slot.pp)}));
        }
      }
      return result;
    }),
  }));
  // PP keys are private and may conservatively miss when property insertion
  // order differs. Native JSON avoids the sorted-replacer callback cost; the
  // public state key remains unchanged and continues to sort properties.
  return JSON.stringify(copy);
}

function actionCommand(action) {
  return typeof action === 'string' ? action : action?.command;
}

function ppSnapshotKey(snapshot, action1, action2, stateKey, cache) {
  const base = cache ? cache.baseKey(snapshot, stateKey) : ppBaseKey(snapshot, stateKey);
  return `${base}|${JSON.stringify([actionCommand(action1), actionCommand(action2)])}`;
}

function nativeMethodsAreUsable(battle, nativeAudit = undefined) {
  if (!(nativeAudit ?? auditNativeRules(battle))) return false;
  for (const side of battle.sides || []) {
    if (side.emitRequest !== NATIVE_EMIT_REQUEST) return false;
    for (const pokemon of side.pokemon || []) {
      if (pokemon.deductPP !== NATIVE_DEDUCT_PP || pokemon.getMoves !== NATIVE_GET_MOVES ||
          pokemon.getMoveData !== NATIVE_GET_MOVE_DATA) return false;
    }
  }
  return true;
}

function hasUnsafeGetMovesPath(pokemon) {
  if (pokemon.volatiles?.dynamax) return true;
  return (pokemon.moveSlots || []).some(slot =>
    slot.id === 'return' || slot.id === 'frustration' || slot.id === 'curse');
}

function patchMethod(object, name, replacement, restore) {
  const own = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, {value: replacement, configurable: true, writable: true});
  restore.push(() => {
    if (own) Object.defineProperty(object, name, own);
    else delete object[name];
  });
}

function installTracker(battle, audited = false) {
  if (!audited && !nativeMethodsAreUsable(battle)) return null;
  const tracker = {
    safe: true,
    phase: 'idle',
    currentSlot: null,
    slots: [],
    slotByObject: new WeakMap(),
    requestDescriptors: [],
    restores: [],
    markUnsafe() { this.safe = false; },
  } as PPTracker;

  const identity = [];
  const plans = [];
  for (let si = 0; si < (battle.sides || []).length; si++) {
    const side = battle.sides[si];
    for (let pi = 0; pi < (side.pokemon || []).length; pi++) {
      const pokemon = side.pokemon[pi];
      identity.push({side, index: pi, pokemon, moveSlots: pokemon.moveSlots, baseMoveSlots: pokemon.baseMoveSlots, slots: pokemon.moveSlots?.slice()});
      if (!Array.isArray(pokemon.moveSlots) || !Array.isArray(pokemon.baseMoveSlots) ||
          pokemon.baseMoveSlots.length !== pokemon.moveSlots.length ||
          pokemon.baseMoveSlots.some((slot, index) => slot !== pokemon.moveSlots[index])) return null;
      for (const slot of pokemon.moveSlots) {
        const descriptor = Object.getOwnPropertyDescriptor(slot, 'pp');
        if (!descriptor || !('value' in descriptor) || !descriptor.configurable ||
            !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
        plans.push({slot, descriptor});
      }
    }
  }
  tracker.identity = identity;
  for (const plan of plans) {
    const {slot, descriptor} = plan;
    const record = {
      value: descriptor.value,
      slotIndex: tracker.slots.length,
      interval: {min: 0, max: Infinity},
      delta: 0,
    };
    tracker.slots.push(record);
    tracker.slotByObject.set(slot, record);
    Object.defineProperty(slot, 'pp', {
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
      get() {
        if (tracker.phase === 'getMoves') {
          const bucket = ppBucket(record.value);
          if (bucket === 1) {
            record.interval.min = Math.max(record.interval.min, record.delta + 1);
          } else if (bucket === 0) {
            record.interval.min = Math.max(record.interval.min, record.delta);
            record.interval.max = Math.min(record.interval.max, record.delta);
          } else {
            tracker.markUnsafe();
          }
        } else if (!['deductPP', 'snapshot'].includes(tracker.phase)) {
          tracker.markUnsafe();
        }
        return record.value;
      },
      set(value) {
        if (tracker.phase !== 'deductPP' || tracker.currentSlot !== record ||
            !Number.isSafeInteger(value) || value < 0) {
          tracker.markUnsafe();
        }
        record.value = value;
      },
    });
    tracker.restores.push(() => Object.defineProperty(slot, 'pp', {...descriptor, value: record.value}));
  }

  function patchRequestPP(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      if (key === 'pp' && Number.isSafeInteger(descriptor.value) && descriptor.configurable) {
        let current = descriptor.value;
        Object.defineProperty(value, key, {
          enumerable: descriptor.enumerable,
          configurable: true,
          get() {
            if (!['emitRequest', 'snapshot'].includes(tracker.phase)) tracker.markUnsafe();
            return current;
          },
          set(next) { tracker.markUnsafe(); current = next; },
        });
        tracker.requestDescriptors.push(() => Object.defineProperty(value, key, {...descriptor, value: current}));
      } else {
        patchRequestPP(descriptor.value, seen);
      }
    }
  }

  for (const side of battle.sides || []) {
    patchMethod(side, 'emitRequest', function (...args) {
      patchRequestPP(args[0] || this.activeRequest);
      const old = tracker.phase;
      tracker.phase = 'emitRequest';
      try { return NATIVE_EMIT_REQUEST.apply(this, args); } finally { tracker.phase = old; }
    }, tracker.restores);
  }

  for (const {pokemon} of identity) {
    patchMethod(pokemon, 'deductPP', function (move, amount, target) {
      // Native deductPP resolves exactly one move slot. Resolve that slot once
      // before entering the guarded call; scanning every tracked slot here was
      // visible in the hot path and was unnecessary under the native audit.
      const moveData = NATIVE_GET_MOVE_DATA.call(this, move);
      const record = tracker.slotByObject.get(moveData) || null;
      const before = record ? record.value : null;
      const old = tracker.phase;
      tracker.phase = 'deductPP';
      tracker.currentSlot = record;
      let result;
      try { result = NATIVE_DEDUCT_PP.call(this, move, amount, target); }
      finally {
        tracker.currentSlot = null;
        tracker.phase = old;
      }
      const effective = amount || 1;
      if (!Number.isSafeInteger(effective) || effective <= 0 || !Number.isSafeInteger(result) || result < 0) {
        tracker.markUnsafe();
        return result;
      }
      if (record) {
        if (before - record.value !== result || result > before) tracker.markUnsafe();
        if (result === effective) {
          record.interval.min = Math.max(record.interval.min, record.delta + effective);
        } else {
          const exact = record.delta + result;
          record.interval.min = Math.max(record.interval.min, exact);
          record.interval.max = Math.min(record.interval.max, exact);
        }
        record.delta += result;
        if (!Number.isSafeInteger(record.delta) || record.delta < 0) tracker.markUnsafe();
      } else if (result !== 0) {
        tracker.markUnsafe();
      }
      return result;
    }, tracker.restores);

    patchMethod(pokemon, 'getMoves', function (lockedMove, restrictData) {
      if (!lockedMove && hasUnsafeGetMovesPath(this)) tracker.markUnsafe();
      const old = tracker.phase;
      tracker.phase = 'getMoves';
      let result;
      try { result = NATIVE_GET_MOVES.call(this, lockedMove, restrictData); }
      finally { tracker.phase = old; }
      // Native choose validation only consumes id/target/disabled. PP is read
      // by native request JSON serialization, which is admitted through emitRequest.
      for (const move of result || []) {
        if (!move || !Object.hasOwn(move, 'pp')) continue;
        const descriptor = Object.getOwnPropertyDescriptor(move, 'pp');
        if (!descriptor || !descriptor.configurable || !('value' in descriptor)) { tracker.markUnsafe(); continue; }
        let current = descriptor.value;
        Object.defineProperty(move, 'pp', {
          enumerable: descriptor.enumerable,
          configurable: true,
          get() {
            if (!['emitRequest', 'snapshot'].includes(tracker.phase)) tracker.markUnsafe();
            return current;
          },
          set(value) { tracker.markUnsafe(); current = value; },
        });
        tracker.requestDescriptors.push(() => Object.defineProperty(move, 'pp', descriptor));
      }
      return result;
    }, tracker.restores);
  }

  tracker.identityIntact = function () {
    return tracker.identity.every(entry => {
      return entry.side.pokemon[entry.index] === entry.pokemon &&
        entry.pokemon.moveSlots === entry.moveSlots &&
        entry.pokemon.baseMoveSlots === entry.baseMoveSlots &&
        entry.moveSlots.length === entry.slots.length &&
        entry.moveSlots.every((slot, index) => slot === entry.slots[index]);
    });
  };
  tracker.finish = function () {
    for (const restore of tracker.requestDescriptors.splice(0).reverse()) restore();
    for (const restore of tracker.restores.splice(0).reverse()) restore();
    return this.safe;
  };
  tracker.enterSnapshot = function () { this.phase = 'snapshot'; };
  tracker.capture = function () {
    const intervals = Array.from({length: this.slots.length}) as PPInterval[];
    const deltas = Array.from({length: this.slots.length}) as number[];
    for (const record of this.slots) {
      intervals[record.slotIndex] = {min: record.interval.min, max: record.interval.max};
      deltas[record.slotIndex] = record.delta;
    }
    return {
      intervals,
      deltas,
    };
  };
  return tracker;
}

function intersectPPIntervals(target: PPInterval[], source: PPInterval[]): boolean {
  if (target.length !== source.length) return false;
  for (let i = 0; i < target.length; i++) {
    target[i].min = Math.max(target[i].min, source[i].min);
    target[i].max = Math.min(target[i].max, source[i].max);
    if (target[i].min > target[i].max) return false;
  }
  return true;
}

function ppValuesWithinIntervals(values: number[], intervals: PPInterval[]): boolean {
  return values.length === intervals.length && values.every((value, index) =>
    Number.isSafeInteger(value) && value >= intervals[index].min && value <= intervals[index].max
  );
}

function setOutputPPFromDelta(snapshot, input, deltas) {
  if (input.length !== deltas.length) return false;
  const output = input.map((value, index) => {
    const result = value - deltas[index];
    return Number.isSafeInteger(value) && Number.isSafeInteger(deltas[index]) &&
      deltas[index] >= 0 && Number.isSafeInteger(result) && result >= 0 ? result : null;
  });
  if (output.some(value => value === null)) return false;
  setOutputPP(snapshot, output);
  return true;
}

function readOutputPP(snapshot) {
  const values = [];
  walkPokemon(snapshot, pokemon => {
    for (const slot of pokemon.moveSlots || []) values.push(slot.pp);
  });
  return values;
}

function setOutputPP(snapshot, values) {
  let index = 0;
  walkPokemon(snapshot, pokemon => {
    for (const slot of pokemon.moveSlots || []) slot.pp = values[index++];
  });
}

function makeCacheKey(snapshot, action1, action2, stateKey, cache) {
  return ppSnapshotKey(snapshot, action1, action2, stateKey, cache);
}

class PPTransitionCache {
  declare templates: Map<string, PPTemplate>;
  declare baseKeys: WeakMap<object, string>;
  declare shapes: WeakMap<object, string>;
  declare cacheHits: number;
  declare cacheMisses: number;
  declare rejected: number;

  constructor() {
    this.templates = new Map();
    this.baseKeys = new WeakMap();
    this.shapes = new WeakMap();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.rejected = 0;
  }
  clear() {
    this.templates.clear();
    this.baseKeys = new WeakMap();
    this.shapes = new WeakMap();
  }
  baseKey(snapshot: Snapshot, stateKey: StateKey): string {
    let key = this.baseKeys.get(snapshot);
    if (key === undefined) {
      key = ppBaseKey(snapshot, stateKey);
      this.baseKeys.set(snapshot, key);
    }
    return key;
  }
  shape(snapshot: Snapshot): string {
    let shape = this.shapes.get(snapshot);
    if (shape === undefined) {
      shape = slotShape(snapshot);
      this.shapes.set(snapshot, shape);
    }
    return shape;
  }
}

function createPPTransitionCache() { return new PPTransitionCache(); }

function auditPPBattle(battle, nativeAudit = undefined) {
  return nativeMethodsAreUsable(battle, nativeAudit) ? PP_AUDIT_TOKEN : null;
}

function isPPAuditToken(value) { return value === PP_AUDIT_TOKEN; }

export {
  PPTransitionCache,
  createPPTransitionCache,
  installTracker,
  makeCacheKey,
  ppBaseKey,
  nativeMethodsAreUsable,
  auditPPBattle,
  isPPAuditToken,
  setOutputPP,
  readOutputPP,
  intersectPPIntervals,
  ppValuesWithinIntervals,
  setOutputPPFromDelta,
  slotShape,
};
