'use strict';

// Deliberately slow reference implementation retained only for differential
// tests of the production solver.
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

function normalize(strategy) {
  const sum = strategy.reduce((a, b) => a + b, 0);
  return strategy.map(x => x / sum);
}

function solveSide(payoff, maximizing) {
  const m = payoff.length;
  const n = payoff[0].length;
  const size = maximizing ? m : n;
  const constraints = maximizing
    ? [...Array.from({length: m}, (_, i) => ['zero', i]),
       ...Array.from({length: n}, (_, j) => ['payoff', j])]
    : [...Array.from({length: n}, (_, j) => ['zero', j]),
       ...Array.from({length: m}, (_, i) => ['payoff', i])];
  let best = null;
  for (const active of combinations(constraints.length, size)) {
    const equations = [Array(size).fill(1).concat(0)];
    const rhs = [1];
    for (const ci of active) {
      const [type, index] = constraints[ci];
      const row = Array(size + 1).fill(0);
      if (type === 'zero') row[index] = 1;
      else if (maximizing) {
        for (let i = 0; i < m; i++) row[i] = payoff[i][index];
        row[m] = -1;
      } else {
        for (let j = 0; j < n; j++) row[j] = payoff[index][j];
        row[n] = -1;
      }
      equations.push(row);
      rhs.push(0);
    }
    const solution = solveLinearSystem(equations, rhs);
    if (!solution) continue;
    const strategy = solution.slice(0, size);
    const value = solution[size];
    if (strategy.some(x => x < -EPS)) continue;
    let feasible = true;
    if (maximizing) {
      for (let j = 0; j < n; j++) {
        const actual = strategy.reduce((sum, p, i) => sum + p * payoff[i][j], 0);
        if (actual < value - 1e-7) feasible = false;
      }
    } else {
      for (let i = 0; i < m; i++) {
        const actual = strategy.reduce((sum, q, j) => sum + q * payoff[i][j], 0);
        if (actual > value + 1e-7) feasible = false;
      }
    }
    if (feasible && (!best || (maximizing ? value > best.value + EPS : value < best.value - EPS))) {
      best = {strategy: normalize(strategy), value};
    }
  }
  if (!best) throw new Error('oracle could not solve matrix');
  return best;
}

function solveZeroSumMatrixOracle(payoff) {
  const row = solveSide(payoff, true);
  const column = solveSide(payoff, false);
  if (Math.abs(row.value - column.value) > 1e-6) throw new Error('oracle duality gap');
  return {value: (row.value + column.value) / 2, p1: row.strategy, p2: column.strategy};
}

module.exports = {solveZeroSumMatrixOracle};
