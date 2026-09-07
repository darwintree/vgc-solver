import {Battle} from '@pkmn/sim';
import {hasPossibleEvent} from './event-plan';

// This optimization is deliberately tied to the exact event-dispatch methods
// shipped by the pinned simulator. A format or mod can replace any of these
// methods, in which case the ordinary implementation remains authoritative.
const nativeMethods = Object.freeze({
  eachEvent: Battle.prototype.eachEvent,
  runEvent: Battle.prototype.runEvent,
  speedSort: Battle.prototype.speedSort,
  findEventHandlers: Battle.prototype.findEventHandlers,
  findPokemonEventHandlers: Battle.prototype.findPokemonEventHandlers,
  findSideEventHandlers: Battle.prototype.findSideEventHandlers,
  findFieldEventHandlers: Battle.prototype.findFieldEventHandlers,
  findBattleEventHandlers: Battle.prototype.findBattleEventHandlers,
  getCallback: Battle.prototype.getCallback,
  resolvePriority: Battle.prototype.resolvePriority,
  getAllActive: Battle.prototype.getAllActive,
});
const wrappedFindEventHandlers = new WeakMap();

function isNativeFindEventHandlers(battle) {
  return !!battle && (battle.findEventHandlers === nativeMethods.findEventHandlers ||
    wrappedFindEventHandlers.get(battle) === battle.findEventHandlers);
}

function isNativeEventMethod(battle, name) {
  if (!battle) return false;
  if (name === 'findEventHandlers') return isNativeFindEventHandlers(battle);
  return battle[name] === nativeMethods[name];
}

function hasNativeEventMethods(battle, includeEachEvent = true) {
  if (battle.gen !== 9) return false;
  return Object.keys(nativeMethods).every(name =>
    (!includeEachEvent && name === 'eachEvent') || isNativeEventMethod(battle, name)
  );
}

function canSkipEachEvent(battle, eventid, eventPlan) {
  if (battle.eventDepth >= 8) return false;

  // The plan is only a global superset. A positive result still needs the
  // existing active scan, while a negative result proves the whole dispatch
  // empty and avoids entering native findEventHandlers at all.
  if (hasPossibleEvent(eventPlan, battle, eventid) === false) return true;

  // Check every active before skipping. Calling the original implementation
  // after finding one handler preserves its complete ordering and allows an
  // earlier callback to install a handler for a later Pokemon.
  for (const pokemon of battle.getAllActive()) {
    if (battle.findEventHandlers(pokemon, eventid, null).length) return false;
  }
  return true;
}

/**
 * Install the empty eachEvent fast path on one battle instance.
 *
 * @returns {boolean} whether the optimization was installed
 */
function installEmptyEventOptimization(battle, eventPlan = null) {
  if (!battle || !hasNativeEventMethods(battle)) return false;

  const original = nativeMethods.eachEvent;
  battle.eachEvent = function optimizedEachEvent(eventid, effect, relayVar) {
    if (!hasNativeEventMethods(this, false) || !canSkipEachEvent(this, eventid, eventPlan)) {
      return original.call(this, eventid, effect, relayVar);
    }
    // Native eachEvent performs this recursive pass for gen 7+ Weather even
    // when Weather itself has no active-Pokemon handlers. Keep the pass while
    // skipping the useless Weather speed sort and empty dispatch.
    if (eventid === 'Weather' && this.gen >= 7) return this.eachEvent('Update');
    return undefined;
  };

  if (eventPlan) {
    const originalFindEventHandlers = nativeMethods.findEventHandlers;
    const optimizedFindEventHandlers = function optimizedFindEventHandlers(target, eventName, source) {
      if (this.findEventHandlers !== optimizedFindEventHandlers ||
          !hasNativeEventMethods(this, false)) {
        return originalFindEventHandlers.call(this, target, eventName, source);
      }
      if (hasPossibleEvent(eventPlan, this, eventName) === false) return [];
      return originalFindEventHandlers.call(this, target, eventName, source);
    };
    battle.findEventHandlers = optimizedFindEventHandlers;
    wrappedFindEventHandlers.set(battle, optimizedFindEventHandlers);
  }
  return true;
}

export {installEmptyEventOptimization, isNativeFindEventHandlers};
