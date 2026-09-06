'use strict';

const {auditNativeRules} = require('./native-rules');

// This module owns only the event superset. The broader native callback audit
// remains in native-rules.js; keeping this layer small lets damage and
// eachEvent share one conservative proof without importing the adapter.
const EVENT_PREFIXES = Object.freeze([
  'on', 'onAny', 'onAlly', 'onFoe', 'onSource', 'onSide', 'onField',
]);
function addCondition(battle, effects, id) {
  if (!id) return;
  effects.push(battle.dex.conditions.getByID(id));
}

function currentEffects(battle) {
  const effects = [battle.format];
  for (const side of battle.sides || []) {
    for (const pokemon of side.pokemon || []) {
      effects.push(pokemon.getStatus(), pokemon.getAbility(), pokemon.getItem(), pokemon.baseSpecies);
      for (const id of Object.keys(pokemon.volatiles || {})) addCondition(battle, effects, id);
      for (const id of Object.keys(side.slotConditions?.[pokemon.position] || {})) {
        addCondition(battle, effects, id);
      }
    }
    for (const id of Object.keys(side.sideConditions || {})) addCondition(battle, effects, id);
  }
  const field = battle.field;
  for (const id of Object.keys(field?.pseudoWeather || {})) addCondition(battle, effects, id);
  addCondition(battle, effects, field?.weather);
  addCondition(battle, effects, field?.terrain);
  return effects;
}

function allNativeEffects(battle) {
  const effects = currentEffects(battle);
  const data = battle.dex.data;
  const add = (collection, accessor) => {
    for (const id of Object.keys(collection || {})) effects.push(accessor(id));
  };
  // Abilities, items and species are directly queried by
  // findPokemonEventHandlers. Conditions also arise from move/ability/item
  // condition data after Protect, stall, weather, Transform, or a forme
  // change, so index those definitions before the first transition too.
  add(data.Abilities, id => battle.dex.abilities.getByID(id));
  add(data.Items, id => battle.dex.items.getByID(id));
  add(data.Pokedex, id => battle.dex.species.getByID(id));
  add(data.Conditions, id => battle.dex.conditions.getByID(id));
  for (const table of [data.Moves, data.Abilities, data.Items]) {
    for (const [id, definition] of Object.entries(table || {})) {
      if (definition.condition) effects.push(battle.dex.conditions.getByID(id));
    }
  }
  return effects;
}

function effectIDs(battle) {
  const ids = [battle.format?.id];
  for (const side of battle.sides || []) {
    for (const pokemon of side.pokemon || []) {
      ids.push(pokemon.status, pokemon.ability, pokemon.item, pokemon.baseSpecies?.id);
      ids.push(...Object.keys(pokemon.volatiles || {}));
      ids.push(...Object.keys(side.slotConditions?.[pokemon.position] || {}));
    }
    ids.push(...Object.keys(side.sideConditions || {}));
  }
  const field = battle.field;
  ids.push(...Object.keys(field?.pseudoWeather || {}), field?.weather, field?.terrain);
  return ids.filter(id => id !== undefined && id !== null && id !== '');
}

function stateFingerprint(battle) {
  const values = [battle.effectOrder, battle.turn, battle.format?.id];
  for (const side of battle.sides || []) {
    values.push(side.sideConditions, side.slotConditions);
    for (const pokemon of side.pokemon || []) {
      values.push(
        pokemon.baseSpecies, pokemon.ability, pokemon.item, pokemon.status,
        pokemon.volatiles, side.slotConditions?.[pokemon.position]
      );
    }
  }
  const field = battle.field;
  values.push(field?.pseudoWeather, field?.weather, field?.terrain,
    field?.weatherState, field?.terrainState);
  return values;
}

function sameFingerprint(battle, fingerprint) {
  if (!fingerprint) return false;
  let cursor = 0;
  if (!Object.is(fingerprint[cursor++], battle.effectOrder) ||
      !Object.is(fingerprint[cursor++], battle.turn) ||
      !Object.is(fingerprint[cursor++], battle.format?.id)) return false;
  for (const side of battle.sides || []) {
    if (!Object.is(fingerprint[cursor++], side.sideConditions) ||
        !Object.is(fingerprint[cursor++], side.slotConditions)) return false;
    for (const pokemon of side.pokemon || []) {
      if (!Object.is(fingerprint[cursor++], pokemon.baseSpecies) ||
          !Object.is(fingerprint[cursor++], pokemon.ability) ||
          !Object.is(fingerprint[cursor++], pokemon.item) ||
          !Object.is(fingerprint[cursor++], pokemon.status) ||
          !Object.is(fingerprint[cursor++], pokemon.volatiles) ||
          !Object.is(fingerprint[cursor++], side.slotConditions?.[pokemon.position])) return false;
    }
  }
  const field = battle.field;
  return Object.is(fingerprint[cursor++], field?.pseudoWeather) &&
    Object.is(fingerprint[cursor++], field?.weather) &&
    Object.is(fingerprint[cursor++], field?.terrain) &&
    Object.is(fingerprint[cursor++], field?.weatherState) &&
    Object.is(fingerprint[cursor++], field?.terrainState) &&
    cursor === fingerprint.length;
}

