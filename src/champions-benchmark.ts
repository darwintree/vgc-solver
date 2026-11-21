import {execFileSync, fork} from 'node:child_process';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {cpus, platform, release} from 'node:os';
import {BoundedSolver} from './bounded-solver';
import {
  championsCases,
  championsSnapshots,
  createChampionsBattle,
  type ChampionsSnapshotId,
} from './champions-cases';

async function measure(fixture, snapshotId: ChampionsSnapshotId) {
  return new Promise<any>(resolve => {
    const child = fork(__filename, ['--child', fixture.id, 'auto', snapshotId], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    let result;
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    // Native transitions observe the bounded deadline at cooperative random
    // branch boundaries; a currently executing simulator call is not preempted.
    // A process watchdog still prevents one pathological case from blocking the sweep.
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('message', message => { result = message; });
    child.on('error', error => { result = {status: 'error', error: error.message}; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(result ?? {status: signal === 'SIGKILL' ? 'watchdog' : 'error',
        code, signal, error: stderr, prepareMs: null, searchMs: null, totalMs: null});
    });
  });
}

async function run() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === '--child') {
    const snapshotId: ChampionsSnapshotId = rawArgs[3] === '2026-11' ? '2026-11' : '2026-09';
    const all = championsCases(snapshotId);
    const fixture = all.find(c => c.id === rawArgs[1]);
    try {
      const start = performance.now();
      const battle = createChampionsBattle(fixture);
      const fixtureMs = performance.now() - start;
      const input = battle.sides.map(side => ({species: side.active[0].species.name,
        hp: side.active[0].hp, maxhp: side.active[0].maxhp,
        pp: side.active[0].moveSlots.map(m => ({id: m.id, pp: m.pp, maxpp: m.maxpp}))}));
      const engineOpt = (rawArgs[2] === 'showdown' || rawArgs[2] === 'compact' ? rawArgs[2] : 'auto') as 'auto' | 'compact' | 'showdown';
      const parsedMs = rawArgs[4] ? Number(rawArgs[4]) : 10000;
      const searchBudgetMs = Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs : 10000;
      const result = new BoundedSolver({tolerance: 0.02, maxSearchMs: searchBudgetMs,
        lazyCells: false, selectionPolicy: 'auto', engine: engineOpt}).solve(battle);
      process.send!({status: result.converged && result.stats.searchMs <= searchBudgetMs
        ? 'within-budget' : 'not-within-budget', converged: result.converged,
        backend: 'sync', engine: result.engine ?? 'showdown', snapshotId, searchBudgetMs, fixtureMs, prepareMs: result.stats.prepareMs,
        searchMs: result.stats.searchMs, totalMs: performance.now() - start,
        lowerBound: result.lowerBound, upperBound: result.upperBound,
        input, result});
    } catch (error) {
      process.send!({status: 'error', error: error.stack});
    }
    process.disconnect();
    return;
  }

  let snapshotId: ChampionsSnapshotId = '2026-09';
  const positional: string[] = [];
  for (const arg of rawArgs) {
    if (arg.startsWith('--snapshot=')) {
      const val = arg.slice('--snapshot='.length);
      if (val !== '2026-09' && val !== '2026-11') throw new Error(`Unknown snapshot ${val}`);
      snapshotId = val;
    } else if (arg.startsWith('--')) {
      throw new Error('Usage: node dist/src/champions-benchmark.js [--snapshot=2026-09|2026-11] [case-id]');
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error('Usage: node dist/src/champions-benchmark.js [--snapshot=2026-09|2026-11] [case-id]');

  const all = championsCases(snapshotId);
  const snapMeta = championsSnapshots[snapshotId].snapshot;
  const cases = positional.length ? all.filter(c => c.id === positional[0]) : all;
  if (!cases.length) throw new Error(`Unknown case ${positional[0]}`);
  const output = positional.length ? 'champions-single.jsonl' : 'champions-results.jsonl';
  writeFileSync(output, JSON.stringify({type: 'metadata', startedAt: new Date().toISOString(),
    command: process.argv.join(' '), gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    node: process.version, simulator: JSON.parse(readFileSync('node_modules/@pkmn/sim/package.json', 'utf8')).version,
    platform: platform(), release: release(), cpu: cpus()[0]?.model,
    workers: 0, backend: 'sync', engine: 'auto', snapshotId, warmupRuns: 0, runs: 1, freshProcessPerCase: true,
    searchBudgetMs: 10000, watchdogMs: 30000, tolerance: 0.02, lazyCells: false,
    pp: 'native maximum (including PP Ups)', dataVersion: snapMeta.dataVersion,
    sourceGeneratedAt: snapMeta.generatedAt}) + '\n');
  for (const [index, fixture] of cases.entries()) {
    const sample = fixture.skipReasons.length ? {status: 'skipped', reasons: fixture.skipReasons}
      : await measure(fixture, snapshotId);
    appendFileSync(output, JSON.stringify({id: fixture.id, ...sample}) + '\n');
    console.log(`${index + 1}/${cases.length} ${fixture.id}: ${sample.status}`);
  }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
