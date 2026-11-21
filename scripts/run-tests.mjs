import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const shard = process.argv[2] ?? 'all';
const testDir = 'dist/test';

const allFiles = readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

const isAsync = f => f.startsWith('async-');
const isEngineCore = f =>
  !isAsync(f) && (
    f.startsWith('engine-') ||
    f === 'monotone-bounds.test.js' ||
    f === 'champions-cases.test.js' ||
    f.startsWith('matrix-game') ||
    f === 'bounded-solver.test.js' ||
    f === 'bounded-stochastic.test.js' ||
    f === 'bounded-strategy-proof.test.js' ||
    f === 'asymmetric-pruning.test.js' ||
    f.startsWith('solver') ||
    f === 'branching-prng.test.js' ||
    f === 'types.test.js'
  );

let selected;
let concurrency = 4;

switch (shard) {
  case 'engine':
    selected = allFiles.filter(isEngineCore);
    break;
  case 'native':
    selected = allFiles.filter(f => !isAsync(f) && !isEngineCore(f));
    break;
  case 'async':
    selected = allFiles.filter(isAsync);
    concurrency = 1;
    break;
  case 'all':
    selected = allFiles;
    break;
  default:
    console.error(`Unknown test shard "${shard}". Expected one of: engine, native, async, all.`);
    process.exit(2);
}

if (selected.length === 0) {
  console.error(`No test files matched shard "${shard}" in ${testDir}.`);
  process.exit(1);
}

console.log(`Running shard "${shard}" (${selected.length} files, concurrency=${concurrency}):`);
for (const f of selected) console.log(`  - ${f}`);

const args = ['--test', `--test-concurrency=${concurrency}`, ...selected.map(f => join(testDir, f))];
const result = spawnSync(process.execPath, args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
