'use strict';

const {
  leftoversThreeHKO,
  suckerPunchAccuracyGame,
  suckerPunchBothProtectGame,
  suckerPunchBulkyTargetGame,
  suckerPunchCoverageGame,
  suckerPunchGame,
  suckerPunchOHKOTwoHKOGame,
  suckerPunchTwoHKOGame,
  trivialPriorityKO,
} = require('./cases');
const {refreshMoveRequest, setMovePP} = require('./showdown-adapter');
const {OneVsOneSolver} = require('./solver');
const {BoundedSolver} = require('./bounded-solver');
const {AsyncTransitionSolver} = require('./async-solver');
const {AsyncBoundedSolver} = require('./async-bounded-solver');
const {TransitionPool} = require('./transition-pool');

const FIXTURES = Object.freeze({
  'sucker-punch': suckerPunchGame,
  'sucker-punch-1': suckerPunchTwoHKOGame,
  'sucker-punch-2': suckerPunchAccuracyGame,
  'sucker-punch-3': suckerPunchCoverageGame,
  'sucker-punch-4': suckerPunchBulkyTargetGame,
  'sucker-punch-5': suckerPunchBothProtectGame,
  'sucker-punch-6': suckerPunchOHKOTwoHKOGame,
  leftovers: leftoversThreeHKO,
  trivial: trivialPriorityKO,
});

function fixtureNames() {
  return Object.keys(FIXTURES).join('|');
}

function usage() {
  return [
    `Usage: node src/benchmark.js [--case ${fixtureNames()}] [--pp N]`,
    '       [--solver exact|bounded] [--tolerance W] [--search-ms N]',
    '       [--selection-policy auto|joint|security]',
    '       [--workers N] [--warmup N] [--runs N] [--batch-size N]',
    '',
    'Without --workers, run synchronous solves. With --workers, keep a resident',
    'pool and run fresh async solver/memo contexts. Bounded-only flags require',
    '--solver bounded; exact remains the default solver.',
  ].join('\n');
}

function positiveInteger(value, name, allowZero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number < 1)) {
    throw new Error(`Invalid ${name} '${value}'`);
  }
  return number;
}

function nonNegativeFinite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${name} '${value}'`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {fixture: 'sucker-punch', pp: undefined, workers: undefined,
    solver: 'exact', tolerance: 0.02, toleranceSpecified: false,
    searchMs: 5000, searchMsSpecified: false,
    selectionPolicy: 'auto', selectionPolicySpecified: false,
    warmup: 0, runs: 1, batchSize: 8, help: false};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++index];
    };
    if (arg === '--case') {
      options.fixture = next();
      if (!Object.hasOwn(FIXTURES, options.fixture)) {
        throw new Error(`Unknown fixture '${options.fixture}'. Choose one of ${fixtureNames()}`);
      }
    } else if (arg === '--pp') options.pp = positiveInteger(next(), 'PP', true);
    else if (arg === '--solver') {
      options.solver = next();
      if (options.solver !== 'exact' && options.solver !== 'bounded') {
        throw new Error(`Invalid solver '${options.solver}'. Choose exact or bounded`);
      }
    } else if (arg === '--tolerance') {
      options.tolerance = nonNegativeFinite(next(), 'tolerance');
      options.toleranceSpecified = true;
    } else if (arg === '--search-ms') {
      options.searchMs = nonNegativeFinite(next(), 'search-ms');
      options.searchMsSpecified = true;
    } else if (arg === '--selection-policy') {
      options.selectionPolicy = next();
      if (!['auto', 'joint', 'security'].includes(options.selectionPolicy)) {
        throw new Error(`Invalid selection policy '${options.selectionPolicy}'. Choose auto, joint, or security`);
      }
      options.selectionPolicySpecified = true;
    }
    else if (arg === '--workers') options.workers = positiveInteger(next(), 'workers');
    else if (arg === '--warmup') options.warmup = positiveInteger(next(), 'warmup', true);
    else if (arg === '--runs') options.runs = positiveInteger(next(), 'runs');
    else if (arg === '--batch-size') options.batchSize = positiveInteger(next(), 'batch-size');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument '${arg}'`);
  }
  if (options.solver === 'exact') {
    const boundedFlags = [];
    if (options.toleranceSpecified) boundedFlags.push('--tolerance');
    if (options.searchMsSpecified) boundedFlags.push('--search-ms');
    if (options.selectionPolicySpecified) boundedFlags.push('--selection-policy');
    if (boundedFlags.length) {
      throw new Error(`${boundedFlags.join(', ')} require --solver bounded`);
    }
  }
  return options;
}

