'use strict';

// A worker must never trust a parent's Dex object merely because its methods
// passed the native-method audit.  This module creates a serializable profile
// from the worker's own pinned stock data and compares the parent's raw data
// and already-instantiated records against it.  It intentionally has no
// dependency on the solver or adapter.
const fs = require('node:fs');
const path = require('node:path');

const sim = require('@pkmn/sim');
const {Dex: STOCK_DEX} = sim;
const SIM_DIR = path.dirname(require.resolve('@pkmn/sim'));
const DATA_DIR = path.resolve(SIM_DIR, '../data');
const SIM_PACKAGE = require(path.join(SIM_DIR, '../../../package.json'));
const RULE_TABLE = require(path.join(SIM_DIR, 'dex.js')).RuleTable;

const COLLECTIONS = Object.freeze([
  {name: 'abilities', rawIDs: 'Abilities', accessor: 'abilities', cache: 'abilityCache'},
  {name: 'items', rawIDs: 'Items', accessor: 'items', cache: 'itemCache'},
  {name: 'moves', rawIDs: 'Moves', accessor: 'moves', cache: 'moveCache'},
  {name: 'conditions', rawIDs: 'Conditions', accessor: 'conditions', cache: 'conditionCache'},
  {name: 'species', rawIDs: 'Pokedex', accessor: 'species', cache: 'speciesCache'},
  {name: 'formats', rawIDs: 'Rulesets', accessor: 'formats', cache: 'rulesetCache'},
  {name: 'natures', rawIDs: 'Natures', accessor: 'natures', cache: 'natureCache'},
  {name: 'types', rawIDs: 'Types', accessor: 'types', cache: 'typeCache'},
]);

function ownKeysInOrder(value) {
  return Reflect.ownKeys(value).filter(key => typeof key === 'string');
}

function lengthPart(value) {
  return `${value.length}:${value}`;
}

function stableFunctionRegistry() {
  const ids = new Map();
  const seen = new WeakSet();
  const files = fs.readdirSync(DATA_DIR, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name)
    .sort();

  const visit = (value, id) => {
    if (typeof value === 'function') {
      if (!ids.has(value)) ids.set(value, id);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of ownKeysInOrder(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      visit(descriptor.value, `${id}.${lengthPart(key)}`);
    }
  };

  for (const file of files) {
    try {
      visit(require(path.join(DATA_DIR, file)), `data/${file}`);
    } catch {
      // An unavailable optional data module is safe. Any function that the
      // profile later encounters without an ID makes the profile unusable.
    }
  }
  return ids;
}

// Capture the stock reference table once, before any parent-side mutation can
// happen. Rebuilding this map during compare would let a newly assigned
// function acquire a seemingly valid path merely because it is reachable from
// a currently mutated require cache.
const STOCK_FUNCTIONS = stableFunctionRegistry();

function prototypeTag(value) {
  const prototype = Object.getPrototypeOf(value);
  return STOCK_PROTOTYPES.get(prototype) || null;
}

function primitiveSignature(value) {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  if (typeof value === 'boolean') return value ? 'b1' : 'b0';
  if (typeof value === 'string') return `s${lengthPart(value)}`;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'num:NaN';
    if (Object.is(value, -0)) return 'num:-0';
    if (value === Infinity) return 'num:+Inf';
    if (value === -Infinity) return 'num:-Inf';
    return `num:${value}`;
  }
  if (typeof value === 'bigint') return `big${lengthPart(value.toString())}`;
  if (typeof value === 'symbol') {
    const key = Symbol.keyFor(value);
    return key === undefined ? `sym${lengthPart(String(value))}` : `gsym${lengthPart(key)}`;
  }
  return null;
}

function ownPropertySignatures(value, context, seen) {
  const properties = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      context.unsupported = true;
      properties.push(`accessor:${String(key)}`);
      continue;
    }
    const keySignature = typeof key === 'symbol'
      ? `symbol:${lengthPart(Symbol.keyFor(key) ?? String(key))}`
      : `key:${lengthPart(key)}`;
    const flags = `${descriptor.enumerable ? 'e' : '-'}${descriptor.writable ? 'w' : '-'}${descriptor.configurable ? 'c' : '-'}`;
    properties.push(`${keySignature}[${flags}]=${encodeValue(descriptor.value, context, seen)}`);
  }
  return properties.join('|');
}

