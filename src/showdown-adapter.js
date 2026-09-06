'use strict';

const {Battle, toID} = require('@pkmn/sim');
const {BranchingPRNG, NeedRandom, FIXED_SEED} = require('./branching-prng');

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Remove history/PRNG data which must not distinguish otherwise equal states. */
function canonicalizeSnapshot(raw) {
  const state = cloneJSON(raw);
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

function snapshotBattle(battle) {
  return canonicalizeSnapshot(battle.toJSON());
}

function restoreBattle(snapshot) {
  return Battle.fromJSON(cloneJSON(snapshot));
}

function stateKey(snapshot) {
  return stableStringify(canonicalizeSnapshot(snapshot));
}

function createBattle(p1Set, p2Set) {
  const battle = new Battle({
    formatid: 'gen9customgame',
    debug: true,
    strictChoices: true,
    seed: FIXED_SEED,
    p1: {name: 'P1', team: [p1Set]},
    p2: {name: 'P2', team: [p2Set]},
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

function legalActions(battle, sideIndex) {
  const side = battle.sides[sideIndex];
  const request = side.activeRequest;
  const moves = request && request.active && request.active[0] && request.active[0].moves;

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

function terminalUtility(battle) {
  if (!battle.ended) return null;
  if (battle.winner === battle.p1.name) return 1;
  if (battle.winner === battle.p2.name) return -1;
  return 0;
}

/**
 * Enumerate exactly the finite random calls made while resolving one turn.
 * Each replay starts from the same serialized Showdown state.
 */
function enumerateTurn(snapshot, p1Action, p2Action, options = {}) {
  const maxRuns = options.maxSimulatorRunsPerTransition ?? 100000;
  const pending = [{decisions: [], probability: 1}];
  const outcomes = new Map();
  let runs = 0;

  while (pending.length) {
    if (++runs > maxRuns) {
      throw new Error(`Random branch limit (${maxRuns}) exceeded`);
    }

    const branch = pending.pop();
    const battle = restoreBattle(snapshot);
    const prng = new BranchingPRNG(branch.decisions);
    battle.prng = prng;

    try {
      battle.makeChoices(p1Action.command, p2Action.command);
      if (prng.cursor !== branch.decisions.length) {
        throw new Error('Random replay completed without consuming its full prefix');
      }

      const next = snapshotBattle(battle);
      const key = stateKey(next);
      const existing = outcomes.get(key);
      if (existing) {
        existing.probability += branch.probability;
      } else {
        outcomes.set(key, {snapshot: next, probability: branch.probability});
      }
    } catch (error) {
      if (!(error instanceof NeedRandom)) throw error;
      for (const alternative of error.alternatives) {
        const probability = branch.probability * alternative.probability;
        if (probability === 0) continue;
        pending.push({
          decisions: [...branch.decisions, alternative.decision],
          probability,
        });
      }
    }
  }

  const result = [...outcomes.values()];
  const total = result.reduce((sum, outcome) => sum + outcome.probability, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`Transition probabilities sum to ${total}, not 1`);
  }
  for (const outcome of result) outcome.probability /= total;

  return {outcomes: result, simulatorRuns: runs};
}

module.exports = {
  createBattle,
  enumerateTurn,
  legalActions,
  refreshMoveRequest,
  restoreBattle,
  setHP,
  setMovePP,
  snapshotBattle,
  stateKey,
  terminalUtility,
};
