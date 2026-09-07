import assert from 'node:assert/strict';
import test from 'node:test';
import {suckerPunchGame} from '../src/cases';
import {refreshMoveRequest, setMovePP} from '../src/showdown-adapter';
import {OneVsOneSolver} from '../src/solver';

function asymmetricBattle(suckerPP, protectPP) {
  const {battle} = suckerPunchGame();
  setMovePP(battle, 'p1', 'Sucker Punch', suckerPP);
  setMovePP(battle, 'p1', 'Knock Off', 8);
  setMovePP(battle, 'p2', 'Protect', protectPP);
  setMovePP(battle, 'p2', 'Tackle', 12);
  refreshMoveRequest(battle);
  return battle;
}

for (const [suckerPP, expected] of [[2, 0.038539553723245135], [3, 0.2939035486727768]]) {
  test(`asymmetric Sucker=${suckerPP}, Protect=4 remains exact`, () => {
    const result = new OneVsOneSolver().solve(asymmetricBattle(suckerPP, 4));
    assert.ok(Math.abs(result.value - expected) < 1e-12);
    assert.ok(result.stats.transitionCalls > 0);
  });
}
