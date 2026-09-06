'use strict';

const {leftoversThreeHKO, suckerPunchGame, trivialPriorityKO} = require('./cases');
const {refreshMoveRequest, setMovePP} = require('./showdown-adapter');
const {OneVsOneSolver} = require('./solver');
const {AsyncTransitionSolver} = require('./async-solver');
const {TransitionPool} = require('./transition-pool');

const FIXTURES = Object.freeze({
  'sucker-punch': suckerPunchGame,
  leftovers: leftoversThreeHKO,
  trivial: trivialPriorityKO,
});

function usage() {
  return [
    'Usage: node src/benchmark.js [--case sucker-punch|leftovers|trivial] [--pp N]',
    '       [--workers N] [--warmup N] [--runs N] [--batch-size N]',
    '',
    'Without --workers, run synchronous solves. With --workers, keep a resident',
    'pool and run fresh async solver/memo contexts.',
  ].join('\n');
}

function positiveInteger(value, name, allowZero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number < 1)) {
    throw new Error(`Invalid ${name} '${value}'`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {fixture: 'sucker-punch', pp: undefined, workers: undefined,
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
        throw new Error(`Unknown fixture '${options.fixture}'. Choose one of sucker-punch, leftovers, trivial`);
      }
    } else if (arg === '--pp') options.pp = positiveInteger(next(), 'PP', true);
    else if (arg === '--workers') options.workers = positiveInteger(next(), 'workers');
    else if (arg === '--warmup') options.warmup = positiveInteger(next(), 'warmup', true);
    else if (arg === '--runs') options.runs = positiveInteger(next(), 'runs');
    else if (arg === '--batch-size') options.batchSize = positiveInteger(next(), 'batch-size');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument '${arg}'`);
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

function solveAsync(pool, workers, batchSize, battle) {
  return new AsyncTransitionSolver({pool, workerCount: workers,
    eager: true, batchSize}).solve(battle);
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
      await solveAsync(pool, options.workers, options.batchSize,
        makeBattle(options.fixture, options.pp));
    }
    const samples = [];
    let result;
    for (let index = 0; index < options.runs; index++) {
      const start = performance.now();
      result = await solveAsync(pool, options.workers, options.batchSize,
        makeBattle(options.fixture, options.pp));
      const fallback = !Number.isFinite(result.stats?.prepareMs) ||
        !Number.isFinite(result.stats?.searchMs);
      samples.push({totalMs: performance.now() - start,
        prepareMs: fallback ? null : result.stats.prepareMs,
        searchMs: fallback ? null : result.stats.searchMs,
        backend: fallback ? 'sync-fallback' : 'worker-async',
        value: result.value, stats: result.stats});
    }
    const backends = new Set(samples.map(sample => sample.backend));
    return {
      mode: backends.size === 1 && backends.has('sync-fallback') ? 'sync-fallback' : 'async',
      backendSamples: [...backends],
      fixture: options.fixture, pp: options.pp ?? 'fixture-default',
      workers: options.workers, batchSize: options.batchSize,
      warmupRuns: options.warmup, runs: options.runs, poolReadyMs,
      timing: {
        total: timingSummary(samples, 'totalMs'),
        prepare: timingSummary(samples, 'prepareMs'),
        search: timingSummary(samples, 'searchMs'),
      },
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
    new OneVsOneSolver().solve(makeBattle(options.fixture, options.pp));
  }
  for (let index = 0; index < options.runs; index++) {
    const start = performance.now();
    result = new OneVsOneSolver().solve(makeBattle(options.fixture, options.pp));
    samples.push({totalMs: performance.now() - start, value: result.value, stats: result.stats});
  }
  const summary = {mode: 'sync', fixture: options.fixture, pp: options.pp ?? 'fixture-default',
    warmupRuns: options.warmup, runs: options.runs, timing: timingSummary(samples, 'totalMs'), result, samples};
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  run().catch(error => {
    console.error(`benchmark: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  });
}

module.exports = {run, parseArgs, timingSummary};
