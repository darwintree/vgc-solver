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
  return factory?.(snapshotBattle(battle))?.(legalActions(battle, 0)[0], legalActions(battle, 1)[0]) ?? null;
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
  assert.equal(factory(snapshotBattle(valid), -Infinity), null);
});


test('Champions native PP states admit the costly multi-hit response certificate', () => {
  for (const [hp, response, upper] of [[25, 'flashcannon', -1], [50, 'dracometeor', -0.8]] as const) {
    const fixture = championsCases().find(entry => entry.id === `garchomp-${hp}-vs-archaludon-100`);
    const battle = createChampionsBattle(fixture);
    const first = legalActions(battle, 0).find(action => action.id === 'scaleshot');
    const reply = legalActions(battle, 1).find(action => action.id === response);
    const factory = createTerminalEnvelope(battle);
    const certificate = factory?.(snapshotBattle(battle))?.(first, reply);
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
    assert.equal(envelope(battle), null);
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
    assert.equal(envelope(battle), null);
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
  assert.equal(envelope(battle), null);
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
    assert.equal(envelope(battle), null);
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
    const certificate = createTerminalEnvelope(battle)?.(snapshotBattle(battle))?.(first, reply);
    assert.ok(certificate, `partial certificate at HP ${hp}`);
    assert.ok(certificate.lower > -1 || certificate.upper < 1);
    assert.ok(certificate.lower <= certificate.upper);
  }
});


test('prepared snapshot shares move summaries without pair-order contamination', () => {
  const battle = createBattle({species: 'Primarina', level: 50, ability: 'Torrent', item: 'Sitrus Berry',
    moves: ['Moonblast', 'Sparkling Aria', 'Hydro Pump', 'Aqua Jet']},
  {species: 'Archaludon', level: 50, ability: 'Stamina', item: 'Sitrus Berry',
    moves: ['Flash Cannon', 'Draco Meteor', 'Dragon Pulse', 'Metal Sound']});
  for (const hp of [1, Math.floor(battle.p1.active[0].maxhp / 3), battle.p1.active[0].maxhp]) {
    setHP(battle, 'p1', hp);
    refreshMoveRequest(battle);
    const snapshot = snapshotBattle(battle);
    const before = JSON.stringify(snapshot);
    const factory = createTerminalEnvelope(battle);
    assert.ok(factory);
    const pairs = legalActions(battle, 0).flatMap(first =>
      legalActions(battle, 1).map(second => [first, second] as const));
    const expected = pairs.map(([first, second]) => factory(snapshot)?.(first, second) ?? null);
    for (const order of [pairs.map((_, i) => i), pairs.map((_, i) => i).reverse()]) {
      const prepared = factory(snapshot);
      assert.ok(prepared);
      for (const index of order) {
        assert.deepEqual(prepared(...pairs[index]), expected[index]);
        assert.deepEqual(prepared(...pairs[index]), expected[index]);
      }
    }
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(JSON.stringify(snapshotBattle(battle)), before);
  }
});

test('prepared evaluator owns its snapshot and expired preparation yields no certificate', () => {
  const battle = position();
  const snapshot = snapshotBattle(battle);
  const first = legalActions(battle, 0)[0];
  const second = legalActions(battle, 1)[0];
  const factory = createTerminalEnvelope(battle);
  const expected = factory(snapshot)?.(first, second) ?? null;
  const prepared = factory(snapshot);
  snapshot.sides[0].pokemon[0].hp = 0;
  assert.deepEqual(prepared(first, second), expected);
  assert.equal(factory(snapshot, -Infinity), null);
});


function bustedPosition(firstMove = 'Shadow Claw', response = 'Water Gun') {
  const battle = createBattle({species: 'Mimikyu', level: 50, ability: 'Disguise', item: 'Life Orb',
    moves: [firstMove]}, {species: 'Primarina', level: 50, ability: 'Torrent', moves: [response]});
  battle.p1.active[0].formeChange('Mimikyu-Busted', battle.dex.abilities.get('disguise'), true);
  refreshMoveRequest(battle);
  return battle;
}

function assertNativeEnclosure(battle) {
  const certificate = envelope(battle);
  const oracle = nativeInterval(snapshotBattle(battle), legalActions(battle, 0)[0], legalActions(battle, 1)[0]);
  assert.ok((certificate?.lower ?? -1) <= oracle.lower + 1e-9);
  assert.ok((certificate?.upper ?? 1) >= oracle.upper - 1e-9);
  return certificate;
}

