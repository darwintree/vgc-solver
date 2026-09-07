import type {Mutable} from './helpers/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import {AsyncBoundedSolver} from '../src/async-bounded-solver';
import {BoundedSolver} from '../src/bounded-solver';
import {TransitionPool} from '../src/transition-pool';
import {suckerPunchCoverageGame, suckerPunchGame, trivialPriorityKO} from '../src/cases';
import {refreshMoveRequest, setMovePP} from '../src/showdown-adapter';

test('worker-backed full-PP interval contains the exact reference', async () => {
  const exactValue = 0.601097268633219;
  const pool = new TransitionPool(4, {batchSize: 4});
  try {
    const result = await new AsyncBoundedSolver({
      pool, workerCount: 4, batchSize: 4, tolerance: 0.02,
      maxSearchMs: 5000, maxNodes: 10000,
    }).solve(suckerPunchGame().battle);
    assert.ok(result.lowerBound <= exactValue + 1e-9);
    assert.ok(result.upperBound >= exactValue - 1e-9);
    assert.ok(result.converged);
    assert.equal(result.backend, 'worker');
    assert.ok(pool.metrics.dispatched > 0);
    assert.equal(pool.metrics.completed, pool.metrics.dispatched);
  } finally {
    await pool.close();
  }
});

test('worker-backed full-PP coverage interval contains the exact reference', async () => {
  const exactValue = 0.6409875417141699;
  const expectedPP = [[8, 32, 16], [16, 56, 8]];
  const {battle} = suckerPunchCoverageGame();
  for (let sideIndex = 0; sideIndex < battle.sides.length; sideIndex++) {
    const side = battle.sides[sideIndex];
    for (let moveIndex = 0; moveIndex < side.active[0].moveSlots.length; moveIndex++) {
      setMovePP(battle, side.id, side.active[0].moveSlots[moveIndex].id,
        expectedPP[sideIndex][moveIndex]);
    }
  }
  refreshMoveRequest(battle);
  for (let sideIndex = 0; sideIndex < battle.sides.length; sideIndex++) {
    assert.deepEqual(
      battle.sides[sideIndex].active[0].moveSlots.map(move => move.pp),
      expectedPP[sideIndex]
    );
  }

  const pool = new TransitionPool(4, {batchSize: 4});
  try {
    const result = await new AsyncBoundedSolver({
      pool, workerCount: 4, batchSize: 4, tolerance: 0.02,
      maxSearchMs: 30000, maxNodes: 20000, lazyCells: false,
    }).solve(battle);
    assert.ok(result.lowerBound <= exactValue + 1e-9);
    assert.ok(result.upperBound >= exactValue - 1e-9);
    assert.ok(result.upperBound - result.lowerBound <= 0.02 + 1e-9);
    assert.ok(result.converged);
    assert.equal(result.backend, 'worker');
    assert.ok(pool.metrics.dispatched > 0);
    assert.equal(pool.metrics.completed, pool.metrics.dispatched);
    assert.equal(pool.pending.size, 0);
    assert.equal(pool.queue.length, 0);
  } finally {
    await pool.close();
  }
});

test('custom Dex rules use synchronous bounded fallback without worker dispatch', async () => {
  const {battle} = trivialPriorityKO();
  const move = battle.dex.moves.get('quickattack') as Mutable<ReturnType<typeof battle.dex.moves.get>>;
  const original = move.basePower;
  move.basePower = 0;
  try {
    const expected = new BoundedSolver({tolerance: 0, maxSearchMs: 1000}).solve(battle);
    const pool = new TransitionPool(2);
    await pool.ready;
    try {
      const result = await new AsyncBoundedSolver({
        pool, workerCount: 2, tolerance: 0, maxSearchMs: 1000,
      }).solve(battle);
      assert.equal(result.value, expected.value);
      assert.equal(result.backend, 'fallback');
      assert.equal(pool.metrics.dispatched, 0);
    } finally {
      await pool.close();
    }
  } finally {
    move.basePower = original;
  }
});

test('custom adapters use synchronous bounded fallback', async () => {
  const adapter = {
    snapshotBattle: state => state,
    restoreBattle: state => state,
    stateKey: state => String(state),
    terminalUtility: state => state === 'win' ? 1 : null,
    legalActions: () => ['finish'],
    enumerateTurn: () => ({outcomes: [{utility: 1, probability: 1}]}),
  };
  const pool = new TransitionPool(1);
  try {
    const result = await new AsyncBoundedSolver({
      adapter, pool, workerCount: 1, tolerance: 0, maxSearchMs: 1000,
    }).solve('root');
    assert.ok(Math.abs(result.value - 1) < 1e-8);
    assert.equal(result.backend, 'fallback');
    assert.equal(pool.metrics.dispatched, 0);
  } finally {
    await pool.close();
  }
});

test('worker failure drains outstanding jobs and a fresh pool remains usable', async () => {
  const pool = new TransitionPool(2, {batchSize: 2});
  await pool.ready;
  try {
    const solver = new AsyncBoundedSolver({
      pool, workerCount: 2, batchSize: 2, tolerance: 0,
      maxSearchMs: 10000, maxNodes: 100000,
    });
    const originalRun = pool.run.bind(pool);
    let firstDispatch = true;
    pool.run = (...args) => {
      const pending = originalRun(...args);
      if (firstDispatch) {
        firstDispatch = false;
        setImmediate(() => pool.workers[0].worker.terminate());
      }
      return pending;
    };
    const pending = solver.solve(suckerPunchCoverageGame().battle);
    await assert.rejects(pending, /Transition pool worker failed|closed|unavailable/);
    assert.equal(pool.pending.size, 0);
    assert.equal(pool.queue.length, 0);
  } finally {
    await pool.close();
  }

  const freshPool = new TransitionPool(1);
  try {
    const result = await new AsyncBoundedSolver({
      pool: freshPool, workerCount: 1, tolerance: 0,
      maxSearchMs: 1000,
    }).solve(trivialPriorityKO().battle);
    assert.ok(Math.abs(result.value - 1) < 1e-8);
  } finally {
    await freshPool.close();
  }
});

test('concurrent calls reject before resetting the active search', async () => {
  const pool = new TransitionPool(2, {batchSize: 2});
  try {
    const solver = new AsyncBoundedSolver({
      pool, workerCount: 2, batchSize: 2, tolerance: 0,
      maxSearchMs: 500, maxNodes: 100000,
    });
    const first = solver.solve(suckerPunchCoverageGame().battle);
    await assert.rejects(
      () => solver.solve(suckerPunchCoverageGame().battle),
      /already has an active solve/
    );
    const result = await first;
    assert.equal(result.stopReason, 'time');
  } finally {
    await pool.close();
  }
});

test('zero search budget exits before root warm-start cell access', async () => {
  const pool = new TransitionPool(1);
  try {
    const result = await new AsyncBoundedSolver({
      pool, workerCount: 1, tolerance: 0, maxSearchMs: 0,
    }).solve(suckerPunchGame().battle);
    assert.equal(result.converged, false);
    assert.equal(result.stopReason, 'time');
    assert.equal(result.lowerBound, -1);
    assert.equal(result.upperBound, 1);
  } finally {
    await pool.close();
  }
});
