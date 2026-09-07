import assert from 'node:assert/strict';
import test from 'node:test';
import {solveZeroSumMatrix} from '../src/matrix-game';
import {solveZeroSumMatrixOracle} from './matrix-game.oracle';

function rng(seed) {
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function makeMatrix(rows, columns, random) {
  return Array.from({length: rows}, () =>
    Array.from({length: columns}, () => Math.floor(random() * 21) - 10)
  );
}

function assertStrategy(strategy) {
  assert.equal(strategy.length > 0, true);
  assert.ok(strategy.every(x => x >= -1e-10 && x <= 1 + 1e-10));
  assert.ok(Math.abs(strategy.reduce((a, b) => a + b, 0) - 1) < 1e-8);
}

function assertEquilibrium(payoff, result) {
  assertStrategy(result.p1);
  assertStrategy(result.p2);
  const magnitude = Math.max(...payoff.flat().map(Math.abs));
  const tolerance = 1e-7 * magnitude;
  const rowGuarantee = Math.min(...payoff[0].map((_, j) =>
    payoff.reduce((sum, row, i) => sum + result.p1[i] * row[j], 0)
  ));
  const columnUpper = Math.max(...payoff.map((row, i) =>
    row.reduce((sum, entry, j) => sum + entry * result.p2[j], 0)
  ));
  assert.ok(rowGuarantee >= result.value - tolerance,
    `row guarantee ${rowGuarantee} below ${result.value}`);
  assert.ok(columnUpper <= result.value + tolerance,
    `column upper ${columnUpper} above ${result.value}`);
  assert.ok(columnUpper - rowGuarantee <= 3 * tolerance);
}

test('matches the vertex-enumeration oracle on random rectangular games', () => {
  const random = rng(0xdecafbad);
  for (let k = 0; k < 40; k++) {
    const rows = 2 + (k % 4);
    const columns = 2 + ((k * 3) % 4);
    const payoff = makeMatrix(rows, columns, random);
    const expected = solveZeroSumMatrixOracle(payoff);
    const actual = solveZeroSumMatrix(payoff);
    assert.ok(Math.abs(actual.value - expected.value) < 1e-7,
      `${rows}x${columns}: ${actual.value} != ${expected.value}`);
    assertEquilibrium(payoff, actual);
  }
});

test('handles duplicate rows and columns, rectangles, and negative payoffs', () => {
  const cases = [
    [[-4, -1, -4], [-4, -1, -4], [-2, -3, -2]],
    [[-9, -8, -7], [-6, -5, -4]],
    [[-9], [-6], [-8]],
    [[-5, -5], [-5, -5]],
    [[-1, 1], [1, -1]],
  ];
  for (const payoff of cases) {
    const actual = solveZeroSumMatrix(payoff);
    const expected = solveZeroSumMatrixOracle(payoff);
    assert.ok(Math.abs(actual.value - expected.value) < 1e-7);
    assertEquilibrium(payoff, actual);
  }
});

test('remains stable when two rows differ only at 1e-10 scale', () => {
  const payoff = [
    [0.5602373080328107, -0.5227107401005924, -0.6225299928337336, -0.2641856246627867],
    [0.5602373080616498, -0.5227107401355919, -0.6225299928237066, -0.2641856247094422],
    [-0.8768119728192687, -0.9769210475496948, 0.9654632899910212, 0.25490825017914176],
    [-0.3727346183732152, 0.3814882696606219, -0.7658072076737881, -0.7702172663994133],
  ];
  const expected = solveZeroSumMatrixOracle(payoff);
  const actual = solveZeroSumMatrix(payoff);
  assert.ok(Math.abs(actual.value - expected.value) < 1e-10);
  assertEquilibrium(payoff, actual);
});

test('rebuilds a valid equilibrium for a near-duplicate row at machine precision', () => {
  const payoff = [
    [0.6254089353606105, -0.7197329341433942, -0.9900690875947475, -0.2758927014656365],
    [0.625408937995391, -0.7197329337165546, -0.990069089953012, -0.2758926991889594],
    [-0.0143562788143754, 0.08714244747534394, -0.7454801574349403, 0.11308155162259936],
    [-0.45814944710582495, -0.7363078775815666, -0.3977955114096403, -0.10149318585172296],
  ];
  const expected = solveZeroSumMatrixOracle(payoff);
  const actual = solveZeroSumMatrix(payoff);
  assert.ok(Math.abs(actual.value - expected.value) < 1e-10);
  assertEquilibrium(payoff, actual);
});

test('handles near-duplicate rows and columns across scales', () => {
  const random = rng(0x51ced); // deterministic, including values near zero
  for (const factor of [1e-12, 1, 1e12]) {
    for (const epsilon of [1e-8, 1e-12, 1e-14]) {
      const base = Array.from({length: 4}, () =>
        Array.from({length: 4}, () => (Math.floor(random() * 2001) - 1000) / 1000)
      );
      base[1] = base[0].map(value => value + epsilon * (random() - 0.5));
      for (let row = 0; row < base.length; row++) {
        base[row][1] = base[row][0] + epsilon * (random() - 0.5);
      }
      const expected = solveZeroSumMatrixOracle(base);
      const payoff = base.map(row => row.map(value => value * factor));
      const actual = solveZeroSumMatrix(payoff);
      assert.ok(Math.abs(actual.value / factor - expected.value) < 1e-7);
      assertEquilibrium(payoff, actual);
    }
  }
});

test('keeps precision across large and small finite magnitudes', () => {
  for (const factor of [1e12, 1e-12]) {
    const base = [[-1, 1], [1, -1]];
    const payoff = base.map(row => row.map(x => x * factor));
    const result = solveZeroSumMatrix(payoff);
    assert.ok(Math.abs(result.value) < factor * 1e-8);
    assertEquilibrium(payoff, result);
  }
});

test('solves a 20x30 game without support enumeration', () => {
  const payoff = makeMatrix(20, 30, rng(12345));
  const started = performance.now();
  const result = solveZeroSumMatrix(payoff);
  const elapsed = performance.now() - started;
  assertEquilibrium(payoff, result);
  assert.ok(elapsed < 1000, `20x30 solve took ${elapsed.toFixed(1)}ms`);
});
