import assert from 'node:assert/strict';
import test from 'node:test';
import {suckerPunchGame} from '../src/cases';
import {
  enumerateTurn,
  snapshotBattle,
} from '../src/showdown-adapter';
import {assertSameDistribution, enumerateNative} from './helpers/distribution';

test('eager enumeration matches throw-and-replay distribution and uses fewer runs', () => {
  const {battle} = suckerPunchGame();
  battle.makeChoices('move 1', 'move 1');
  const snapshot = snapshotBattle(battle);
  const p1Action = {command: 'move 2'};
  const p2Action = {command: 'move 1'};

  const baseline = enumerateNative(snapshot, p1Action, p2Action);
  const eager = enumerateTurn(snapshot, p1Action, p2Action);

  assertSameDistribution(baseline, eager);
  assert.ok(eager.simulatorRuns < baseline.simulatorRuns);
  assert.ok(eager.simulatorRuns > 0);
});
