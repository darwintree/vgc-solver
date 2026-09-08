import assert from 'node:assert/strict';
import test from 'node:test';
import {createTerminalEnvelope} from '../src/terminal-envelope';
import {auditNativeRules} from '../src/native-rules';
import {BoundedSolver} from '../src/bounded-solver';
import {createBattle, enumerateTurn, legalActions, refreshMoveRequest, setHP, snapshotBattle} from '../src/showdown-adapter';
import {BranchingPRNG} from '../src/branching-prng';
import {installEmptyEventOptimization} from '../src/empty-events';
import {restoreBattle, terminalUtility} from '../src/showdown-adapter';
import {championsCases, createChampionsBattle} from '../src/champions-cases';

function position(firstMove = 'Water Gun', response = 'Power Gem') {
  const battle = createBattle({species: 'Garchomp', level: 5, ability: 'Rough Skin', item: 'Focus Sash',
    moves: [firstMove]}, {species: 'Archaludon', level: 50, ability: 'Stamina', item: 'Sitrus Berry',
    moves: [response]});
  setHP(battle, 'p1', 1);
  battle.p1.active[0].boosts.spe = 6;
  battle.p2.active[0].boosts.spe = -6;
  refreshMoveRequest(battle);
  return battle;
}

function envelope(battle) {
  const factory = createTerminalEnvelope(battle);
  return factory?.(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]) ?? null;
}

// Preserve native damage and effect execution. Only the already-audited
// empty-event sorting optimization is installed; no damage grouping or
// terminal-envelope shortcut is used in this independent one-turn oracle.
function nativeInterval(snapshot, p1, p2) {
  const pending = [{decisions: [], probability: 1}];
  let lower = 0;
  let upper = 0;
  let runs = 0;
  while (pending.length) {
    assert.ok(++runs <= 50000, 'native oracle branch limit');
    const branch = pending.pop();
    const battle = restoreBattle(snapshot);
    installEmptyEventOptimization(battle);
    battle.prng = new BranchingPRNG(branch.decisions, 0, (alternatives, source) => {
      for (const alternative of alternatives.slice(1)) {
        pending.push({decisions: [...source.decisions, alternative.decision],
          probability: branch.probability * alternative.probability});
      }
      branch.probability *= alternatives[0].probability;
      return alternatives[0];
    }) as any;
    battle.makeChoices(p1.command, p2.command);
    const utility = terminalUtility(battle);
    lower += branch.probability * (utility ?? -1);
    upper += branch.probability * (utility ?? 1);
  }
  return {lower, upper};
}

