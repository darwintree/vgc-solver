// This module is deliberately independent from the snapshot adapter.  The
// simulator and the cost/event-index code both use this audit; keeping it at
// the simulator boundary avoids an adapter -> simulator -> audit cycle.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sim from '@pkmn/sim';
const {Battle, Pokemon} = sim;
const SIM_DIR = path.dirname(require.resolve('@pkmn/sim'));
const SIM_DEX = require(path.join(SIM_DIR, 'dex.js')).Dex;
const SIM_STATE = require(path.join(SIM_DIR, 'state.js')).State;

const SIM_VERSION = require(path.join(
  path.dirname(require.resolve('@pkmn/sim')),
  '../../../package.json'
)).version;

const CORE_METHOD_NAMES = [
  'comparePriority', 'resolvePriority', 'initEffectState', 'runEvent',
  'priorityEvent', 'getCallback', 'singleEvent', 'eachEvent', 'speedSort',
];
const CORE_METHODS = Object.freeze(Object.fromEntries(
  CORE_METHOD_NAMES.map(name => [name, Battle.prototype[name]])
));
const NATIVE_REDIRECT_ORDER = Battle.compareRedirectOrder;
const POKEMON_METHODS = Object.freeze(Object.fromEntries(
  ['getAbility', 'getItem', 'getStatus'].map(name => [name, Pokemon.prototype[name]])
));

function classExports(file, names) {
  const exports = require(path.join(SIM_DIR, file));
  return names.map(name => exports[name]).filter(value => typeof value === 'function');
}

const NATIVE_CLASSES = [
  Battle,
  Pokemon,
  ...classExports('side.js', ['Side']),
  ...classExports('field.js', ['Field']),
  ...classExports('battle-queue.js', ['BattleQueue']),
  ...classExports('battle-actions.js', ['BattleActions']),
  ...classExports('dex.js', ['ModdedDex', 'Dex', 'RuleTable']),
  ...classExports('dex-data.js', ['BasicEffect', 'Nature', 'DexNatures', 'TypeInfo', 'DexTypes', 'DexStats']),
  ...classExports('dex-abilities.js', ['Ability', 'DexAbilities']),
  ...classExports('dex-conditions.js', ['Condition', 'DexConditions']),
  ...classExports('dex-items.js', ['Item', 'DexItems']),
  ...classExports('dex-moves.js', ['DataMove', 'DexMoves']),
  ...classExports('dex-species.js', ['Species', 'Learnset', 'DexSpecies', 'DexLearnsets']),
  ...classExports('dex-formats.js', ['Format', 'DexFormats']),
  ...classExports('state.js', ['State']),
];

// state.js pins exactly these nine constructors in State.REFERABLE.
const NATIVE_REFERABLE_CLASSES = new Set([
  Battle,
  ...classExports('field.js', ['Field']),
  ...classExports('side.js', ['Side']),
  Pokemon,
  SIM_DEX.Condition,
  SIM_DEX.Ability,
  SIM_DEX.Item,
  SIM_DEX.Move,
  SIM_DEX.Species,
]);

function descriptorSnapshot(object) {
  return new Map(Reflect.ownKeys(object).map(key => [key, Object.getOwnPropertyDescriptor(object, key)]));
}

const NATIVE_PROTOTYPES = [...NATIVE_CLASSES, SIM_STATE].map(klassOrObject => {
  const target = typeof klassOrObject === 'function'
    ? klassOrObject.prototype
    : Object.getPrototypeOf(klassOrObject);
  return {target, descriptors: descriptorSnapshot(target)};
});
const NATIVE_STATICS = [
  ...NATIVE_CLASSES.map(klass => ({
    target: klass,
    descriptors: descriptorSnapshot(klass),
  })),
  {target: SIM_STATE, descriptors: descriptorSnapshot(SIM_STATE)},
];

function sameDescriptor(actual, expected) {
  if (!actual || !expected || actual.enumerable !== expected.enumerable ||
      actual.configurable !== expected.configurable) return false;
  if ('value' in expected) {
    return 'value' in actual && actual.value === expected.value && actual.writable === expected.writable;
  }
  return !('value' in actual) && actual.get === expected.get && actual.set === expected.set;
}

