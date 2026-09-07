import {execFileSync, fork} from 'node:child_process';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {cpus, platform, release} from 'node:os';
import {BoundedSolver} from './bounded-solver';
import {championsCases, createChampionsBattle, snapshot} from './champions-cases';

async function measure(fixture) {
  return new Promise<any>(resolve => {
    const child = fork(__filename, ['--child', fixture.id], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    let result;
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    // An individual native transition cannot be interrupted by the bounded deadline.
    // A process watchdog prevents one pathological case from blocking the sweep.
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
  const args = process.argv.slice(2);
  const all = championsCases();
  if (args[0] === '--child') {
    const fixture = all.find(c => c.id === args[1]);
    try {
      const start = performance.now();
      const battle = createChampionsBattle(fixture);
      const fixtureMs = performance.now() - start;
      const input = battle.sides.map(side => ({species: side.active[0].species.name,
        hp: side.active[0].hp, maxhp: side.active[0].maxhp,
        pp: side.active[0].moveSlots.map(m => ({id: m.id, pp: m.pp, maxpp: m.maxpp}))}));
      const result = new BoundedSolver({tolerance: 0.02, maxSearchMs: 10000,
        lazyCells: false, selectionPolicy: 'auto'}).solve(battle);
      process.send!({status: result.converged && result.stats.searchMs <= 10000
        ? 'within-budget' : 'not-within-budget', converged: result.converged,
        backend: 'sync', fixtureMs, prepareMs: result.stats.prepareMs,
        searchMs: result.stats.searchMs, totalMs: performance.now() - start,
        lowerBound: result.lowerBound, upperBound: result.upperBound,
        input, result});
    } catch (error) {
      process.send!({status: 'error', error: error.stack});
    }
    process.disconnect();
    return;
  }
  if (args.length > 1 || args[0]?.startsWith('--')) throw new Error('Usage: node dist/src/champions-benchmark.js [case-id]');
  const cases = args.length ? all.filter(c => c.id === args[0]) : all;
  if (!cases.length) throw new Error(`Unknown case ${args[0]}`);
  const output = args.length ? 'champions-single.jsonl' : 'champions-results.jsonl';
  writeFileSync(output, JSON.stringify({type: 'metadata', startedAt: new Date().toISOString(),
    command: process.argv.join(' '), gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    node: process.version, simulator: JSON.parse(readFileSync('node_modules/@pkmn/sim/package.json', 'utf8')).version,
    platform: platform(), release: release(), cpu: cpus()[0]?.model,
    workers: 0, backend: 'sync', warmupRuns: 0, runs: 1, freshProcessPerCase: true,
    searchBudgetMs: 10000, watchdogMs: 30000, tolerance: 0.02, lazyCells: false,
    pp: 'native maximum (including PP Ups)', dataVersion: snapshot.dataVersion,
    sourceGeneratedAt: snapshot.generatedAt}) + '\n');
  for (const [index, fixture] of cases.entries()) {
    const sample = fixture.skipReasons.length ? {status: 'skipped', reasons: fixture.skipReasons}
      : await measure(fixture);
    appendFileSync(output, JSON.stringify({id: fixture.id, ...sample}) + '\n');
    console.log(`${index + 1}/${cases.length} ${fixture.id}: ${sample.status}`);
  }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