function encodeValue(value, context, seen = new Map()) {
  const primitive = primitiveSignature(value);
  if (primitive !== null) return primitive;
  if (typeof value === 'function') {
    const id = context.functions.get(value);
    if (!id) {
      context.unsupported = true;
      return 'fn:UNKNOWN';
    }
    return `fn${lengthPart(id)}`;
  }
  if (seen.has(value)) return `ref:${seen.get(value)}`;
  const reference = seen.size;
  seen.set(value, reference);

  if (value instanceof Date || value instanceof RegExp) {
    context.unsupported = true;
    return 'unsupported:date-or-regexp';
  }
  if (value instanceof ArrayBuffer) {
    context.unsupported = true;
    return 'unsupported:arraybuffer';
  }
  if (ArrayBuffer.isView(value)) {
    context.unsupported = true;
    return 'unsupported:typedarray';
  }
  if (value instanceof Map) {
    const entries = [];
    for (const [key, child] of value) {
      entries.push(`${encodeValue(key, context, seen)}=>${encodeValue(child, context, seen)}`);
    }
    const tag = prototypeTag(value);
    if (tag === null) context.unsupported = true;
    return `map:${lengthPart(tag || 'UNKNOWN')}[${entries.join('|')}]<${ownPropertySignatures(value, context, seen)}>`;
  }
  if (value instanceof Set) {
    const entries = [];
    for (const child of value) entries.push(encodeValue(child, context, seen));
    const tag = prototypeTag(value);
    if (tag === null) context.unsupported = true;
    return `set:${lengthPart(tag || 'UNKNOWN')}[${entries.join('|')}]<${ownPropertySignatures(value, context, seen)}>`;
  }

  const tag = prototypeTag(value);
  if (tag === null) {
    context.unsupported = true;
    return 'object:UNKNOWN_PROTO';
  }
  return `obj:${lengthPart(tag)}{${ownPropertySignatures(value, context, seen)}}`;
}

function signature(value, functions) {
  const context = {functions, unsupported: false};
  const encoded = encodeValue(value, context);
  return {encoded, supported: !context.unsupported};
}

function tableSignature(table, functions) {
  if (!table || typeof table !== 'object') return {encoded: 'missing', supported: false};
  const records = [];
  let supported = true;
  for (const id of ownKeysInOrder(table)) {
    const result = signature(table[id], functions);
    supported &&= result.supported;
    // Record order is intentional: native all()/bucket construction may
    // observe the order inside a raw table. Top-level table order is ignored.
    records.push([id, result.encoded]);
  }
  return {records, supported};
}

function stockIDs(collection, dex) {
  const raw = dex.data?.[collection.rawIDs] || {};
  const ids = new Set(ownKeysInOrder(raw));
  const data = dex[collection.accessor];
  const cache = data?.[collection.cache];
  if (cache && typeof cache === 'object') for (const id of ownKeysInOrder(cache)) ids.add(id);
  if (collection.name === 'formats') {
    for (const format of data?.formatsListCache || []) if (format?.id) ids.add(format.id);
  }
  return [...ids];
}

function captureStockPrototypes() {
  const prototypes = new Map([
    [null, 'null'],
    [Object.prototype, 'Object'],
    [Array.prototype, 'Array'],
    [Map.prototype, 'Map'],
    [Set.prototype, 'Set'],
  ]);
  if (RULE_TABLE?.prototype) prototypes.set(RULE_TABLE.prototype, 'effect:RuleTable');
  for (const collection of COLLECTIONS) {
    const data = STOCK_DEX[collection.accessor];
    for (const id of stockIDs(collection, STOCK_DEX)) {
      const value = recordFromAccessor(data, id);
      if (!value || typeof value !== 'object') continue;
      const prototype = Object.getPrototypeOf(value);
      if (!prototypes.has(prototype)) {
        const constructor = prototype?.constructor;
        const name = typeof constructor === 'function' && constructor.name
          ? constructor.name
          : `${collection.name}:${id}`;
        prototypes.set(prototype, `effect:${name}`);
      }
    }
  }
  return prototypes;
}

// Prototype identity is part of the trust boundary. A custom prototype that
// merely sets constructor.name to `DataMove` must not pass the profile.
const STOCK_PROTOTYPES = captureStockPrototypes();

function recordFromAccessor(data, id) {
  if (!data) return undefined;
  try {
    return data.getByID ? data.getByID(id) : data.get(id);
  } catch {
    return undefined;
  }
}

