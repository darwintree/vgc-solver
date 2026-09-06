'use strict';

const {
  createBattle,
  refreshMoveRequest,
  setHP,
  setMovePP,
} = require('./showdown-adapter');

const IVS = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
const EVS = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0};

function trivialPriorityKO() {
  const battle = createBattle(
    {
      species: 'Scizor',
      level: 50,
      ability: 'Swarm',
      nature: 'Serious',
      ivs: IVS,
      evs: EVS,
      moves: ['Quick Attack'],
    },
    {
      species: 'Blissey',
      level: 50,
      ability: 'Natural Cure',
      nature: 'Serious',
      ivs: IVS,
      evs: EVS,
      moves: ['Tackle'],
    }
  );
  setHP(battle, 'p1', 1);
  setHP(battle, 'p2', 1);
  setMovePP(battle, 'p1', 'Quick Attack', 1);
  setMovePP(battle, 'p2', 'Tackle', 1);
  refreshMoveRequest(battle);
  return {
    name: 'Trivial: priority move wins',
    expected: 'value = +1',
    battle,
  };
}

function leftoversThreeHKO() {
  const set = {
    species: 'Pikachu',
    level: 50,
    ability: 'Lightning Rod',
    item: 'Leftovers',
    nature: 'Serious',
    ivs: IVS,
    evs: EVS,
    moves: ['Seismic Toss', 'Protect'],
  };
  const battle = createBattle({...set}, {...set});

  // Endgame-sized PP keeps the demo small while preserving the 3HKO/Protect game.
  for (const side of ['p1', 'p2']) {
    setMovePP(battle, side, 'Seismic Toss', 4);
    setMovePP(battle, side, 'Protect', 1);
  }
  refreshMoveRequest(battle);
  return {
    name: 'Symmetric Leftovers + Protect + 3HKO',
    expected: 'value = 0 by symmetry',
    battle,
  };
}

function suckerPunchGame() {
  const battle = createBattle(
    {
      species: 'Kingambit',
      level: 50,
      ability: 'Defiant',
      nature: 'Brave',
      ivs: IVS,
      evs: EVS,
      moves: ['Sucker Punch', 'Knock Off'],
    },
    {
      species: 'Electrode',
      level: 50,
      ability: 'Soundproof',
      nature: 'Timid',
      ivs: IVS,
      evs: EVS,
      moves: ['Protect', 'Tackle'],
    }
  );

  setHP(battle, 'p1', 1);
  setHP(battle, 'p2', 1);
  refreshMoveRequest(battle);
  return {
    name: 'Sucker Punch / Knock Off vs Protect / attack',
    expected: 'maximum PP; value ≈ 0.6011',
    battle,
  };
}

module.exports = {
  leftoversThreeHKO,
  suckerPunchGame,
  trivialPriorityKO,
};
