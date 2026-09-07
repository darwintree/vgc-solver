import type {TransitionOptions} from './types';
import * as path from 'node:path';
import {Battle, Dex, Pokemon} from '@pkmn/sim';
import {installEmptyEventOptimization, isNativeFindEventHandlers} from './empty-events';
import {installResidualOptimization} from './residual-optimization';
import {hasNoEventHandlers} from './event-plan';

let NativeBattleActions;
let NativeClampIntRange;
try {
  // BattleActions is intentionally not part of @pkmn/sim's public exports.
  // Resolve it relative to the pinned public entry point so a package layout
  // change simply disables this optimization and keeps native behavior.
  const simDirectory = path.dirname(require.resolve('@pkmn/sim'));
  ({BattleActions: NativeBattleActions} = require(path.join(simDirectory, 'battle-actions.js')));
  ({Utils: {clampIntRange: NativeClampIntRange}} = require(path.join(simDirectory, '../lib/utils.js')));
} catch {
  NativeBattleActions = null;
  NativeClampIntRange = null;
}

const nativeBattle = Object.freeze({
  random: Battle.prototype.random,
  randomChance: Battle.prototype.randomChance,
  randomizer: Battle.prototype.randomizer,
  runEvent: Battle.prototype.runEvent,
  findEventHandlers: Battle.prototype.findEventHandlers,
  findPokemonEventHandlers: Battle.prototype.findPokemonEventHandlers,
  findBattleEventHandlers: Battle.prototype.findBattleEventHandlers,
  findFieldEventHandlers: Battle.prototype.findFieldEventHandlers,
  findSideEventHandlers: Battle.prototype.findSideEventHandlers,
  getCallback: Battle.prototype.getCallback,
  resolvePriority: Battle.prototype.resolvePriority,
  priorityEvent: Battle.prototype.priorityEvent,
  speedSort: Battle.prototype.speedSort,
  spreadDamage: Battle.prototype.spreadDamage,
  clampIntRange: NativeClampIntRange,
  singleEvent: Battle.prototype.singleEvent,
  modify: Battle.prototype.modify,
  suppressingAbility: Battle.prototype.suppressingAbility,
  pokemonDamage: Pokemon.prototype.damage,
});
// @pkmn/sim's pinned battle formats install Math.trunc as the native damage
// truncator. Mapping all 16 rolls calls the truncator 32 times while building
// alternatives, so custom truncators must stay on the native path.
const NATIVE_DAMAGE_TRUNC = Math.trunc;

const INSTALLED = Symbol('simulatorOptimizationsInstalled');
const DAMAGE_CONTEXT = Symbol('damageContext');

function nativeBattleMethods(battle) {
  return battle && battle.random === nativeBattle.random &&
    battle.randomChance === nativeBattle.randomChance;
}

function nativeChance(battle, chance) {
  // Native code draws random(100) even for these deterministic cases. Skipping
  // that irrelevant draw preserves the outcome distribution while preventing
  // 100 branches with the same effect result.
  if (chance === undefined) return true;
  if (typeof chance !== 'number') return battle.random(100) < chance;
  if (chance <= 0) return false;
  if (chance >= 100) return true;
  if (!Number.isFinite(chance)) return chance > 0;
  // Native condition is random(100) < chance. Integer buckets therefore use
  // ceil(chance), including fractional chances such as 12.5 -> 13 buckets.
  // Call the PRNG facade directly. Battle#randomChance honors
  // forceRandomChance, while the native random(100) comparison does not.
  if (!battle.prng || typeof battle.prng.randomChance !== 'function') {
    return battle.random(100) < chance;
  }
  return battle.prng.randomChance(Math.ceil(chance), 100);
}

