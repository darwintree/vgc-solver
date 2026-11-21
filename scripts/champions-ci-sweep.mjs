import {fork} from 'node:child_process';
import {appendFileSync, writeFileSync} from 'node:fs';
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
const strictGate = args.get('strict') === 'true';
const outputPath = args.get('output') ?? 'champions-ci-results.jsonl';
const benchFile = resolve('dist/src/champions-benchmark.js');

const HISTORICAL_4 = new Set(['garchomp', 'primarina', 'archaludon', 'mimikyu']);
const all = championsCases();
let selected;
if (scope === 'historical-54') {
  selected = all.filter(c => c.skipReasons.length === 0 && HISTORICAL_4.has(c.p1.id) && HISTORICAL_4.has(c.p2.id));
} else if (scope === 'all-playable') {
  selected = all.filter(c => c.skipReasons.length === 0);
} else {
  selected = all.filter(c => c.id === scope && c.skipReasons.length === 0);
}

if (selected.length === 0) {
  console.error(`No playable fixtures matched scope="${scope}".`);
  process.exit(2);
}

writeFileSync(outputPath, JSON.stringify({
  type: 'metadata',
  scope,
  total: selected.length,
  startedAt: new Date().toISOString(),
  node: process.version,
}) + '\n');

let within = 0;
let notWithin = 0;
let errors = 0;
let watchdogs = 0;
let sumPrepare = 0;
let sumSearch = 0;
let sumTotal = 0;
const rows = [];

for (let i = 0; i < selected.length; i++) {
  const fixture = selected[i];
  const res = await new Promise(resolvePromise => {
    const child = fork(benchFile, ['--child', fixture.id], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    let msg = null;
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('message', m => { msg = m; });
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      resolvePromise(msg ?? {status: sig === 'SIGKILL' ? 'watchdog' : 'error', code, signal: sig, error: stderr});
    });
  });

  const entry = {
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
  rows.push(entry);

  if (res.status === 'within-budget') {
    within++;
    sumPrepare += res.prepareMs ?? 0;
    sumSearch += res.searchMs ?? 0;
    sumTotal += res.totalMs ?? 0;
  } else if (res.status === 'not-within-budget') {
    notWithin++;
  } else if (res.status === 'watchdog') {
    watchdogs++;
  } else {
    errors++;
  }
  console.log(`[${i + 1}/${selected.length}] ${fixture.id}: ${res.status} (search=${res.searchMs != null ? res.searchMs.toFixed(1) + 'ms' : 'n/a'})`);
}

const slowest = rows
  .filter(r => typeof r.searchMs === 'number')
  .sort((a, b) => b.searchMs - a.searchMs)
  .slice(0, 10);

const summaryLines = [
  `## Champions Singles Sweep (\`${scope}\`)`,
  '',
  `- **Total**: ${selected.length} | **Within budget (10s, tol=0.02)**: ${within} | **Not within budget**: ${notWithin} | **Errors**: ${errors} | **Watchdogs**: ${watchdogs}`,
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
