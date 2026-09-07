import assert from 'node:assert/strict';
import test from 'node:test';
import {trivialPriorityKO, suckerPunchGame} from '../src/cases';
import {AsyncTransitionSolver} from '../src/async-solver';
import {TransitionPool} from '../src/transition-pool';

test('pool and solver reject invalid worker sizing and routes', async () => {
  assert.throws(() => new TransitionPool(0), /size must be a positive integer/);
  assert.throws(() => new TransitionPool(1, {batchSize: 0}), /batchSize must be a positive integer/);
  const pool = new TransitionPool(2);
  await pool.ready;
  try {
    assert.throws(
      () => new AsyncTransitionSolver({pool, workerCount: 1}),
      /does not match pool size 2/
    );
    await assert.rejects(
      pool.run({}, {command: 'auto'}, {command: 'auto'}, {workerRoute: 2}),
      /Invalid worker route 2/
    );
  } finally {
    await pool.close();
  }
});

test('one transition pool rejects overlapping solve leases', async () => {
  const pool = new TransitionPool(2);
  await pool.ready;
  try {
    const first = new AsyncTransitionSolver({pool, workerCount: 2}).solve(trivialPriorityKO().battle);
    await assert.rejects(
      () => new AsyncTransitionSolver({pool, workerCount: 2}).solve(trivialPriorityKO().battle),
      /active solve/
    );
    await first;
  } finally {
    await pool.close();
  }
});

test('async maxStates includes pending distinct states', async () => {
  const pool = new TransitionPool(2);
  await pool.ready;
  try {
    await assert.rejects(
      () => new AsyncTransitionSolver({pool, workerCount: 2, eager: true, maxStates: 1})
        .solve(suckerPunchGame().battle),
      /State limit \(1\) exceeded/
    );
    const recovered = await new AsyncTransitionSolver({
      pool, workerCount: 2, eager: false, maxStates: 100,
    }).solve(trivialPriorityKO().battle);
    assert.equal(recovered.value, 1);
  } finally {
    await pool.close();
  }
});

test('reusing one async solver starts a fresh memo and stats context', async () => {
  const pool = new TransitionPool(2);
  await pool.ready;
  try {
    const solver = new AsyncTransitionSolver({pool, workerCount: 2, eager: false});
    const first = await solver.solve(trivialPriorityKO().battle);
    const second = await solver.solve(trivialPriorityKO().battle);
    assert.equal(first.value, 1);
    assert.equal(second.value, 1);
    assert.equal(second.stats.solvedStates, first.stats.solvedStates);
    assert.equal(second.stats.transitionCalls, first.stats.transitionCalls);
  } finally {
    await pool.close();
  }
});

test('worker initialization errors reject the pool request', async () => {
  const pool = new TransitionPool(1);
  await pool.ready;
  try {
    const timeout = new Promise((_, reject) => setTimeout(
      () => reject(new Error('init error request timed out')), 1000
    ));
    await assert.rejects(
      Promise.race([
        pool.initSolve({bad: true}),
        timeout,
      ]),
      /reading 'slice'/
    );
  } finally {
    await pool.close();
  }
});

test('failure drain rejects a child scheduled by a late microtask', async () => {
  const pool = {size: 1, batchSize: 1} as TransitionPool;
  const solver = new AsyncTransitionSolver({pool, workerCount: 1});
  const abort = new Error('search failed');
  let childAttempted = false;
  const pending = (async () => {
    await Promise.resolve();
    childAttempted = true;
    return await solver._solve({}, false);
  })().finally(() => solver.pendingStates.delete('parent'));
  solver.pendingStates.set('parent', pending);
  solver.abortError = abort;
  await solver.drainPending();
  assert.equal(childAttempted, true);
  assert.equal(solver.pendingStates.size, 0);
});

test('worker failure rejects all queued work and makes the pool unavailable', async () => {
  const pool = new TransitionPool(1);
  await pool.ready;
  const pending = pool.run({}, {command: 'auto'}, {command: 'auto'}, {workerRoute: 0});
  await pool.workers[0].worker.terminate();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('worker failure timed out')), 1000)),
    ]),
    /worker failed|closed|unavailable/
  );
  assert.equal(pool.closed, true);
  await pool.close();
});

test('closing a pool before worker startup terminates created workers', async () => {
  const pool = new TransitionPool(4);
  await pool.close();
  assert.equal(pool.workers.length, 0);
});
