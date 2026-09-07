import {
  createBattle,
  refreshMoveRequest,
  setHP,
  setMovePP,
} from './showdown-adapter';

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

function suckerPunchVariant(stage) {
  const kingambit = {
    species: 'Kingambit',
    level: 50,
    ability: 'Defiant',
    nature: 'Brave',
    ivs: IVS,
    evs: EVS,
    moves: ['Sucker Punch', 'Knock Off'],
  };
  const electrode = {
    species: 'Electrode',
    level: 50,
    ability: 'Soundproof',
    nature: 'Timid',
    ivs: IVS,
    evs: EVS,
    moves: ['Protect', 'Tackle', stage === 1 ? 'Techno Blast' : 'Hyper Beam'],
  };
  if (stage >= 3) kingambit.moves.push('Earthquake');
  if (stage >= 5) kingambit.moves.push('Protect');

  const battle = createBattle(kingambit, electrode);
  setHP(battle, 'p1', 6);
  setHP(battle, 'p2', stage >= 4 ? 130 : 1);
  // Tackle deals 3..4 ordinary damage here, so it is a 2HKO at 6 HP;
  // a critical hit can still OHKO. Do not assert a 2HKO on every branch.
  refreshMoveRequest(battle);
  return {
    name: `Sucker Punch variant ${stage}`,
    expected: 'maximum PP; benchmark fixture',
    battle,
  };
}

function suckerPunchTwoHKOGame() {
  return suckerPunchVariant(1);
}

function suckerPunchAccuracyGame() {
  return suckerPunchVariant(2);
}

function suckerPunchCoverageGame() {
  return suckerPunchVariant(3);
}

function suckerPunchBulkyTargetGame() {
  return suckerPunchVariant(4);
}

function suckerPunchBothProtectGame() {
  return suckerPunchVariant(5);
}

function suckerPunchOHKOTwoHKOGame() {
  const kingambit = {
    species: 'Kingambit',
    level: 50,
    ability: 'Defiant',
    nature: 'Brave',
    ivs: IVS,
    evs: EVS,
    moves: ['Sucker Punch', 'Tackle', 'Earthquake'],
  };
  const electrode = {
    species: 'Electrode',
    level: 50,
    ability: 'Soundproof',
    nature: 'Timid',
    ivs: IVS,
    evs: EVS,
    moves: ['Protect', 'Tackle', 'Hyper Beam'],
  };

  const battle = createBattle(kingambit, electrode);
  setHP(battle, 'p1', 6);
  setHP(battle, 'p2', 56);
  refreshMoveRequest(battle);
  return {
    name: 'Sucker Punch OHKO / Tackle 2HKO',
    expected: 'maximum PP; benchmark fixture',
    battle,
  };
}

export {
  leftoversThreeHKO,
  suckerPunchAccuracyGame,
  suckerPunchBothProtectGame,
  suckerPunchBulkyTargetGame,
  suckerPunchCoverageGame,
  suckerPunchGame,
  suckerPunchOHKOTwoHKOGame,
  suckerPunchTwoHKOGame,
  trivialPriorityKO,
};
