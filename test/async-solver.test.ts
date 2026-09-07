import assert from 'node:assert/strict';
import test from 'node:test';
import {suckerPunchGame} from '../src/cases';
import {AsyncTransitionSolver} from '../src/async-solver';
import {TransitionPool} from '../src/transition-pool';

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('async eager solver preserves the full-PP Sucker Punch root result', async () => {
  const {battle} = suckerPunchGame();
  const expectedPP = [
    ...battle.p1.active[0].moveSlots.map(slot => slot.pp),
    ...battle.p2.active[0].moveSlots.map(slot => slot.pp),
  ];
  assert.deepEqual(expectedPP, [8, 32, 16, 56]);

  const pool = new TransitionPool(8, {batchSize: 8});
  try {
    await pool.ready;
    const result = await new AsyncTransitionSolver({
      pool,
      workerCount: 8,
      batchSize: 8,
      eager: true,
    }).solve(battle);

    close(result.value, 0.601097268633219);
    const expectedMatrix = [[0.593927528471411, 1], [0.6298748389209616, -1]];
    for (let row = 0; row < expectedMatrix.length; row++) {
      for (let column = 0; column < expectedMatrix[row].length; column++) {
        close(result.payoffMatrix[row][column], expectedMatrix[row][column]);
      }
    }
    for (const [actual, expected] of [
      [result.p1Strategy[0].probability, 0.8005486343166093],
      [result.p1Strategy[1].probability, 0.19945136568339072],
      [result.p2Strategy[0].probability, 0.9823436931471409],
      [result.p2Strategy[1].probability, 0.017656306852859106],
    ]) close(actual, expected);
    assert.ok(pool.metrics.dispatched > 0, 'the solve must dispatch transitions to workers');
  } finally {
    await pool.close();
  }
});
