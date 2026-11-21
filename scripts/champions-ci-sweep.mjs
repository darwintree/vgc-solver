import {fork} from 'node:child_process';
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {championsCases} = require('../dist/src/champions-cases.js');

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    const [k, v] = arg.slice(2).split('=');
    args.set(k, v ?? 'true');
  }
}

const scope = args.get('scope') ?? 'historical-54';
const snapshotId = args.get('snapshot') === '2026-11' ? '2026-11' : '2026-09';
const strictGate = args.get('strict') === 'true';
const resume = args.get('resume') === 'true';
const failedFrom = args.get('failed-from') ?? null;
const searchMsArg = args.get('search-ms') ? Number(args.get('search-ms')) : 10000;
const searchBudgetMs = Number.isFinite(searchMsArg) && searchMsArg > 0 ? searchMsArg : 10000;
const shardSpec = args.get('shard') ?? null;
const outputPath = args.get('output') ?? 'champions-ci-results.jsonl';
const benchFile = resolve('dist/src/champions-benchmark.js');

const HISTORICAL_4 = new Set(['garchomp', 'primarina', 'archaludon', 'mimikyu']);
const all = championsCases(snapshotId);
let selected;
if (failedFrom) {
  const failedIds = new Set();
  for (const line of readFileSync(failedFrom, 'utf8').trim().split('\n')) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type === 'metadata') continue;
    if (obj.id && obj.status !== 'within-budget') failedIds.add(obj.id);
  }
  selected = all.filter(c => c.skipReasons.length === 0 && failedIds.has(c.id));
} else if (scope === 'historical-54') {
  selected = all.filter(c => c.skipReasons.length === 0 && HISTORICAL_4.has(c.p1.id) && HISTORICAL_4.has(c.p2.id));
} else if (scope === 'all-playable') {
  selected = all.filter(c => c.skipReasons.length === 0);
} else {
  selected = all.filter(c => c.id === scope && c.skipReasons.length === 0);
}

if (shardSpec) {
  const [idxStr, totalStr] = shardSpec.split('/');
  const shardIdx = Number(idxStr);
  const shardTotal = Number(totalStr);
  if (!Number.isInteger(shardIdx) || !Number.isInteger(shardTotal) || shardIdx < 1 || shardIdx > shardTotal) {
    console.error(`Invalid --shard=${shardSpec}; expected <1..N>/<N>.`);
    process.exit(2);
  }
  selected = selected.filter((_, idx) => (idx % shardTotal) === (shardIdx - 1));
}

if (selected.length === 0) {
  console.error(`No playable fixtures matched scope="${scope}" snapshot="${snapshotId}".`);
  process.exit(2);
}

const existingById = new Map();
if (resume && existsSync(outputPath)) {
  const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type === 'metadata') continue;
    if (obj.id) existingById.set(obj.id, obj);
  }
} else {
  writeFileSync(outputPath, JSON.stringify({
    type: 'metadata',
    scope: failedFrom ? `failed-from:${failedFrom}` : scope,
    snapshotId,
    searchBudgetMs,
    shard: shardSpec,
    total: selected.length,
    startedAt: new Date().toISOString(),
    node: process.version,
  }) + '\n');
}

let within = 0;
let notWithin = 0;
let errors = 0;
let watchdogs = 0;
let sumPrepare = 0;
let sumSearch = 0;
let sumTotal = 0;
const rows = [];
const watchdogMs = Math.max(15000, searchBudgetMs * 3);

for (let i = 0; i < selected.length; i++) {
  const fixture = selected[i];
  let entry = existingById.get(fixture.id);
  if (!entry) {
    const res = await new Promise(resolvePromise => {
      const child = fork(
        benchFile,
        ['--child', fixture.id, 'auto', snapshotId, String(searchBudgetMs)],
        {stdio: ['ignore', 'ignore', 'pipe', 'ipc']}
      );
      let stderr = '';
      let msg = null;
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      const timer = setTimeout(() => child.kill('SIGKILL'), watchdogMs);
      child.on('message', m => { msg = m; });
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        resolvePromise(msg ?? {status: sig === 'SIGKILL' ? 'watchdog' : 'error', code, signal: sig, error: stderr});
      });
    });

    entry = {
      id: fixture.id,
      status: res.status,
      engine: res.engine ?? null,
      prepareMs: res.prepareMs ?? null,
      searchMs: res.searchMs ?? null,
      totalMs: res.totalMs ?? null,
      lowerBound: res.lowerBound ?? null,
      upperBound: res.upperBound ?? null,
      error: res.error ? String(res.error).split('\n')[0] : undefined,
    };
    appendFileSync(outputPath, JSON.stringify(entry) + '\n');
    console.log(`[${i + 1}/${selected.length}] ${fixture.id}: ${entry.status} (search=${entry.searchMs != null ? entry.searchMs.toFixed(1) + 'ms' : 'n/a'})`);
  }
  rows.push(entry);

  if (entry.status === 'within-budget') {
    within++;
    sumPrepare += entry.prepareMs ?? 0;
    sumSearch += entry.searchMs ?? 0;
    sumTotal += entry.totalMs ?? 0;
  } else if (entry.status === 'not-within-budget') {
    notWithin++;
  } else if (entry.status === 'watchdog') {
    watchdogs++;
  } else {
    errors++;
  }
}

const slowest = rows
  .filter(r => typeof r.searchMs === 'number')
  .sort((a, b) => b.searchMs - a.searchMs)
  .slice(0, 10);

const summaryLines = [
  `## Champions Singles Sweep (\`${failedFrom ? `failed-from:${failedFrom}` : scope}\`, snapshot \`${snapshotId}\`, budget \`${searchBudgetMs}ms\`)`,
  '',
  `- **Total**: ${selected.length} | **Within budget (${searchBudgetMs}ms, tol=0.02)**: ${within} | **Not within budget**: ${notWithin} | **Errors**: ${errors} | **Watchdogs**: ${watchdogs}`,
  `- **Converged Totals**: prepare \`${sumPrepare.toFixed(1)} ms\`, search \`${sumSearch.toFixed(1)} ms\`, total \`${sumTotal.toFixed(1)} ms\``,
  '',
  '### Top 10 Slowest',
  '| Case | Status | Engine | Prepare (ms) | Search (ms) | Total (ms) | Interval |',
  '| --- | --- | --- | ---: | ---: | ---: | --- |',
  ...slowest.map(r =>
    `| \`${r.id}\` | ${r.status} | ${r.engine ?? '-'} | ${r.prepareMs?.toFixed(1) ?? '-'} | ${r.searchMs?.toFixed(1) ?? '-'} | ${r.totalMs?.toFixed(1) ?? '-'} | ${r.lowerBound != null ? `[${r.lowerBound.toFixed(4)}, ${r.upperBound.toFixed(4)}]` : '-'} |`
  ),
  '',
];

const summaryMd = summaryLines.join('\n');
console.log('\n' + summaryMd);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd + '\n');
}

if (errors > 0 || watchdogs > 0) {
  console.error(`Sweep failed: errors=${errors}, watchdogs=${watchdogs}`);
  process.exit(1);
}
if (strictGate && within < selected.length) {
  console.error(`Strict convergence gate failed: ${within}/${selected.length} within budget.`);
  process.exit(1);
}