function installActionOptimizations(battle) {
  if (!NativeBattleActions || !nativeBattleMethods(battle)) return false;
  const actions = battle.actions;
  if (!actions || actions.constructor.prototype !== NativeBattleActions.prototype ||
      actions.selfDrops !== NativeBattleActions.prototype.selfDrops ||
      actions.secondaries !== NativeBattleActions.prototype.secondaries) {
    return false;
  }

  const nativeSelfDrops = actions.selfDrops;
  const nativeSecondaries = actions.secondaries;
  const optimizedSelfDrops = function(targets, source, move, moveData, isSecondary) {
    if (this.selfDrops !== optimizedSelfDrops || !nativeBattleMethods(this.battle)) {
      return nativeSelfDrops.call(this, targets, source, move, moveData, isSecondary);
    }
    for (const target of targets) {
      if (target === false) continue;
      if (moveData.self && !move.selfDropped) {
        if (!isSecondary && moveData.self.boosts) {
          const chance = nativeChance(this.battle, moveData.self.chance);
          if (chance) {
            this.moveHit(source, source, move, moveData.self, isSecondary, true);
          }
          if (!move.multihit) move.selfDropped = true;
        } else {
          this.moveHit(source, source, move, moveData.self, isSecondary, true);
        }
      }
    }
  };
  const optimizedSecondaries = function(targets, source, move, moveData, isSelf) {
    if (this.secondaries !== optimizedSecondaries || !nativeBattleMethods(this.battle)) {
      return nativeSecondaries.call(this, targets, source, move, moveData, isSelf);
    }
    if (!moveData.secondaries) return;
    for (const target of targets) {
      if (target === false) continue;
      const secondaries = this.battle.runEvent(
        'ModifySecondaries', target, source, moveData, moveData.secondaries.slice()
      );
      for (const secondary of secondaries) {
        const secondaryOverflow = (secondary.boosts || secondary.self) && this.battle.gen <= 8;
        const chance = secondaryOverflow && typeof secondary.chance !== 'undefined'
          ? secondary.chance % 256
          : secondary.chance;
        const applies = nativeChance(this.battle, chance);
        if (applies) this.moveHit(target, source, move, secondary, true, isSelf);
      }
    }
  };

  actions.selfDrops = optimizedSelfDrops;
  actions.secondaries = optimizedSecondaries;
  return true;
}