function definitionSignatures(dex, functions) {
  const output = {};
  let supported = true;
  for (const collection of COLLECTIONS) {
    const records = {};
    const data = dex[collection.accessor];
    for (const id of stockIDs(collection, dex)) {
      const value = recordFromAccessor(data, id);
      if (value === undefined) {
        supported = false;
        records[id] = 'missing';
        continue;
      }
      const result = signature(value, functions);
      supported &&= result.supported;
      // Some aliases (notably Hidden Power variants) share record.id while
      // carrying a distinct constructed definition. Keep all stock variants
      // under that id; parent cache comparison remains independent of Map
      // insertion order and accepts only one of these known signatures.
      const variants = records[value.id] || (records[value.id] = []);
      if (!variants.includes(result.encoded)) variants.push(result.encoded);
    }
    output[collection.name] = records;
  }
  return {records: output, supported};
}

function cacheSnapshot(dex, functions) {
  const output = {};
  let supported = true;
  for (const collection of COLLECTIONS) {
    const data = dex[collection.accessor];
    const cache = data?.[collection.cache];
    const cacheRecords = cache && typeof cache === 'object' ? [] : null;
    if (cacheRecords) {
      for (const [key, value] of cacheEntries(cache)) {
        if (typeof key !== 'string') {
          supported = false;
          continue;
        }
        const result = signature(value, functions);
        supported &&= result.supported;
        // Cache key is part of the contract. Alias keys can share record.id,
        // but a key pointing at another record changes native lookup.
        cacheRecords.push([key, result.encoded]);
      }
    }
    let all = null;
    if (Array.isArray(data?.allCache)) {
      all = [];
      for (const value of data.allCache) {
        if (!value || typeof value.id !== 'string') {
          supported = false;
          all.push(null);
        } else {
          const result = signature(value, functions);
          supported &&= result.supported;
          // Same-id aliases (notably Hidden Power variants) have different
          // definitions. Keep the exact signature at each allCache position;
          // checking only id would allow an order-changing swap.
          all.push([value.id, result.encoded]);
        }
      }
    }
    let names = null;
    if (collection.name === 'types' && Array.isArray(data?.namesCache)) {
      names = [...data.namesCache];
    }
    // formatsListCache contains Format objects whose ruleTable is populated by
    // normal Battle setup. It is not an allCache and must not make an
    // otherwise stock parent fail solely because it has been used already.
    output[collection.name] = {cache: cacheRecords, all, names};
  }
  return {records: output, supported};
}

function requestedCacheIDs(collection, dex, cacheKeys) {
  const ids = new Set(cacheKeys[collection.name] || []);
  // The simulator lazily asks Conditions for move/ability/item/species IDs
  // while resolving callbacks. Pre-index those stock IDs in the worker so a
  // normal parent battle does not look "custom" merely because its Map has
  // been warmed. IDs outside these verified tables remain a hard fallback.
  if (collection.name === 'conditions') {
    for (const table of ['Conditions', 'Moves', 'Abilities', 'Items', 'Pokedex', 'Species']) {
      for (const id of ownKeysInOrder(dex.data?.[table] || {})) ids.add(id);
    }
    ids.add('trickroom');
  }
  return ids;
}

function cacheEntries(cache) {
  return cache instanceof Map
    ? [...cache.entries()]
    : ownKeysInOrder(cache).map(id => [id, cache[id]]);
}

function buildStockProfile({dex = STOCK_DEX, cacheKeys = {}, runtimeFormats = []} = {}) {
  if (dex !== STOCK_DEX) throw new TypeError('stock profile must be built from the worker stock Dex');
  const functions = STOCK_FUNCTIONS;
  const rawTables = {};
  let supported = true;
  for (const tableName of Object.keys(dex.data || {}).sort()) {
    const result = tableSignature(dex.data[tableName], functions);
    supported &&= result.supported;
    rawTables[tableName] = result.records;
  }
  // Capture the stock all() order when the collection exposes allCache. A
  // parent is allowed to have no allCache yet, but an existing one must match
  // this exact order because callers can consume it as an ordered bucket.
  for (const collection of COLLECTIONS) {
    const data = dex[collection.accessor];
    if (typeof data?.all === 'function') {
      try { data.all(); } catch { /* unsupported collection is reported below */ }
    }
    if (collection.name === 'types' && typeof data?.names === 'function') {
      try { data.names(); } catch { supported = false; }
    }
    for (const id of requestedCacheIDs(collection, dex, cacheKeys)) {
      if (recordFromAccessor(data, id) === undefined) supported = false;
    }
  }
  const definitions = definitionSignatures(dex, functions);
  const caches = cacheSnapshot(dex, functions);
  const runtimeFormatSignatures = [];
  for (const format of runtimeFormats) {
    if (!format || typeof format.id !== 'string') {
      supported = false;
      continue;
    }
    const result = signature(format, functions);
    supported &&= result.supported;
    runtimeFormatSignatures.push([format.id, result.encoded]);
  }
  supported &&= definitions.supported && caches.supported;
  return Object.freeze({
    schema: 1,
    simulatorVersion: SIM_PACKAGE.version,
    supported,
    rawTables,
    definitions: definitions.records,
    caches: caches.records,
    runtimeFormats: runtimeFormatSignatures,
  });
}

