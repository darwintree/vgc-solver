'use strict';

const EPS = 1e-9;

function* combinations(n, k, start = 0, prefix = []) {
  if (k === 0) {
    yield prefix;
    return;
  }
  for (let i = start; i <= n - k; i++) {
    yield* combinations(n, k - 1, i + 1, [...prefix, i]);
  }
}

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < EPS) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const scale = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= scale;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) < EPS) continue;
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

function normalizeStrategy(strategy) {
  const cleaned = strategy.map(x => Math.abs(x) < EPS ? 0 : x);
  const sum = cleaned.reduce((a, b) => a + b, 0);
  if (sum <= EPS) throw new Error('Invalid zero-mass strategy');
  return cleaned.map(x => x / sum);
}

function solveRowPlayer(payoff) {
  const m = payoff.length;
  const n = payoff[0].length;
  const constraints = [
    ...Array.from({length: m}, (_, i) => ({type: 'zero', index: i})),
    ...Array.from({length: n}, (_, j) => ({type: 'payoff', index: j})),
  ];

  let best = null;
  for (const active of combinations(constraints.length, m)) {
    const equations = [Array(m).fill(1).concat(0)];
    const rhs = [1];

    for (const ci of active) {
      const c = constraints[ci];
      const row = Array(m + 1).fill(0);
      if (c.type === 'zero') {
        row[c.index] = 1;
      } else {
        for (let i = 0; i < m; i++) row[i] = payoff[i][c.index];
        row[m] = -1;
      }
      equations.push(row);
      rhs.push(0);
    }

    const solution = solveLinearSystem(equations, rhs);
    if (!solution) continue;
    const p = solution.slice(0, m);
    const value = solution[m];
    if (p.some(x => x < -EPS)) continue;

    let feasible = true;
    for (let j = 0; j < n; j++) {
      const columnValue = p.reduce((sum, pi, i) => sum + pi * payoff[i][j], 0);
      if (columnValue < value - 1e-7) {
        feasible = false;
        break;
      }
    }
    if (feasible && (!best || value > best.value + EPS)) {
      best = {strategy: normalizeStrategy(p), value};
    }
  }
  if (!best) throw new Error('Could not solve row-player LP');
  return best;
}

function solveColumnPlayer(payoff) {
  const m = payoff.length;
  const n = payoff[0].length;
  const constraints = [
    ...Array.from({length: n}, (_, j) => ({type: 'zero', index: j})),
    ...Array.from({length: m}, (_, i) => ({type: 'payoff', index: i})),
  ];

  let best = null;
  for (const active of combinations(constraints.length, n)) {
    const equations = [Array(n).fill(1).concat(0)];
    const rhs = [1];

    for (const ci of active) {
      const c = constraints[ci];
      const row = Array(n + 1).fill(0);
      if (c.type === 'zero') {
        row[c.index] = 1;
      } else {
        for (let j = 0; j < n; j++) row[j] = payoff[c.index][j];
        row[n] = -1;
      }
      equations.push(row);
      rhs.push(0);
    }

    const solution = solveLinearSystem(equations, rhs);
    if (!solution) continue;
    const q = solution.slice(0, n);
    const value = solution[n];
    if (q.some(x => x < -EPS)) continue;

    let feasible = true;
    for (let i = 0; i < m; i++) {
      const rowValue = q.reduce((sum, qj, j) => sum + qj * payoff[i][j], 0);
      if (rowValue > value + 1e-7) {
        feasible = false;
        break;
      }
    }
    if (feasible && (!best || value < best.value - EPS)) {
      best = {strategy: normalizeStrategy(q), value};
    }
  }
  if (!best) throw new Error('Could not solve column-player LP');
  return best;
}

/** Solve a finite zero-sum matrix game. Payoffs are from player 1's perspective. */
function solveZeroSumMatrix(payoff) {
  if (!Array.isArray(payoff) || payoff.length === 0 || payoff[0].length === 0) {
    throw new Error('Payoff matrix must be non-empty');
  }
  const width = payoff[0].length;
  if (!payoff.every(row => row.length === width && row.every(Number.isFinite))) {
    throw new Error('Payoff matrix must be rectangular and finite');
  }

  const row = solveRowPlayer(payoff);
  const column = solveColumnPlayer(payoff);
  if (Math.abs(row.value - column.value) > 1e-6) {
    throw new Error(`LP duality gap is too large: ${row.value} vs ${column.value}`);
  }
  return {
    value: (row.value + column.value) / 2,
    p1: row.strategy,
    p2: column.strategy,
  };
}

module.exports = {solveZeroSumMatrix};
