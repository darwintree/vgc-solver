import type {TransitionPool} from '../src/transition-pool';
import type {SearchNode} from '../src/bounded-solver';
import assert from 'node:assert/strict';
import test from 'node:test';
import {AsyncBoundedSolver} from '../src/async-bounded-solver';

function makeNode(rows, columns) {
  return {
    snapshot: {},
    terminal: null,
    initialized: true,
    actions1: Array.from({length: rows}, (_, i) => ({command: `p1-${i}`})),
    actions2: Array.from({length: columns}, (_, j) => ({command: `p2-${j}`})),
    cells: Array.from({length: rows}, () => Array.from({length: columns}, () => ({
      outcomes: null,
      lower: -1,
      upper: 1,
    }))),
  };
}

test('bounded worker routing gives distinct row-major affinity for variable action grids', async () => {
  for (const [rows, columns] of [[2, 3], [3, 2], [2, 4]]) {
    const workerCount = rows * columns;
    const routes = [];
    const pool = {
      size: workerCount,
      batchSize: workerCount,
      run(_snapshot, _p1Action, _p2Action, options) {
        routes.push(options.workerRoute);
        return Promise.resolve({
          outcomes: [{utility: 0, probability: 1}],
          simulatorRuns: 0,
        });
      },
    };
    const solver = new AsyncBoundedSolver({pool: pool as TransitionPool, workerCount, batchSize: workerCount});
    solver._timedOut = () => false;
    const node = makeNode(rows, columns);
    const cells = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) cells.push({i, j});
    }
    await solver._expandCellsAsync(node as SearchNode, cells);
    assert.deepEqual(routes, Array.from({length: rows * columns}, (_, rank) => rank));
  }
});
