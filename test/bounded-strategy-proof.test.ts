import assert from 'node:assert/strict';
import test from 'node:test';
import {BoundedSolver} from '../src/bounded-solver';
import {solveZeroSumMatrixOracle} from './matrix-game.oracle';

type Outcome = {probability: number} &
  ({utility: number; snapshot?: never} | {snapshot: string; utility?: never});

function adapter(spec: {
  actions: Record<string, string[]>;
  replies: Record<string, string[]>;
  transitions: Record<string, Outcome | Outcome[]>;
  terminals?: Record<string, number>;
}) {
  return {
    snapshotBattle: state => state,
    restoreBattle: state => state,
    stateKey: state => String(state),
    terminalUtility: state => spec.terminals?.[state] ?? null,
    legalActions: (state, side) => (side === 0 ? spec.actions[state] : spec.replies[state]) || ['finish'],
    enumerateTurn: (state, p1, p2) => ({
      outcomes: (Array.isArray(spec.transitions[`${state}:${p1}:${p2}`])
        ? spec.transitions[`${state}:${p1}:${p2}`]
        : [spec.transitions[`${state}:${p1}:${p2}`]]) as Outcome[],
    }),
  };
}

const snap = (state: string, probability = 1): Outcome => ({snapshot: state, probability});
const win = (probability = 1): Outcome => ({utility: 1, probability});
const lose = (probability = 1): Outcome => ({utility: -1, probability});
const score = (utility: number): Outcome => ({utility, probability: 1});

function solve(spec, options = {}) {
  return new BoundedSolver({adapter: adapter(spec) as any, tolerance: 0.02, ...options}).solve('root');
}

function exactDAG(spec, state = 'root', memo = new Map<string, number>()): number {
  if (spec.terminals?.[state] !== undefined) return spec.terminals[state];
  if (memo.has(state)) return memo.get(state)!;
  const rows = spec.actions[state].map(p1 => spec.replies[state].map(p2 => {
    const outcomes = Array.isArray(spec.transitions[`${state}:${p1}:${p2}`])
      ? spec.transitions[`${state}:${p1}:${p2}`]
      : [spec.transitions[`${state}:${p1}:${p2}`]];
    return outcomes.reduce((sum, outcome) => sum + outcome.probability *
      (outcome.utility ?? exactDAG(spec, outcome.snapshot!, memo)), 0);
  }));
  const value = solveZeroSumMatrixOracle(rows).value;
  memo.set(state, value);
  return value;
}

function assertCertificate(result, expected: number) {
  assert.ok(result.lowerBound <= expected + 1e-8);
  assert.ok(result.upperBound >= expected - 1e-8);
  assert.ok(result.upperBound - result.lowerBound <= 0.02 + 1e-8);
}

function chainSpec(finalUtility: number) {
  const actions: Record<string, string[]> = {};
  const replies: Record<string, string[]> = {};
  const transitions: Record<string, Outcome | Outcome[]> = {};
  for (let depth = 0; depth < 32; depth++) {
    const state = depth === 0 ? 'root' : `s${depth}`;
    const next = `s${depth + 1}`;
    actions[state] = ['decoy', 'advance'];
    replies[state] = ['left', 'right'];
    for (const reply of replies[state]) {
      transitions[`${state}:decoy:${reply}`] = lose();
      transitions[`${state}:advance:${reply}`] = [
        {utility: finalUtility, probability: 0.001},
        snap(next, 0.999),
      ];
    }
  }
  actions.s32 = ['finish']; replies.s32 = ['finish'];
  transitions['s32:finish:finish'] = score(finalUtility);
  return {actions, replies, transitions};
}

test('default API reaches a 32-level stochastic policy with non-first actions', () => {
  const spec = chainSpec(1);
  const result = solve(spec, {warmStartRoot: true});
  assert.equal(result.converged, true);
  assertCertificate(result, exactDAG(spec));
});

test('lazy=false proves the mirrored 32-level negative chain', () => {
  const spec = chainSpec(-1);
  const result = solve(spec, {lazyCells: false, warmStartRoot: true});
  assert.equal(result.converged, true);
  assertCertificate(result, exactDAG(spec));
});

test('symmetric negative utility reaches the upper-proof endpoint', () => {
  const spec = {
    actions: {root: ['a', 'b']}, replies: {root: ['x', 'y']},
    transitions: {
      'root:a:x': lose(), 'root:a:y': lose(),
      'root:b:x': lose(), 'root:b:y': lose(),
    },
  };
  const result = solve(spec, {lazyCells: false});
  assert.equal(result.converged, true);
  assert.ok(result.lowerBound <= -1 + 1e-9);
  assert.ok(result.upperBound >= -1 - 1e-9);
  assert.equal(exactDAG(spec), -1);
});

test('every adversarial response is covered, including a rare refutation', () => {
  const spec = {
    actions: {root: ['decoy', 'candidate']}, replies: {root: ['common', 'rare']},
    transitions: {
      'root:decoy:common': lose(), 'root:decoy:rare': lose(),
      'root:candidate:common': win(),
      'root:candidate:rare': [win(0.999), lose(0.001)],
    },
  };
  const result = solve(spec, {lazyCells: false});
  assert.equal(result.converged, true);
  assert.ok(result.lowerBound <= 0.998 + 1e-9);
  assert.ok(result.upperBound >= 0.998 - 1e-9);
  assert.ok(Math.abs(exactDAG(spec) - 0.998) <= 1e-9);
});

test('shared descendants retain the exact DAG certificate', () => {
  const spec = {
    actions: {root: ['r0', 'r1'], shared: ['good', 'bad']},
    replies: {root: ['c0', 'c1'], shared: ['c0', 'c1']},
    transitions: {
      'root:r0:c0': snap('shared'), 'root:r0:c1': snap('shared'),
      'root:r1:c0': snap('shared'), 'root:r1:c1': snap('shared'),
      'shared:good:c0': score(0.6), 'shared:good:c1': score(0.6),
      'shared:bad:c0': score(-0.6), 'shared:bad:c1': score(-0.6),
    },
  };
  const result = solve(spec, {lazyCells: false});
  assert.equal(result.converged, true);
  assert.ok(result.lowerBound <= 0.6 + 1e-9);
  assert.ok(result.upperBound >= 0.6 - 1e-9);
  assert.equal(exactDAG(spec), 0.6);
});

test('a pure cycle stays unknown, while a useful alternate row can certify around it', () => {
  const cycle = {
    actions: {root: ['cycle']}, replies: {root: ['x']},
    transitions: {'root:cycle:x': snap('root')},
  };
  const unresolved = solve(cycle, {lazyCells: false, tolerance: 0});
  assert.equal(unresolved.converged, false);
  assert.equal(unresolved.lowerBound, -1);
  assert.equal(unresolved.upperBound, 1);

  const alternate = {
    actions: {root: ['cycle', 'useful']}, replies: {root: ['x', 'y']},
    transitions: {
      'root:cycle:x': lose(), 'root:cycle:y': snap('root'),
      'root:useful:x': win(), 'root:useful:y': win(),
    },
  };
  const certified = solve(alternate, {lazyCells: false});
  assert.equal(certified.converged, true);
  assert.ok(certified.lowerBound >= 1 - 1e-9);
  assert.ok(certified.upperBound <= 1 + 1e-9);
});