test('a native-audited intact root can prepare a later busted Disguise node', () => {
  const battle = createBattle({species: 'Mimikyu', level: 50, ability: 'Disguise', item: 'Life Orb',
    moves: ['Shadow Claw']}, {species: 'Primarina', level: 50, ability: 'Torrent', moves: ['Water Gun']});
  const factory = createTerminalEnvelope(battle);
  assert.ok(factory);
  assert.equal(factory(snapshotBattle(battle)), null);
  battle.p1.active[0].formeChange('Mimikyu-Busted', battle.dex.abilities.get('disguise'), true);
  setHP(battle, 'p2', 10);
  refreshMoveRequest(battle);
  assert.ok(factory(snapshotBattle(battle))?.(legalActions(battle, 0)[0], legalActions(battle, 1)[0]));
  assert.ok(assertNativeEnclosure(battle));
});

for (const hp of [13, 14, 15]) {
  test(`first Life Orb KO respects native recoil boundary at HP${hp}`, () => {
    const battle = bustedPosition();
    setHP(battle, 'p1', hp);
    setHP(battle, 'p2', 10);
    refreshMoveRequest(battle);
    const certificate = assertNativeEnclosure(battle);
    if (hp > Math.ceil(battle.p1.active[0].baseMaxhp / 10)) assert.equal(certificate?.lower, 1);
    else assert.notEqual(certificate?.lower, 1);
  });
}

for (const hp of [20, 80, 131]) {
  test(`response Life Orb keeps damage and recoil survival jointly safe at HP${hp}`, () => {
    const battle = bustedPosition('Shadow Claw');
    battle.p1.active[0].boosts.spe = -6;
    battle.p2.active[0].boosts.spe = 6;
    setHP(battle, 'p1', Math.min(hp, battle.p1.active[0].maxhp));
    setHP(battle, 'p2', 20);
    refreshMoveRequest(battle);
    assertNativeEnclosure(battle);
  });
}

test('contact damage refuses Rough Skin and suppressed items remain outside admission', () => {
  const contact = bustedPosition();
  contact.p2.active[0].setAbility('roughskin');
  assert.equal(envelope(contact), null);
  const suppressed = bustedPosition();
  suppressed.p1.active[0].addVolatile('embargo');
  assert.equal(envelope(suppressed), null);
  const transformed = bustedPosition();
  transformed.p1.active[0].transformed = true;
  assert.equal(envelope(transformed), null);
});

test('Life Orb and Disguise require exact callbacks in their native event slots', () => {
  for (const [kind, id, event, replacement] of [
    ['items', 'lifeorb', 'onModifyDamage', () => 100000],
    ['items', 'lifeorb', 'onAfterMoveSecondarySelf', () => {}],
    ['abilities', 'disguise', 'onUpdate', () => {}],
  ] as const) {
    const battle = bustedPosition();
    const effect = battle.dex[kind].get(id) as any;
    const original = effect[event];
    try {
      effect[event] = replacement;
      assert.equal(envelope(battle), null);
    } finally { effect[event] = original; }
  }
});


test('Life Orb damage outside the no-overflow domain remains unknown', () => {
  const battle = bustedPosition();
  battle.p1.active[0].storedStats.atk = 1000000;
  battle.p1.active[0].boosts.atk = 6;
  refreshMoveRequest(battle);
  assert.equal(envelope(battle), null);
});


test('first Life Orb accuracy and secondary branches remain inside native bounds', () => {
  const battle = bustedPosition('Play Rough');
  setHP(battle, 'p2', 10);
  refreshMoveRequest(battle);
  assert.ok(assertNativeEnclosure(battle));
});


test('combined native recoil and healing callbacks fall back before crossing the berry threshold', () => {
  const battle = bustedPosition('Shadow Claw', 'Moonblast');
  setHP(battle, 'p1', 70);
  refreshMoveRequest(battle);
  const item = battle.dex.items.get('lifeorb') as any;
  const berry = battle.dex.items.get('sitrusberry') as any;
  const events = ['onUpdate', 'onTryEatItem', 'onEat'];
  const descriptors = events.map(event => Object.getOwnPropertyDescriptor(item, event));
  try {
    for (const event of events) item[event] = berry[event];
    assert.equal(auditNativeRules(battle), true, 'each callback has native source and event slot');
    assert.ok(battle.p1.active[0].hp > battle.p1.active[0].maxhp / 2);
    assert.ok(battle.p1.active[0].hp - Math.floor(battle.p1.active[0].baseMaxhp / 10) <=
      battle.p1.active[0].maxhp / 2, 'recoil can newly activate healing');
    assert.equal(envelope(battle), null);
  } finally {
    for (const [index, event] of events.entries()) {
      if (descriptors[index]) Object.defineProperty(item, event, descriptors[index]);
      else delete item[event];
    }
  }
});