function setUniformPP(battle, pp) {
  for (const side of battle.sides) {
    const pokemon = side.active[0];
    for (const move of pokemon.moveSlots) setMovePP(battle, side.id, move.id, pp);
  }
  refreshMoveRequest(battle);
}

function makeBattle(fixture, pp) {
  const {battle} = FIXTURES[fixture]();
  if (pp !== undefined) setUniformPP(battle, pp);
  return battle;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timingSummary(samples, field) {
  const values = samples.map(sample => sample[field]).filter(value => Number.isFinite(value));
  if (!values.length) return null;
  return {minMs: Math.min(...values), medianMs: median(values), maxMs: Math.max(...values)};
}

function solverOptions(options, pool, workers) {
  const common = {pool, workerCount: workers, batchSize: options.batchSize};
  if (options.solver === 'bounded') {
    return {...common, ...boundedSolverOptions(options)};
  }
  return {...common, eager: true};
}

function boundedSolverOptions(options) {
  return {tolerance: options.tolerance, maxSearchMs: options.searchMs,
    lazyCells: false, selectionPolicy: options.selectionPolicy};
}

function backendForResult(result, requested, solverKind) {
  if (result.backend === 'sync' || result.backend === 'worker' || result.backend === 'fallback') {
    return result.backend;
  }
  if (result.backend === 'worker-async') return 'worker';
  if (result.backend === 'sync-fallback') return 'fallback';
  if (requested === 'sync') return 'sync';
  if (solverKind === 'bounded') {
    throw new Error('Bounded async solver result is missing explicit backend metadata');
  }
  // Preserve the exact solver's established fallback contract until its
  // owner adds explicit backend metadata: worker results expose both timing
  // fields, while synchronous fallback results do not.
  return Number.isFinite(result.stats?.prepareMs) && Number.isFinite(result.stats?.searchMs)
    ? 'worker' : 'fallback';
}

function boundedSample(result, totalMs, backend) {
  return {
    totalMs,
    backend,
    value: result.value,
    lowerBound: result.lowerBound,
    upperBound: result.upperBound,
    valueErrorBound: result.valueErrorBound,
    converged: result.converged,
    prepareMs: result.stats?.prepareMs ?? null,
    searchMs: result.stats?.searchMs ?? null,
    stats: result.stats,
  };
}

function exactSample(result, totalMs, backend) {
  return {
    totalMs,
    prepareMs: Number.isFinite(result.stats?.prepareMs) ? result.stats.prepareMs : null,
    searchMs: Number.isFinite(result.stats?.searchMs) ? result.stats.searchMs : null,
    backend,
    value: result.value,
    stats: result.stats,
  };
}

function boundedTiming(samples) {
  return {
    elapsed: timingSummary(samples, 'totalMs'),
    elapsedSearch: timingSummary(samples, 'searchMs'),
    prepare: timingSummary(samples, 'prepareMs'),
    convergedElapsed: timingSummary(samples.filter(sample => sample.converged), 'totalMs'),
    convergedSearch: timingSummary(samples.filter(sample => sample.converged), 'searchMs'),
  };
}

function solveAsync(pool, options, battle) {
  const Solver = options.solver === 'bounded' ? AsyncBoundedSolver : AsyncTransitionSolver;
  return new Solver(solverOptions(options, pool, options.workers)).solve(battle);
}

async function runAsync(options) {
  const poolStart = performance.now();
  const pool = new TransitionPool(options.workers, {batchSize: options.batchSize});
  try {
    await pool.ready;
    const poolReadyMs = performance.now() - poolStart;
    // Warmups use the selected fixture but are discarded. Each solve creates
    // a fresh battle, solver, memo, and PP cache, so no target answer is
    // reused as benchmark data while the target path receives realistic JIT
    // warmup.
    for (let index = 0; index < options.warmup; index++) {
      await solveAsync(pool, options, makeBattle(options.fixture, options.pp));
    }
    const samples = [];
    let result;
    for (let index = 0; index < options.runs; index++) {
      const start = performance.now();
      result = await solveAsync(pool, options, makeBattle(options.fixture, options.pp));
      const totalMs = performance.now() - start;
      const backend = backendForResult(result, 'worker', options.solver);
      samples.push(options.solver === 'bounded'
        ? boundedSample(result, totalMs, backend)
        : exactSample(result, totalMs, backend));
    }
    const backends = new Set(samples.map(sample => sample.backend));
    let mode = 'async';
    if (options.solver === 'bounded') mode = 'bounded';
    else if (backends.size === 1 && backends.has('fallback')) mode = 'sync-fallback';
    return {
      mode,
      solver: options.solver,
      ...(options.solver === 'bounded'
        ? {tolerance: options.tolerance, searchMs: options.searchMs,
          selectionPolicy: options.selectionPolicy}
        : {}),
      backendSamples: [...backends],
      fixture: options.fixture, pp: options.pp ?? 'fixture-default',
      workers: options.workers, batchSize: options.batchSize,
      warmupRuns: options.warmup, runs: options.runs, poolReadyMs,
      timing: options.solver === 'bounded'
        ? boundedTiming(samples)
        : {
          total: timingSummary(samples, 'totalMs'),
          prepare: timingSummary(samples, 'prepareMs'),
          search: timingSummary(samples, 'searchMs'),
        },
      ...(options.solver === 'bounded'
        ? {completedRuns: samples.filter(sample => sample.converged).length}
        : {}),
      samples, result, poolMetrics: pool.metrics,
    };
  } finally {
    await pool.close();
  }
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  if (options.workers !== undefined) {
    const summary = await runAsync(options);
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  const samples = [];
  let result;
  for (let index = 0; index < options.warmup; index++) {
    solveSync(options, makeBattle(options.fixture, options.pp));
  }
  for (let index = 0; index < options.runs; index++) {
    const start = performance.now();
    result = solveSync(options, makeBattle(options.fixture, options.pp));
    const totalMs = performance.now() - start;
    samples.push(options.solver === 'bounded'
      ? boundedSample(result, totalMs, 'sync')
      : exactSample(result, totalMs, 'sync'));
  }
  const summary = {
    mode: options.solver === 'bounded' ? 'bounded' : 'sync',
    solver: options.solver,
    ...(options.solver === 'bounded'
      ? {tolerance: options.tolerance, searchMs: options.searchMs,
        selectionPolicy: options.selectionPolicy}
      : {}),
    backendSamples: ['sync'],
    fixture: options.fixture, pp: options.pp ?? 'fixture-default',
    warmupRuns: options.warmup, runs: options.runs,
    ...(options.solver === 'bounded'
      ? {completedRuns: samples.filter(sample => sample.converged).length,
        timing: boundedTiming(samples)}
      : {timing: timingSummary(samples, 'totalMs')}),
    result, samples,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function solveSync(options, battle) {
  const Solver = options.solver === 'bounded' ? BoundedSolver : OneVsOneSolver;
  const optionsForSolver = options.solver === 'bounded'
    ? boundedSolverOptions(options) : {};
  return new Solver(optionsForSolver).solve(battle);
}

if (require.main === module) {
  run().catch(error => {
    console.error(`benchmark: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  });
}

module.exports = {run, parseArgs, timingSummary, backendForResult};
