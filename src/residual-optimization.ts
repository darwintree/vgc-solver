import * as path from 'node:path';
import {Battle} from '@pkmn/sim';

let NativePokemon;
try {
  const simDirectory = path.dirname(require.resolve('@pkmn/sim'));
  ({Pokemon: NativePokemon} = require(path.join(simDirectory, 'pokemon.js')));
} catch {
  NativePokemon = null;
}

const native = Object.freeze({
  fieldEvent: Battle.prototype.fieldEvent,
  speedSort: Battle.prototype.speedSort,
  comparePriority: Battle.prototype.comparePriority,
  singleEvent: Battle.prototype.singleEvent,
  faintMessages: Battle.prototype.faintMessages,
  getCallback: Battle.prototype.getCallback,
  findFieldEventHandlers: Battle.prototype.findFieldEventHandlers,
  findSideEventHandlers: Battle.prototype.findSideEventHandlers,
  findPokemonEventHandlers: Battle.prototype.findPokemonEventHandlers,
  findBattleEventHandlers: Battle.prototype.findBattleEventHandlers,
  resolvePriority: Battle.prototype.resolvePriority,
});

function deterministicSpeedSort(battle, list) {
  let sorted = 0;
  while (sorted + 1 < list.length) {
    let nextIndexes = [sorted];
    for (let i = sorted + 1; i < list.length; i++) {
      const delta = native.comparePriority(list[nextIndexes[0]], list[i]);
      if (delta < 0) continue;
      if (delta > 0) nextIndexes = [i];
      if (delta === 0) nextIndexes.push(i);
    }
    for (let i = 0; i < nextIndexes.length; i++) {
      const index = nextIndexes[i];
      if (index !== sorted + i) {
        [list[sorted + i], list[index]] = [list[index], list[sorted + i]];
      }
    }
    sorted += nextIndexes.length;
  }
}

function hasNativeResidualMethods(battle, fieldEvent = battle.fieldEvent) {
  return fieldEvent === native.fieldEvent &&
    battle.speedSort === native.speedSort &&
    battle.comparePriority === native.comparePriority &&
    battle.singleEvent === native.singleEvent &&
    battle.faintMessages === native.faintMessages &&
    battle.getCallback === native.getCallback &&
    battle.findFieldEventHandlers === native.findFieldEventHandlers &&
    battle.findSideEventHandlers === native.findSideEventHandlers &&
    battle.findPokemonEventHandlers === native.findPokemonEventHandlers &&
    battle.findBattleEventHandlers === native.findBattleEventHandlers &&
    battle.resolvePriority === native.resolvePriority;
}

function isIndependentDurationHandler(handler, states) {
  if (!handler || handler.callback !== undefined || handler.effect?.onEnd !== undefined) return false;
  if (!handler.state || !handler.state.duration || handler.state.linkedPokemon) return false;
  if (!NativePokemon || handler.end !== NativePokemon.prototype.removeVolatile) return false;
  if (handler.effect?.effectType !== 'Condition') return false;
  const holder = handler.effectHolder;
  const effectID = handler.effect.id;
  if (!holder || holder.fainted || !effectID) return false;
  if (handler.state.target !== holder || holder.volatiles?.[effectID] !== handler.state) return false;
  if (states.has(handler.state)) return false;
  // One Pokemon can safely own several independent duration-only volatiles
  // (for example Protect and another stalling effect). Only state identity and
  // the exact volatile slot must be unique; holder identity may repeat.
  states.add(handler.state);
  return true;
}

function canOptimizeResidualSort(battle, list) {
  if (battle.faintQueue?.length || battle.eventDepth >= 8 ||
      battle.log.length - battle.sentLogPos > 1000 || list.length < 2) return false;
  const states = new Set();
  for (const handler of list) {
    if (!isIndependentDurationHandler(handler, states)) return false;
  }
  return true;
}

/** Install a guarded fieldEvent-only residual tie optimization. */
function installResidualOptimization(battle) {
  if (!battle || !NativePokemon || !hasNativeResidualMethods(battle)) return false;
  const nativeFieldEvent = native.fieldEvent;
  const optimizedFieldEvent = function(eventid, targets) {
    if (this.fieldEvent !== optimizedFieldEvent || eventid !== 'Residual' ||
        !hasNativeResidualMethods(this, native.fieldEvent) ||
        this.faintQueue?.length || this.eventDepth >= 8 ||
        this.log.length - this.sentLogPos > 1000) {
      return nativeFieldEvent.call(this, eventid, targets);
    }

    // fieldEvent's first speedSort is the handler-list sort. Install a
    // temporary method for that call only; all later/nested speedSort calls use
    // native behavior and the Battle instance is restored in finally.
    const originalSpeedSort = this.speedSort;
    let firstSort = true;
    this.speedSort = function(list, comparator) {
      if (!firstSort) return native.speedSort.call(this, list, comparator);
      firstSort = false;
      if (comparator !== undefined || !canOptimizeResidualSort(this, list)) {
        return native.speedSort.call(this, list, comparator);
      }
      return deterministicSpeedSort(this, list);
    };
    try {
      return nativeFieldEvent.call(this, eventid, targets);
    } finally {
      this.speedSort = originalSpeedSort;
    }
  };
  battle.fieldEvent = optimizedFieldEvent;
  return true;
}

export {installResidualOptimization};