function nativeDescriptorSet(targets) {
  const functions = new Set();
  for (const {descriptors} of targets) {
    for (const descriptor of descriptors.values()) {
      if (descriptor.value && typeof descriptor.value === 'function') functions.add(descriptor.value);
      if (descriptor.get) functions.add(descriptor.get);
      if (descriptor.set) functions.add(descriptor.set);
    }
  }
  return functions;
}

const NATIVE_HELPERS = nativeDescriptorSet([...NATIVE_PROTOTYPES, ...NATIVE_STATICS]);

function nativeDescriptorsAreIntact(targets) {
  return targets.every(({target, descriptors}) => {
    // State.REFERABLE is lazily initialized by the native serializer on its
    // first call; it is a native cache field, not a patched serializer.
    const actualKeys = Reflect.ownKeys(target).filter(key =>
      !(target === SIM_STATE && key === 'REFERABLE'));
    if (actualKeys.length !== descriptors.size) return false;
    for (const key of actualKeys) {
      if (!descriptors.has(key) || !sameDescriptor(Object.getOwnPropertyDescriptor(target, key), descriptors.get(key))) {
        return false;
      }
    }
    return true;
  });
}

function stateReferableIsNative() {
  const referable = SIM_STATE.REFERABLE;
  return referable === undefined || (
    referable instanceof Set &&
    referable.size === NATIVE_REFERABLE_CLASSES.size &&
    [...referable].every(value => NATIVE_REFERABLE_CLASSES.has(value))
  );
}

function instanceMethodsAreNative(value) {
  if (!value || typeof value !== 'object') return true;
  const prototype = Object.getPrototypeOf(value);
  const nativeClass = NATIVE_CLASSES.find(klass => klass.prototype === prototype);
  if (!nativeClass) return false;
  for (const [name, descriptor] of descriptorSnapshot(prototype)) {
    if (!('value' in descriptor) || typeof descriptor.value !== 'function') continue;
    // Reading the resolved method catches both an own instance replacement
    // and a changed inherited method. The descriptor check rejects an own
    // accessor before simulator code could execute it.
    const own = Object.getOwnPropertyDescriptor(value, name);
    if (own && (own.get || own.set || own.value !== descriptor.value)) return false;
    if (value[name] !== descriptor.value) return false;
  }
  return true;
}

function inspectDescriptors(value, output, seen, runtimeObjects, includePrototype = true) {
  if (typeof value === 'function') {
    output.add(value);
    return true;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  if (runtimeObjects.has(value)) return true;
  seen.add(value);

  if (value instanceof Map) {
    for (const [key, child] of value.entries()) {
      if (!inspectDescriptors(key, output, seen, runtimeObjects) ||
          !inspectDescriptors(child, output, seen, runtimeObjects)) return false;
    }
    return true;
  }
  if (value instanceof Set) {
    for (const child of value.values()) {
      if (!inspectDescriptors(child, output, seen, runtimeObjects)) return false;
    }
    return true;
  }

  const inspect = object => {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
      if (descriptor.get || descriptor.set) return false;
      const child = descriptor.value;
      if (typeof child === 'function') output.add(child);
      else if (child && typeof child === 'object' && !runtimeObjects.has(child) &&
        !inspectDescriptors(child, output, seen, runtimeObjects)) return false;
    }
    return true;
  };

  if (!inspect(value)) return false;
  if (!includePrototype) return true;
  for (let prototype = Object.getPrototypeOf(value);
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)) {
    if (prototype === Map.prototype || prototype === Set.prototype ||
        prototype === Array.prototype) continue;
    if (!inspect(prototype)) return false;
  }
  return true;
}

function dataFiles(directory) {
  return fs.readdirSync(directory, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(directory, entry.name));
}

function nativeCallbackFunctions() {
  const result = new Set();
  const directory = path.resolve(path.dirname(require.resolve('@pkmn/sim')), '../data');
  // Only the base data directory is admitted.  Loading every mod would make
  // a mod callback look native for a base battle and would also increase the
  // audit cost at solver startup.
  for (const file of dataFiles(directory)) {
    try {
      inspectDescriptors(require(file), result, new WeakSet(), new WeakSet());
    } catch {
      // A missing optional data export is safe: an encountered function that
      // is absent from the whitelist causes the exact-key fallback.
    }
  }
  return result;
}

