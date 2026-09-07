import type {MatrixSolution} from './types';

// The game LP is solved after an affine normalization. If B = A / scale -
// offset + 1, then B is strictly positive and
// value(A) = scale * (value(B) + offset - 1).
const SIMPLEX_EPS = 1e-15;
const DUALITY_EPS = 1e-9;
const ENUMERATION_MAX_DIMENSION = 6;

function normalizeStrategy(strategy: number[]): number[] {
  if (strategy.some(x => x < -1e-9)) {
    throw new Error('Strategy contains a negative probability');
  }
  const cleaned = strategy.map(x => x <= SIMPLEX_EPS ? 0 : x);
  const sum = cleaned.reduce((a, b) => a + b, 0);
  if (!(sum > SIMPLEX_EPS)) throw new Error('Invalid zero-mass strategy');
  return cleaned.map(x => x / sum);
}

function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const augmented = matrix.map((row, i) => [...row, rhs[i]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) {
      throw new Error('Simplex basis is numerically singular');
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const scale = augmented[column][column];
    for (let j = column; j <= n; j++) augmented[column][j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (Math.abs(factor) < 1e-15) continue;
      for (let j = column; j <= n; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map(row => row[n]);
}

/**
 * Maximize sum(x) subject to A*x <= 1 and x >= 0.
 *
 * The right hand side is positive, so the all-slack basis is feasible and a
 * one-phase primal simplex is sufficient. Bland's entering and leaving
 * choices make the method deterministic and prevent cycling on degenerate
 * games. This LP is the standard positive-matrix formulation of a matrix
 * game: its normalized solution is the minimizing player's strategy and the
 * reciprocal objective is the game value.
 */
function simplexPositiveCover(matrix: number[][]) {
  const constraints = matrix.length;
  const variables = matrix[0].length;
  const totalVariables = variables + constraints;
  const rhsColumn = totalVariables;
  const tableau = matrix.map((row, i) => {
    const result = [...row, ...Array(constraints).fill(0), 1];
    result[variables + i] = 1;
    return result;
  });
  const objective = Array(totalVariables + 1).fill(0);
  for (let j = 0; j < variables; j++) objective[j] = 1;
  const basis = Array.from({length: constraints}, (_, i) => variables + i);

  const maxIterations = 10000 + 100 * constraints * variables;
  let converged = false;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let entering = -1;
    for (let j = 0; j < totalVariables; j++) {
      if (objective[j] > SIMPLEX_EPS) {
        entering = j;
        break;
      }
    }
    if (entering < 0) {
      converged = true;
      break;
    }

    let leaving = -1;
    let bestRatio = Infinity;
    for (let i = 0; i < constraints; i++) {
      const coefficient = tableau[i][entering];
      if (coefficient <= SIMPLEX_EPS) continue;
      const ratio = tableau[i][rhsColumn] / coefficient;
      // Bland tie-breaking is important for repeated rows and columns.
      if (ratio < bestRatio - SIMPLEX_EPS ||
          (Math.abs(ratio - bestRatio) <= SIMPLEX_EPS &&
           (leaving < 0 || basis[i] < basis[leaving]))) {
        bestRatio = ratio;
        leaving = i;
      }
    }
    if (leaving < 0) throw new Error('Positive-cover LP is unbounded');

    const pivot = tableau[leaving][entering];
    for (let j = 0; j <= rhsColumn; j++) tableau[leaving][j] /= pivot;
    for (let i = 0; i < constraints; i++) {
      if (i === leaving) continue;
      const factor = tableau[i][entering];
      if (Math.abs(factor) <= SIMPLEX_EPS) continue;
      for (let j = 0; j <= rhsColumn; j++) {
        tableau[i][j] -= factor * tableau[leaving][j];
      }
    }
    const objectiveFactor = objective[entering];
    if (Math.abs(objectiveFactor) > SIMPLEX_EPS) {
      for (let j = 0; j < rhsColumn; j++) {
        objective[j] -= objectiveFactor * tableau[leaving][j];
      }
      objective[rhsColumn] += objectiveFactor * tableau[leaving][rhsColumn];
    }
    basis[leaving] = entering;
  }
  if (!converged) throw new Error('Positive-cover LP hit its iteration limit');

  // Rebuild both sides from the final basis. Reading either objective from
  // accumulated tableau arithmetic loses digits when rows are nearly
  // duplicate; solving the original basis gives both certificates the same
  // numerical conditioning and keeps their objectives coupled.
  const basisMatrix = Array.from({length: constraints}, (_, row) =>
    basis.map(column => column < variables
      ? matrix[row][column]
      : (column === variables + row ? 1 : 0))
  );
  const basicValues = solveLinearSystem(
    basisMatrix,
    Array(constraints).fill(1)
  );
  const solution = Array(variables).fill(0);
  for (let i = 0; i < constraints; i++) {
    if (basis[i] < variables) {
      const x = basicValues[i];
      if (x < -1e-8) throw new Error('Simplex produced an infeasible basis');
      solution[basis[i]] = Math.max(0, x);
    }
  }
  const value = solution.reduce((sum, x) => sum + x, 0);
  if (!(value > SIMPLEX_EPS) || !Number.isFinite(value)) {
    throw new Error('Positive-cover LP has no usable solution');
  }
  const dual = solveLinearSystem(
    Array.from({length: constraints}, (_, row) =>
      Array.from({length: constraints}, (_, column) => basisMatrix[column][row])
    ),
    basis.map(column => column < variables ? 1 : 0)
  );
  if (dual.some(x => x < -1e-8)) throw new Error('Simplex produced an infeasible dual basis');
  return {solution, dual: dual.map(x => Math.max(0, x)), objective: value};
}

function findPureSaddle(payoff: number[][]): MatrixSolution {
  const rowMinimums = payoff.map(row => Math.min(...row));
  const columnMaximums = payoff[0].map((_, j) =>
    Math.max(...payoff.map(row => row[j]))
  );
  const lowerValue = Math.max(...rowMinimums);
  const upperValue = Math.min(...columnMaximums);

  // Use exact equality here. An almost-saddle is still sent through the LP,
  // so a tolerance can never silently turn an approximate answer into a pure
  // one.
  if (lowerValue !== upperValue) return null;
  const row = rowMinimums.indexOf(lowerValue);
  const column = columnMaximums.indexOf(upperValue);
  const p1 = Array(payoff.length).fill(0);
  const p2 = Array(payoff[0].length).fill(0);
  p1[row] = 1;
  p2[column] = 1;
  return {value: lowerValue, p1, p2};
}

function validateEquilibrium(payoff: number[][], result: MatrixSolution): void {
  const rowGuarantee = Math.min(...payoff[0].map((_, j) =>
    payoff.reduce((sum, row, i) => sum + result.p1[i] * row[j], 0)
  ));
  const columnUpper = Math.max(...payoff.map((row, i) =>
    row.reduce((sum, entry, j) => sum + entry * result.p2[j], 0)
  ));
  let scale = 0;
  for (const row of payoff) {
    for (const entry of row) scale = Math.max(scale, Math.abs(entry));
  }
  const tolerance = Math.max(1e-8 * scale, Number.MIN_VALUE);
  if (!Number.isFinite(rowGuarantee) || !Number.isFinite(columnUpper) ||
      rowGuarantee < result.value - tolerance ||
      rowGuarantee > result.value + tolerance ||
      columnUpper < result.value - tolerance ||
      columnUpper > result.value + tolerance ||
      columnUpper - rowGuarantee > 4 * tolerance) {
    throw new Error(
      `Invalid equilibrium certificate: row guarantee ${rowGuarantee}, ` +
      `column upper ${columnUpper}, value ${result.value}`
    );
  }
}

function* combinations(n: number, k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (k === 0) {
    yield prefix;
    return;
  }
  for (let i = start; i <= n - k; i++) {
    yield* combinations(n, k - 1, i + 1, [...prefix, i]);
  }
}

// A small support/vertex fallback is useful when simplex pivot comparisons
// lose a few ulps on nearly duplicate rows or columns. It is intentionally
// bounded: large games must either pass the primary LP certificate or throw,
// never return an unverified strategy.
function solveSideByEnumeration(payoff: number[][], maximizing: boolean) {
  const rows = payoff.length;
  const columns = payoff[0].length;
  const size = maximizing ? rows : columns;
  const constraints = maximizing
    ? [...Array.from({length: rows}, (_, i) => ['zero', i] as const),
       ...Array.from({length: columns}, (_, j) => ['payoff', j] as const)]
    : [...Array.from({length: columns}, (_, j) => ['zero', j] as const),
       ...Array.from({length: rows}, (_, i) => ['payoff', i] as const)];
  let best = null;
  for (const active of combinations(constraints.length, size)) {
    const equations = [Array(size).fill(1).concat(0)];
    const rhs = [1];
    for (const index of active) {
      const [type, constraint] = constraints[index];
      const equation = Array(size + 1).fill(0);
      if (type === 'zero') {
        equation[constraint] = 1;
      } else if (maximizing) {
        for (let i = 0; i < rows; i++) equation[i] = payoff[i][constraint];
        equation[rows] = -1;
      } else {
        for (let j = 0; j < columns; j++) equation[j] = payoff[constraint][j];
        equation[columns] = -1;
      }
      equations.push(equation);
      rhs.push(0);
    }
    let solution;
    try {
      solution = solveLinearSystem(equations, rhs);
    } catch {
      continue;
    }
    const strategy = solution.slice(0, size);
    const value = solution[size];
    if (!Number.isFinite(value) || strategy.some(x => !Number.isFinite(x) || x < -1e-8)) {
      continue;
    }
    const feasible = maximizing
      ? payoff[0].every((_, j) =>
        strategy.reduce((sum, p, i) => sum + p * payoff[i][j], 0) >= value - 1e-7)
      : payoff.every((row, i) =>
        strategy.reduce((sum, q, j) => sum + q * row[j], 0) <= value + 1e-7);
    if (!feasible) continue;
    if (!best || (maximizing ? value > best.value + 1e-12 : value < best.value - 1e-12)) {
      const cleaned = strategy.map(x => Math.max(0, x));
      const sum = cleaned.reduce((a, b) => a + b, 0);
      if (sum > SIMPLEX_EPS) best = {strategy: cleaned.map(x => x / sum), value};
    }
  }
  if (!best) throw new Error('Small-matrix fallback could not solve matrix');
  return best;
}

function solveByEnumeration(payoff: number[][]): MatrixSolution {
  const row = solveSideByEnumeration(payoff, true);
  const column = solveSideByEnumeration(payoff, false);
  const gap = Math.abs(row.value - column.value);
  if (gap > 1e-6) throw new Error(`Small-matrix fallback duality gap: ${row.value} vs ${column.value}`);
  const result = {
    value: (row.value + column.value) / 2,
    p1: row.strategy,
    p2: column.strategy,
  };
  validateEquilibrium(payoff, result);
  return result;
}

/** Solve a finite zero-sum matrix game. Payoffs are from player 1's perspective. */
function solveZeroSumMatrix(payoff: number[][]): MatrixSolution {
  if (!Array.isArray(payoff) || payoff.length === 0 ||
      !Array.isArray(payoff[0]) || payoff[0].length === 0) {
    throw new Error('Payoff matrix must be non-empty');
  }
  const width = payoff[0].length;
  if (!payoff.every(row => Array.isArray(row) && row.length === width &&
      row.every(Number.isFinite))) {
    throw new Error('Payoff matrix must be rectangular and finite');
  }

  const pure = findPureSaddle(payoff);
  if (pure) {
    validateEquilibrium(payoff, pure);
    return pure;
  }

  let scale = 0;
  let offset = Infinity;
  for (const row of payoff) {
    for (const entry of row) {
      scale = Math.max(scale, Math.abs(entry));
      offset = Math.min(offset, entry);
    }
  }
  const normalized = payoff.map(row => row.map(entry => entry / scale));
  const normalizedOffset = offset / scale;
  const positive = normalized.map(row =>
    row.map(entry => entry - normalizedOffset + 1)
  );

  // For positive B, max sum(y) s.t. B*y <= 1 gives p2 after normalization.
  // The final basis reconstruction in simplexPositiveCover supplies the dual
  // solution for p1 without solving a second, unrelated transposed game.
  try {
    const columnCover = simplexPositiveCover(positive);
    const p2 = normalizeStrategy(columnCover.solution);
    const p1 = normalizeStrategy(columnCover.dual);
    const columnValue = 1 / columnCover.objective;
    const rowObjective = columnCover.dual.reduce((a, b) => a + b, 0);
    const rowValue = 1 / rowObjective;
    const gap = Math.abs(columnValue - rowValue);
    if (gap > DUALITY_EPS * Math.max(1, Math.abs(columnValue), Math.abs(rowValue))) {
      throw new Error(`LP duality gap is too large: ${rowValue} vs ${columnValue}`);
    }

    const positiveValue = (columnValue + rowValue) / 2;
    const result = {
      value: scale * (positiveValue + normalizedOffset - 1),
      p1,
      p2,
    };
    validateEquilibrium(payoff, result);
    return result;
  } catch (error) {
    if (Math.max(payoff.length, width) > ENUMERATION_MAX_DIMENSION) throw error;
    // Run the bounded fallback on the normalized positive matrix. This keeps
    // its feasibility tolerances independent of the caller's payoff scale.
    const fallback = solveByEnumeration(positive);
    const result = {
      value: scale * (fallback.value + normalizedOffset - 1),
      p1: fallback.p1,
      p2: fallback.p2,
    };
    validateEquilibrium(payoff, result);
    return result;
  }
}

export {solveZeroSumMatrix};
