import assert from 'node:assert/strict';
import test from 'node:test';
import {suckerPunchGame} from '../src/cases';
import {
  enumerateTurn,
  legalActions,
  restoreBattle,
  snapshotBattle,
  stateKey,
} from '../src/showdown-adapter';

test('state keys ignore logs and PRNG history without changing the snapshot', () => {
  const snapshot = snapshotBattle(suckerPunchGame().battle);
  const changed = JSON.parse(JSON.stringify(snapshot));
  changed.log = ['different log'];
  changed.inputLog = ['different input'];
  changed.prng = [1, 2, 3, 4];
  const before = JSON.stringify(changed);
  assert.equal(stateKey(changed), stateKey(snapshot));
  assert.equal(JSON.stringify(changed), before);

  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  reordered.unused = undefined;
  assert.equal(stateKey(reordered), stateKey(snapshot));

  changed.sides[0].pokemon[0].moveSlots[0].pp--;
  assert.notEqual(stateKey(changed), stateKey(snapshot));
});

test('terminal random branches merge by utility', () => {
  const {battle} = suckerPunchGame();
  const snapshot = snapshotBattle(battle);
  const p1 = legalActions(battle, 0);
  const p2 = legalActions(battle, 1);
  for (const [index, utility] of [[0, 1], [1, -1]]) {
    const {outcomes} = enumerateTurn(snapshot, p1[index], p2[1]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].utility, utility);
    assert.equal(outcomes[0].probability, 1);
    assert.equal(outcomes[0].snapshot, undefined);
  }
});

test('a repeated Protect splits between a terminal win and a continuing battle', () => {
  const {battle} = suckerPunchGame();
  battle.makeChoices('move 1', 'move 1');
  const {outcomes} = enumerateTurn(
    snapshotBattle(battle), legalActions(battle, 0)[1], legalActions(battle, 1)[0]
  );
  const wins = outcomes.filter(outcome => outcome.utility === 1);
  const continuing = outcomes.filter(outcome => outcome.snapshot);
  assert.equal(wins.length, 1);
  const continuingMass = continuing.reduce((sum, outcome) => sum + outcome.probability, 0);
  assert.ok(Math.abs(wins[0].probability - 2 / 3) < 1e-9);
  assert.ok(Math.abs(continuingMass - 1 / 3) < 1e-9);
  assert.ok(Math.abs(wins[0].probability + continuingMass - 1) < 1e-9);
  for (const {snapshot} of continuing) {
    const next = restoreBattle(snapshot);
    assert.equal(next.ended, false);
    assert.equal(next.p1.active[0].hp, 1);
    assert.equal(next.p2.active[0].hp, 1);
  }
});

test('snapshots and restored battles do not share mutable state', () => {
  const {battle} = suckerPunchGame();
  const snapshot = snapshotBattle(battle);
  const before = JSON.stringify(snapshot);
  const first = restoreBattle(snapshot);
  const second = restoreBattle(snapshot);
  first.makeChoices('move 1', 'move 1');
  first.p1.active[0].set.evs.hp = 4;
  battle.p1.active[0].set.evs.hp = 8;
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(second.p1.active[0].set.evs.hp, 0);
  assert.equal(second.p1.active[0].moveSlots[0].pp, 8);
  assert.equal(second.p2.active[0].moveSlots[0].pp, 16);
});

test('restoring and replaying a frozen snapshot preserves nested state and references', () => {
  const {battle} = suckerPunchGame();
  battle.makeChoices('move 1', 'move 1');
  const snapshot = snapshotBattle(battle);
  function freeze(value) {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(snapshot);

  const first = restoreBattle(snapshot);
  const second = restoreBattle(snapshot);
  assert.equal(first.p1.active[0], first.p1.pokemon[0]);
  assert.equal(first.p1.active[0].battle, first);
  first.p2.active[0].volatiles.stall.counter = 9;
  first.p1.active[0].set.moves.push('Protect');
  first.log.push('local history');
  first.makeChoices('move 2', 'move 1');
  assert.equal(second.p2.active[0].volatiles.stall.counter, 3);
  assert.deepEqual(second.p1.active[0].set.moves, ['Sucker Punch', 'Knock Off']);
  assert.deepEqual(snapshot.log, []);
  assert.deepEqual(second.log, []);
  assert.equal(snapshot.sides[1].pokemon[0].volatiles.stall.counter, 3);
});