for (const [first, response] of [['Water Gun', 'Power Gem'], ['Water Gun', 'Hydro Pump'],
  ['Bonemerang', 'Power Gem']]) {
  test(`native one-turn interval is enclosed for ${first} and ${response}`, () => {
    const battle = position(first, response);
    const snapshot = snapshotBattle(battle);
    const before = JSON.stringify(snapshot);
    const certificate = envelope(battle);
    assert.ok(certificate);
    const {lower, upper} = nativeInterval(snapshot, legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
    assert.ok(certificate.lower <= lower + 1e-9, `${certificate.lower} <= ${lower}`);
    assert.ok(certificate.upper >= upper - 1e-9, `${certificate.upper} >= ${upper}`);
    if (response === 'Power Gem') assert.equal(certificate.upper, -1);
    else assert.ok(Math.abs(certificate.upper - (-0.6000000000931323)) < 1e-9);
    assert.equal(JSON.stringify(snapshotBattle(battle)), before);
  });
}

test('bounded certainty retains no fabricated transition or exact flag', () => {
  const result = new BoundedSolver().solve(position());
  assert.equal(result.converged, true);
  assert.equal(result.exact, false);
  assert.equal(result.stats.terminalEnvelopes, 1);
  assert.equal(result.stats.expandedCells, 0);
  assert.ok(result.upperBound <= -1 + 1e-8);
});

for (const firstMove of ['Drain Punch', 'Power-Up Punch', 'Super Fang', 'Flail', 'Swords Dance']) {
  test(`unsupported first-move dependency falls back: ${firstMove}`, () => {
    assert.equal(envelope(position(firstMove)), null);
  });
}

test('full HP Sash, protection, and unclassified ability fall back', () => {
  const full = position();
  setHP(full, 'p1', full.p1.active[0].maxhp);
  assert.equal(envelope(full), null);
  const shield = position();
  shield.p1.active[0].addVolatile('substitute');
  assert.equal(envelope(shield), null);
  const ability = position();
  ability.p2.active[0].setAbility('weakarmor');
  assert.equal(envelope(ability), null);
});

test('survival and response KO thresholds are necessary, and expired probes stop', () => {
  const battle = position();
  setHP(battle, 'p2', 1);
  assert.equal(envelope(battle), null, 'possible pre-action berry healing leaves both terminal events unknown');
  const healthy = position('Water Gun', 'Mud-Slap');
  healthy.p1.active[0].setItem('');
  healthy.p2.active[0].boosts.spa = -6;
  setHP(healthy, 'p1', healthy.p1.active[0].maxhp);
  const partial = envelope(healthy);
  assert.ok(partial && partial.upper > -1, 'a possible critical KO is not a certain response KO');
  const valid = position();
  const factory = createTerminalEnvelope(valid);
  assert.equal(factory(snapshotBattle(valid), legalActions(valid, 0)[0], legalActions(valid, 1)[0], -Infinity), null);
});


test('Champions native PP states admit the costly multi-hit response certificate', () => {
  for (const [hp, response, upper] of [[25, 'flashcannon', -1], [50, 'dracometeor', -0.8]] as const) {
    const fixture = championsCases().find(entry => entry.id === `garchomp-${hp}-vs-archaludon-100`);
    const battle = createChampionsBattle(fixture);
    const first = legalActions(battle, 0).find(action => action.id === 'scaleshot');
    const reply = legalActions(battle, 1).find(action => action.id === response);
    const factory = createTerminalEnvelope(battle);
    const certificate = factory?.(snapshotBattle(battle), first, reply);
    assert.ok(certificate, `certificate for HP ${hp}`);
    assert.equal(certificate.lower, -1);
    assert.ok(certificate.upper <= upper + 1e-9);
  }
});


test('status, dynamic response power and modified native methods are not certified', () => {
  const status = position();
  status.p1.active[0].setStatus('par');
  assert.equal(envelope(status), null);
  assert.equal(envelope(position('Water Gun', 'Water Spout')), null);
  const modified = position();
  modified.actions.getDamage = (() => 1) as any;
  assert.equal(createTerminalEnvelope(modified), null);
});


test('a berry threshold remains inside the native one-turn certificate', () => {
  const battle = position();
  setHP(battle, 'p2', 3);
  const certificate = envelope(battle);
  assert.ok(certificate);
  const oracle = nativeInterval(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
  assert.ok(certificate.lower <= oracle.lower + 1e-9);
  assert.ok(certificate.upper >= oracle.upper - 1e-9);
});

test('a first-move defense increase invalidates the response damage lower bound', () => {
  const battle = position('Scale Shot');
  assert.ok(envelope(battle));
  const definition: any = battle.dex.moves.get('scaleshot');
  const original = definition.selfBoost;
  try {
    definition.selfBoost = {boosts: {def: 1}};
    assert.equal(envelope(battle), null);
  } finally {
    definition.selfBoost = original;
  }
});


test('native callbacks relocated to another event slot do not enter the envelope', () => {
  const battle = createBattle({species: 'Garchomp', level: 50, ability: 'Rough Skin', item: 'Focus Sash',
    moves: ['Water Gun']}, {species: 'Blissey', level: 50, ability: 'Stamina', item: 'Sitrus Berry',
    moves: ['Mud-Slap']});
  setHP(battle, 'p1', 1);
  refreshMoveRequest(battle);
  assert.ok(envelope(battle));
  const item: any = battle.dex.items.get('focussash');
  const descriptor = Object.getOwnPropertyDescriptor(item, 'onAfterMoveSecondarySelf');
  try {
    item.onAfterMoveSecondarySelf = (battle.dex.items.get('sitrusberry') as any).onEat;
    // The broad native audit promises callback origin, not event semantics.
    assert.equal(auditNativeRules(battle), true);
    assert.equal(createTerminalEnvelope(battle), null);
    battle.makeChoices('move 1', 'move 1');
    assert.equal(battle.ended, false);
    assert.ok(battle.p1.active[0].hp > 1, 'healing before the response defeats the initial-HP KO claim');
  } finally {
    if (descriptor) Object.defineProperty(item, 'onAfterMoveSecondarySelf', descriptor);
    else delete item.onAfterMoveSecondarySelf;
  }
});


test('numeric event callbacks are not mistaken for event-order metadata', () => {
  const battle = position();
  const item: any = battle.dex.items.get('focussash');
  const descriptor = Object.getOwnPropertyDescriptor(item, 'onFractionalPriority');
  try {
    item.onFractionalPriority = 1;
    assert.equal(createTerminalEnvelope(battle), null);
  } finally {
    if (descriptor) Object.defineProperty(item, 'onFractionalPriority', descriptor);
    else delete item.onFractionalPriority;
  }
});


test('an added third type is outside the damage-overflow certificate domain', () => {
  const battle = position();
  battle.p1.active[0].addType('Ghost');
  assert.equal(battle.p1.active[0].getTypes().length, 3);
  assert.equal(Object.keys(battle.p1.active[0].volatiles).length, 0);
  assert.equal(createTerminalEnvelope(battle), null);
});


test('a healing attacker uses its possible healed HP for the response threshold', () => {
  const battle = position();
  battle.p1.active[0].setItem('sitrusberry');
  const certificate = envelope(battle);
  assert.ok(certificate);
  const oracle = nativeInterval(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
  assert.ok(certificate.lower <= oracle.lower + 1e-9);
  assert.ok(certificate.upper >= oracle.upper - 1e-9);
});

function probabilityPosition(firstMove = 'Power Gem', response = 'Power Gem') {
  const battle = createBattle({species: 'Garchomp', level: 50, ability: 'Rough Skin', moves: [firstMove]},
    {species: 'Primarina', level: 50, ability: 'Torrent', item: 'Sitrus Berry', moves: [response]});
  setHP(battle, 'p1', 25);
  setHP(battle, 'p2', 65);
  refreshMoveRequest(battle);
  return battle;
}

for (const [first, hp] of [['Power Gem', 30], ['Hydro Pump', 20], ['Frost Breath', 14]] as const) {
  test(`probabilistic KO partitions enclose native damage and accuracy: ${first}`, () => {
    const battle = probabilityPosition(first);
    battle.p2.active[0].setItem('');
    setHP(battle, 'p2', hp);
    const snapshot = snapshotBattle(battle);
    const before = JSON.stringify(snapshot);
    const certificate = envelope(battle);
    assert.ok(certificate);
    const oracle = nativeInterval(snapshot, legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
    assert.ok(certificate.lower <= oracle.lower + 1e-9);
    assert.ok(certificate.upper >= oracle.upper - 1e-9);
    assert.ok(certificate.lower > -1 && certificate.upper < 1, 'both terminal events have known positive mass');
    assert.ok(certificate.lower <= certificate.upper);
    assert.equal(JSON.stringify(snapshotBattle(battle)), before);
  });
}

test('Torrent HP regimes and berry healing keep native response mass enclosed', () => {
  const battle = probabilityPosition('Water Gun', 'Hydro Pump');
  setHP(battle, 'p1', 100);
  setHP(battle, 'p2', 40);
  const certificate = envelope(battle);
  assert.ok(certificate);
  const oracle = nativeInterval(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
  assert.ok(certificate.lower <= oracle.lower + 1e-9);
  assert.ok(certificate.upper >= oracle.upper - 1e-9);
});

test('a first secondary is left unknown instead of assuming the response can act', () => {
  const battle = probabilityPosition('Thunderbolt', 'Power Gem');
  const certificate = envelope(battle);
  assert.ok(certificate);
  // Use the already independently audited simulator distribution here:
  // raw random(100) secondary leaves otherwise multiply the oracle by 100.
  const native = enumerateTurn(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
  const lower = native.outcomes.reduce((sum, outcome) => sum + outcome.probability * (outcome.utility ?? -1), 0);
  const upper = native.outcomes.reduce((sum, outcome) => sum + outcome.probability * (outcome.utility ?? 1), 0);
  assert.ok(certificate.lower <= lower + 1e-9);
  assert.ok(certificate.upper >= upper - 1e-9);
});

test('an explicit no-crit native damage rule is not assigned ordinary critical mass', () => {
  const battle = probabilityPosition();
  const definition: any = battle.dex.moves.get('powergem');
  const descriptor = Object.getOwnPropertyDescriptor(definition, 'willCrit');
  try {
    definition.willCrit = false;
    const certificate = envelope(battle);
    assert.ok(certificate);
    const oracle = nativeInterval(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
    assert.ok(certificate.lower <= oracle.lower + 1e-9);
    assert.ok(certificate.upper >= oracle.upper - 1e-9);
  } finally {
    if (descriptor) Object.defineProperty(definition, 'willCrit', descriptor);
    else delete definition.willCrit;
  }
});


test('Torrent callbacks require their audited event slots', () => {
  const battle = probabilityPosition('Water Gun', 'Hydro Pump');
  const ability: any = battle.dex.abilities.get('torrent');
  const descriptor = Object.getOwnPropertyDescriptor(ability, 'onBasePower');
  try {
    ability.onBasePower = ability.onModifySpA;
    assert.equal(auditNativeRules(battle), true);
    assert.equal(createTerminalEnvelope(battle), null);
  } finally {
    if (descriptor) Object.defineProperty(ability, 'onBasePower', descriptor);
    else delete ability.onBasePower;
  }
});

test('Champions full PP special-attack cells expose partial terminal mass', () => {
  for (const hp of [50, 100]) {
    const fixture = championsCases().find(entry => entry.id === `primarina-${hp}-vs-archaludon-100`);
    const battle = createChampionsBattle(fixture);
    const first = legalActions(battle, 0).find(action => action.id === 'moonblast');
    const reply = legalActions(battle, 1).find(action => action.id === 'thunderbolt');
    const certificate = createTerminalEnvelope(battle)?.(snapshotBattle(battle), first, reply);
    assert.ok(certificate, `partial certificate at HP ${hp}`);
    assert.ok(certificate.lower > -1 || certificate.upper < 1);
    assert.ok(certificate.lower <= certificate.upper);
  }
});