const NATIVE_CALLBACKS = nativeCallbackFunctions();

function coreMethodsAreNative(battle) {
  if (SIM_VERSION !== '0.10.11' || battle?.gen !== 9) return false;
  if (!nativeDescriptorsAreIntact(NATIVE_PROTOTYPES) || !nativeDescriptorsAreIntact(NATIVE_STATICS)) {
    return false;
  }
  if (!stateReferableIsNative()) return false;
  for (const name of CORE_METHOD_NAMES) {
    if (battle[name] !== CORE_METHODS[name]) return false;
  }
  return Battle.compareRedirectOrder === NATIVE_REDIRECT_ORDER &&
    typeof NATIVE_REDIRECT_ORDER === 'function';
}

function pokemonAccessorsAreNative(pokemon) {
  for (const name of Object.keys(POKEMON_METHODS)) {
    let object = pokemon;
    let found = false;
    while (object) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor) {
        found = true;
        if (descriptor.get || descriptor.set || descriptor.value !== POKEMON_METHODS[name]) {
          return false;
        }
        break;
      }
      object = Object.getPrototypeOf(object);
    }
    if (!found) return false;
  }
  return true;
}

function battleCallbacksAreNative(battle) {
  const functions = new Set();
  const seen = new WeakSet();
  const runtimeObjects = new WeakSet();
  const markRuntime = value => {
    if (value && typeof value === 'object') runtimeObjects.add(value);
  };
  markRuntime(battle);
  markRuntime(battle.dex);
  for (const side of battle.sides || []) {
    if (!side) continue;
    markRuntime(side);
    if (!instanceMethodsAreNative(side)) return false;
    for (const pokemon of side.pokemon || []) {
      if (!instanceMethodsAreNative(pokemon)) return false;
      markRuntime(pokemon);
    }
  }
  if (!instanceMethodsAreNative(battle) ||
      !instanceMethodsAreNative(battle.field) ||
      !instanceMethodsAreNative(battle.queue) ||
      !instanceMethodsAreNative(battle.actions)) return false;
  const dexObjects = [
    battle.dex,
    battle.dex?.abilities,
    battle.dex?.conditions,
    battle.dex?.items,
    battle.dex?.moves,
    battle.dex?.species,
    battle.dex?.formats,
    battle.dex?.natures,
    battle.dex?.types,
    battle.dex?.stats,
    battle.dex?.learnsets,
  ];
  if (dexObjects.some(object => object && !instanceMethodsAreNative(object))) return false;

  const roots = [
    battle.dex?.dataCache,
    battle.dex?.abilities?.abilityCache,
    battle.dex?.abilities?.allCache,
    battle.dex?.moves?.moveCache,
    battle.dex?.moves?.allCache,
    battle.dex?.conditions?.conditionCache,
    battle.dex?.items?.itemCache,
    battle.dex?.items?.allCache,
    battle.dex?.species?.speciesCache,
    battle.dex?.species?.allCache,
    battle.field,
    battle.queue,
    battle.format,
    battle.effect,
    battle.effectState,
    battle.events,
    battle.activeMove,
    battle.lastMove,
  ];
  for (const side of battle.sides || []) {
    if (!side) continue;
    roots.push(side.sideConditions, side.slotConditions);
    for (const pokemon of side.pokemon || []) {
      if (!pokemonAccessorsAreNative(pokemon)) return false;
      roots.push(
        pokemon.getAbility?.(),
        pokemon.getItem?.(),
        pokemon.getStatus?.(),
        pokemon.volatiles,
        pokemon.abilityState,
        pokemon.itemState,
        pokemon.statusState,
      );
    }
  }
  for (const root of roots) {
    const runtimeContainer = root === battle.field || root === battle.queue;
    if (!inspectDescriptors(root, functions, seen, runtimeObjects, !runtimeContainer)) return false;
  }
  return [...functions].every(callback => NATIVE_CALLBACKS.has(callback) || NATIVE_HELPERS.has(callback));
}

function auditNativeRules(battle) {
  return !!battle && battle.dex?.currentMod === 'base' &&
    coreMethodsAreNative(battle) && battleCallbacksAreNative(battle);
}

export {
  auditNativeRules,
  battleCallbacksAreNative,
  coreMethodsAreNative,
};
