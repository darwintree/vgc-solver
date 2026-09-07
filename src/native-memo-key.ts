import type {StateKey} from './types';
import {canonicalizeSnapshot, stableStringify} from './showdown-adapter';
import {auditNativeRules} from './native-rules';
// Native effect counters are currently far below this bound. Keeping the
// private normalizer inside a proven integer range avoids claiming that a
// future allocation remains distinguishable near Number's precision limit.
const MAX_NORMALIZABLE_EFFECT_ORDER = 0xFFFFFFFF;

function effectOrderContext(state) {
  const liveOrders = new Set<number>();
  const collect = (value, isRoot = false) => {
    if (!value || typeof value !== 'object') return true;
    if (!isRoot && Object.hasOwn(value, 'effectOrder')) {
      const order = value.effectOrder;
      if (!Number.isSafeInteger(order) || order < 0 || order > MAX_NORMALIZABLE_EFFECT_ORDER) return false;
      if (order > 0) liveOrders.add(order);
    }
    for (const child of Object.values(value)) {
      if (!collect(child)) return false;
    }
    return true;
  };
  if (!collect(state, true) || !Number.isSafeInteger(state.effectOrder) ||
      state.effectOrder < 0 || state.effectOrder > MAX_NORMALIZABLE_EFFECT_ORDER) {
    return null;
  }
  const maximum = liveOrders.size ? Math.max(...liveOrders) : 0;
  // The counter is the next allocation point. If that invariant is absent,
  // retaining absolute values is the only sound representation.
  if (state.effectOrder <= maximum) return null;
  const rank = new Map([...liveOrders].sort((a, b) => a - b)
    .map((order, index) => [order, index + 1]));
  return {rank, next: rank.size + 1};
}

function jsonStringifyMemo(state, context) {
  // Copy only paths containing live order counters, then let native JSON
  // serialize the graph without calling a JS replacer for every property.
  function normalize(value) {
    if (!value || typeof value !== 'object') return value;
    let result = value;
    for (const key of Object.keys(value)) {
      const child = value[key];
      let next = child;
      if (key === 'effectOrder' && typeof child === 'number') {
        if (value === state) next = context.next;
        else next = child === 0 ? 0 : context.rank.get(child);
      } else {
        next = normalize(child);
      }
      if (next === child) continue;
      if (result === value) result = Array.isArray(value) ? value.slice() : {...value};
      Object.defineProperty(result, key, {value: next, enumerable: true, configurable: true, writable: true});
    }
    return result;
  }
  return JSON.stringify(normalize(state));
}

function privateSnapshotKey(snapshot) {
  const state = canonicalizeSnapshot(snapshot);
  const context = effectOrderContext(state);
  if (!context) return `memo:exact:${stableStringify(state)}`;
  return `memo:relative-effect-order:${jsonStringifyMemo(state, context)}`;
}

function stateKeyFallback(snapshot) {
  return stableStringify(canonicalizeSnapshot(snapshot));
}

function createMemoStateKey(battle, fallback: StateKey = stateKeyFallback, nativeAudit?: boolean): StateKey {
  if (!(nativeAudit ?? auditNativeRules(battle))) return fallback;
  const memoKey = snapshot => privateSnapshotKey(snapshot);
  memoKey.private = true;
  return memoKey;
}

export {
  auditNativeRules as auditNativeMemoState,
  createMemoStateKey,
  effectOrderContext,
  privateSnapshotKey,
};
