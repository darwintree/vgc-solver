'use strict';

const {canonicalizeSnapshot, stableStringify} = require('./showdown-adapter');
const {auditNativeRules} = require('./native-rules');
// Native effect counters are currently far below this bound. Keeping the
// private normalizer inside a proven integer range avoids claiming that a
// future allocation remains distinguishable near Number's precision limit.
const MAX_NORMALIZABLE_EFFECT_ORDER = 0xFFFFFFFF;

function effectOrderContext(state) {
  const liveOrders = new Set();
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
  return JSON.stringify(state, function replacer(key, value) {
    if (key !== 'effectOrder' || typeof value !== 'number') return value;
    if (this === state) return context.next;
    return value === 0 ? 0 : context.rank.get(value);
  });
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

function createMemoStateKey(battle, fallback = stateKeyFallback, nativeAudit = undefined) {
  if (!(nativeAudit ?? auditNativeRules(battle))) return fallback;
  const memoKey = snapshot => privateSnapshotKey(snapshot);
  memoKey.private = true;
  return memoKey;
}

module.exports = {
  auditNativeMemoState: auditNativeRules,
  createMemoStateKey,
  effectOrderContext,
  privateSnapshotKey,
};