function compareCache(actual, expectedEntries, functions) {
  if (actual === undefined || actual === null) return true;
  if (typeof actual !== 'object') return false;
  if (!Array.isArray(expectedEntries)) return false;
  const expected = new Map(expectedEntries);
  for (const [key, value] of cacheEntries(actual)) {
    if (typeof key !== 'string' || !expected.has(key)) return false;
    const result = signature(value, functions);
    if (!result.supported || result.encoded !== expected.get(key)) return false;
  }
  return true;
}

function compareAll(actual, expected, functions, definitions) {
  if (actual === undefined || actual === null) return true;
  if (expected === null) return false;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => {
    const expectedEntry = expected[index];
    if (!Array.isArray(expectedEntry) || !value || value.id !== expectedEntry[0] ||
        !Object.hasOwn(definitions, value.id)) return false;
    const result = signature(value, functions);
    return result.supported && result.encoded === expectedEntry[1];
  });
}

function compareStockProfile(parentDex, profile, {battle = null} = {}) {
  const reasons = [];
  if (!profile || profile.schema !== 1 || profile.simulatorVersion !== SIM_PACKAGE.version || !profile.supported) {
    return {ok: false, reasons: ['invalid-stock-profile']};
  }
  if (!parentDex || parentDex.currentMod !== 'base' || !parentDex.data) {
    return {ok: false, reasons: ['non-base-dex']};
  }
  const functions = STOCK_FUNCTIONS;
  const expectedTables = Object.keys(profile.rawTables).sort();
  const actualTables = Object.keys(parentDex.data).sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    reasons.push('raw:table-set');
  }
  for (const [tableName, expected] of Object.entries(profile.rawTables)) {
    const actual = parentDex.data[tableName];
    const result = tableSignature(actual, functions);
    if (!result.supported || JSON.stringify(result.records) !== JSON.stringify(expected)) {
      reasons.push(`raw:${tableName}`);
    }
  }
  for (const collection of COLLECTIONS) {
    const data = parentDex[collection.accessor];
    const expected = profile.caches[collection.name];
    if (!compareCache(data?.[collection.cache], expected.cache, functions)) {
      reasons.push(`cache:${collection.name}`);
    }
    if (!compareAll(data?.allCache, expected.all, functions, profile.definitions[collection.name])) {
      reasons.push(`all:${collection.name}`);
    }
    if (collection.name === 'types' && data?.namesCache != null) {
      if (!Array.isArray(expected.names) || data.namesCache.length !== expected.names.length ||
          data.namesCache.some((name, index) => name !== expected.names[index])) {
        reasons.push('names:types');
      }
    }
  }
  if (battle) {
    if (battle.dex !== parentDex || !battle.format || typeof battle.format.id !== 'string') {
      reasons.push('format:runtime-identity');
    } else {
      const expectedEntries = profile.runtimeFormats?.length
        ? profile.runtimeFormats
        : profile.caches.formats?.cache;
      const expected = new Map(expectedEntries || []);
      const expectedFormat = expected.get(battle.format.id);
      const actual = signature(battle.format, functions);
      if (!expectedFormat || !actual.supported || actual.encoded !== expectedFormat) {
        // Includes the compiled RuleTable: worker and parent may share only
        // after identical root format initialization.
        reasons.push('format:runtime');
      }
    }
  }
  return {ok: reasons.length === 0, reasons};
}

module.exports = {
  buildStockProfile,
  compareStockProfile,
  COLLECTIONS,
};