function callbackNames(effect) {
  if (!effect || typeof effect !== 'object') return null;
  const names = new Set();
  for (let object = effect; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string' || !key.startsWith('on')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) return null;
      if (descriptor.value !== undefined) names.add(key);
      if (key === 'onStart' && descriptor.value !== undefined) names.add('onSwitchIn');
    }
  }
  return names;
}

function possibleEvents(effect) {
  const names = callbackNames(effect);
  if (!names) return null;
  const events = new Set();
  for (const name of names) {
    for (const prefix of EVENT_PREFIXES) {
      if (name.startsWith(prefix)) events.add(name.slice(prefix.length));
    }
  }
  return events;
}

function buildDefinitions(battle) {
  const byID = new Map();
  const seen = new WeakSet();
  for (const effect of allNativeEffects(battle)) {
    if (!effect || typeof effect !== 'object') return null;
    if (seen.has(effect)) continue;
    seen.add(effect);
    // The native empty-status effect has no ID and no active callback slot;
    // it is intentionally absent from the dynamic ID set.
    if (!effect.id) continue;
    const events = possibleEvents(effect);
    if (!events) return null;
    let current = byID.get(effect.id);
    if (!current) byID.set(effect.id, current = new Set());
    for (const event of events) current.add(event);
  }
  return byID;
}

/** Build once at solve root. A failed audit disables every event shortcut. */
function createEventPlan(battle, nativeAudit = undefined) {
  if (!(nativeAudit ?? auditNativeRules(battle)) || battle.events) return null;
  // Native callback functions are whitelisted by identity, but a caller can
  // copy one known native function onto another effect between solves. The
  // callback layout is therefore mutable even when the Dex object is shared;
  // rebuild this small setup index for every solve instead of reusing it.
  const definitions = buildDefinitions(battle);
  if (!definitions) return null;
  return Object.freeze({
    format: battle.format.id,
    definitions,
    runtime: new WeakMap(),
    compositions: new Map(),
    stats: {queries: 0, unknown: 0, possible: 0, empty: 0},
  });
}

/**
 * Return false only for a proven empty event, true for a possible callback,
 * and null whenever the current dynamic effect set exceeds the root audit.
 */
function hasPossibleEvent(plan, battle, eventName) {
  if (plan?.stats) plan.stats.queries++;
  if (!plan || !battle || battle.events || battle.format?.id !== plan.format ||
      typeof eventName !== 'string') return null;
  // Compare cheap scalar/reference state on every event. Only a changed
  // fingerprint performs the full ID walk and superset lookup. This catches
  // direct species/ability/item/status replacement; native container inserts
  // also advance effectOrder, while deletions can only make a positive
  // superset conservative.
  let runtime = plan.runtime.get(battle);
  if (!runtime || !sameFingerprint(battle, runtime.fingerprint)) {
    const ids = effectIDs(battle);
    const signature = `${ids.join('\u0000')}:${battle.turn}`;
    runtime = plan.compositions.get(signature);
    if (!runtime) {
      const possibleEvents = new Set();
      let unknown = false;
      for (const id of ids) {
        const events = plan.definitions.get(id);
        if (!events) {
          unknown = true;
          break;
        }
        for (const event of events) possibleEvents.add(event);
      }
      runtime = {signature, possibleEvents, unknown};
      plan.compositions.set(signature, runtime);
    }
    runtime = {...runtime, fingerprint: stateFingerprint(battle)};
    plan.runtime.set(battle, runtime);
  }
  if (runtime.unknown) {
    if (plan.stats) plan.stats.unknown++;
    return null;
  }
  if (runtime.possibleEvents.has(eventName)) {
    if (plan.stats) plan.stats.possible++;
    return true;
  }
  if (plan.stats) plan.stats.empty++;
  return false;
}

function hasNoEventHandlers(battle, plan, eventName, target, source) {
  if (hasPossibleEvent(plan, battle, eventName) === false) return true;
  return battle.findEventHandlers(target, eventName, source).length === 0;
}

module.exports = {
  createEventPlan,
  hasPossibleEvent,
  hasNoEventHandlers,
};