function installDamageOptimization(battle, eventPlan = null) {
  if (!nativeBattleMethods(battle) || battle.randomizer !== nativeBattle.randomizer ||
      battle.trunc !== NATIVE_DAMAGE_TRUNC || battle.clampIntRange !== nativeBattle.clampIntRange ||
      !NativeBattleActions) return false;
  const actions = battle.actions;
  const actionPrototype = NativeBattleActions.prototype;
  if (!actions || actions.constructor.prototype !== actionPrototype ||
      actions.getSpreadDamage !== actionPrototype.getSpreadDamage ||
      actions.getDamage !== actionPrototype.getDamage ||
      actions.modifyDamage !== actionPrototype.modifyDamage) return false;

  const nativeGetSpreadDamage = actions.getSpreadDamage;
  const nativeGetDamage = actions.getDamage;
  const nativeModifyDamage = actions.modifyDamage;
  const nativeRandomizer = battle.randomizer;

  const noHandlers = (eventid, target, source) =>
    hasNoEventHandlers(battle, eventPlan, eventid, target, source);

  const rawDamage = (baseDamage, roll) => {
    const tr = NATIVE_DAMAGE_TRUNC;
    return tr(tr(baseDamage * (100 - roll)) / 100);
  };

  const rawRandomizer = (baseDamage, prng) => {
    if (!prng || typeof prng.randomMapped !== 'function') return null;
    return prng.randomMapped(0, 16, roll => rawDamage(baseDamage, roll),
      `damage:${baseDamage}`);
  };

  const canProbeTail = context => {
    const {source, target, move} = context;
    if (!source || !target || !move || !context.parentMove || target.hp <= 0 || target.volatiles?.substitute ||
        !Number.isFinite(context.baseDamage) || context.multiTarget ||
        move.onDamage !== undefined || move.onEffectiveness !== undefined ||
        context.parentMove.onDamage !== undefined ||
        !Array.isArray(source.types) || !source.types.length ||
        !Array.isArray(target.types) || !target.types.length || battle.gen !== 9 ||
        typeof battle.prng?.randomGrouped !== 'function') return false;
    if (battle.runEvent !== nativeBattle.runEvent ||
        !isNativeFindEventHandlers(battle) ||
        battle.findPokemonEventHandlers !== nativeBattle.findPokemonEventHandlers ||
        battle.findBattleEventHandlers !== nativeBattle.findBattleEventHandlers ||
        battle.findFieldEventHandlers !== nativeBattle.findFieldEventHandlers ||
        battle.findSideEventHandlers !== nativeBattle.findSideEventHandlers ||
        battle.getCallback !== nativeBattle.getCallback ||
        battle.resolvePriority !== nativeBattle.resolvePriority ||
        battle.priorityEvent !== nativeBattle.priorityEvent ||
        battle.speedSort !== nativeBattle.speedSort ||
        battle.spreadDamage !== nativeBattle.spreadDamage ||
        battle.clampIntRange !== nativeBattle.clampIntRange ||
        battle.singleEvent !== nativeBattle.singleEvent ||
        battle.modify !== nativeBattle.modify ||
        battle.suppressingAbility !== nativeBattle.suppressingAbility ||
        battle.dex.getEffectiveness !== Dex.ModdedDex.prototype.getEffectiveness ||
        target.damage !== nativeBattle.pokemonDamage ||
        target.runEffectiveness !== Pokemon.prototype.runEffectiveness ||
        target.getMoveHitData !== Pokemon.prototype.getMoveHitData ||
        source.hasType !== Pokemon.prototype.hasType ||
        source.hasAbility !== Pokemon.prototype.hasAbility ||
        source.ignoringAbility !== Pokemon.prototype.ignoringAbility ||
        source.getTypes !== Pokemon.prototype.getTypes ||
        target.hasAbility !== Pokemon.prototype.hasAbility ||
        target.ignoringAbility !== Pokemon.prototype.ignoringAbility ||
        target.getTypes !== Pokemon.prototype.getTypes ||
        source.terastallized || target.terastallized ||
        target.hasAbility('terashell') || typeof move.onEffectiveness === 'function') {
      return false;
    }

    // These are all post-randomizer observations or transformations. A
    // nonempty list means a callback may inspect a different raw value or
    // mutate state during one of the probes, so the native path is required.
    return noHandlers('ModifySTAB', source, target) &&
      noHandlers('Type', source, null) &&
      noHandlers('Type', target, null) &&
      noHandlers('Effectiveness', target, null) &&
      noHandlers('WeatherModifyDamage', source, target) &&
      noHandlers('ModifyDamage', source, target) &&
      noHandlers('Damage', target, source) &&
      noHandlers('DamagingHit', target, source);
  };

  const optimizedRandomizer = function(baseDamage) {
    if (this.randomizer !== optimizedRandomizer || this.random !== nativeBattle.random ||
        this.trunc !== NATIVE_DAMAGE_TRUNC || this.clampIntRange !== nativeBattle.clampIntRange) {
      return nativeRandomizer.call(this, baseDamage);
    }
    const context = this[DAMAGE_CONTEXT];
    if (!this.prng || !context || context.phase !== 'modify' || context.battle !== this ||
        !canProbeTail(context)) return rawRandomizer(baseDamage, this.prng) ??
      nativeRandomizer.call(this, baseDamage);

    const {source, target, move} = context;
    const tr = NATIVE_DAMAGE_TRUNC;
    const hp = target.hp;
    let tail;
    const group = roll => {
      if (!tail) {
        const type = move.type || '???';
        let stab = 1;
        const isSTAB = move.forceSTAB || source.hasType(type) ||
          source.getTypes(false, true).includes(type);
        if (isSTAB) stab = 1.5;
        if (source.terastallized === type && source.getTypes(false, true).includes(type)) stab = 2;
        const typeMod = battle.clampIntRange(target.runEffectiveness(move), -6, 6);
        const bypassProtect = target.getMoveHitData(move).bypassProtect;
        const burnedPhysical = source.status === 'brn' && move.category === 'Physical' &&
          !source.hasAbility('guts') && (battle.gen < 6 || move.id !== 'facade');
        tail = raw => {
          let damage = raw;
          if (type !== '???') damage = nativeBattle.modify.call(battle, damage, stab);
          if (typeMod > 0) {
            for (let i = 0; i < typeMod; i++) damage *= 2;
          } else if (typeMod < 0) {
            for (let i = 0; i > typeMod; i--) damage = tr(damage / 2);
          }
          if (burnedPhysical) damage = nativeBattle.modify.call(battle, damage, 0.5);
          if (battle.gen === 5 && !damage) damage = 1;
          if (bypassProtect) damage = nativeBattle.modify.call(battle, damage, 0.25);
          if (battle.gen !== 5 && !damage) return 1;
          return tr(damage);
        };
      }
      const raw = rawDamage(baseDamage, roll);
      const damage = tail(raw);
      if (!Number.isFinite(damage)) return `raw:${raw}`;
      if (damage === 0) return 0;
      return Math.min(Math.max(damage, 1), hp);
    };
    const representativeRoll = this.prng.randomGrouped(0, 16, group,
      `damage:${baseDamage}:hp:${hp}:${move.id}`);
    return rawDamage(baseDamage, representativeRoll);
  };

  const optimizedGetSpreadDamage = function(damage, targets, source, parentMove, moveData, ...args) {
    if (this.getSpreadDamage !== optimizedGetSpreadDamage ||
        this.getDamage !== optimizedGetDamage || this.modifyDamage !== optimizedModifyDamage) {
      return nativeGetSpreadDamage.call(this, damage, targets, source, parentMove, moveData, ...args);
    }
    const previous = this.battle[DAMAGE_CONTEXT];
    this.battle[DAMAGE_CONTEXT] = {
      phase: 'spread', battle: this.battle, parentMove,
      multiTarget: !Array.isArray(targets) || targets.length !== 1,
    };
    try {
      return nativeGetSpreadDamage.call(this, damage, targets, source, parentMove, moveData, ...args);
    } finally {
      this.battle[DAMAGE_CONTEXT] = previous;
    }
  };
  const optimizedGetDamage = function(source, target, move, suppressMessages = false) {
    if (this.getDamage !== optimizedGetDamage || this.modifyDamage !== optimizedModifyDamage ||
        this.battle[DAMAGE_CONTEXT]?.phase !== 'spread') {
      return nativeGetDamage.call(this, source, target, move, suppressMessages);
    }
    const previous = this.battle[DAMAGE_CONTEXT];
    this.battle[DAMAGE_CONTEXT] = {
      ...this.battle[DAMAGE_CONTEXT],
      phase: 'getDamage', source, target, move, suppressMessages,
    };
    try {
      return nativeGetDamage.call(this, source, target, move, suppressMessages);
    } finally {
      this.battle[DAMAGE_CONTEXT] = previous;
    }
  };
  const optimizedModifyDamage = function(baseDamage, source, target, move, suppressMessages = false) {
    if (this.modifyDamage !== optimizedModifyDamage ||
        this.getDamage !== optimizedGetDamage ||
        this.battle[DAMAGE_CONTEXT]?.phase !== 'getDamage') {
      return nativeModifyDamage.call(this, baseDamage, source, target, move, suppressMessages);
    }
    const previous = this.battle[DAMAGE_CONTEXT];
    this.battle[DAMAGE_CONTEXT] = {
      ...previous, phase: 'modify', battle: this.battle, source, target, move, suppressMessages, baseDamage,
    };
    try {
      return nativeModifyDamage.call(this, baseDamage, source, target, move, suppressMessages);
    } finally {
      this.battle[DAMAGE_CONTEXT] = previous;
    }
  };

  actions.getSpreadDamage = optimizedGetSpreadDamage;
  actions.getDamage = optimizedGetDamage;
  actions.modifyDamage = optimizedModifyDamage;
  battle.randomizer = optimizedRandomizer;
  return true;
}

/** Install optimizations on one restored enumeration Battle instance only. */
function installSimulatorOptimizations(battle, options: Pick<TransitionOptions, 'eventPlan'> = {}) {
  if (!battle || battle[INSTALLED]) return false;
  battle[INSTALLED] = true;
  const eventPlan = options.eventPlan || null;
  installEmptyEventOptimization(battle, eventPlan);
  installResidualOptimization(battle);
  installActionOptimizations(battle);
  installDamageOptimization(battle, eventPlan);
  return true;
}

export {installSimulatorOptimizations};
