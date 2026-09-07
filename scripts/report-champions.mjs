import {readFileSync} from 'node:fs';
import {basename} from 'node:path';

const file = process.argv[2] ?? 'champions-results.jsonl';
const [meta, ...samples] = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const counts = {};
for (const sample of samples) counts[sample.status] = (counts[sample.status] ?? 0) + 1;
const measured = samples.filter(s => s.status !== 'skipped');
const failed = measured.filter(s => s.status !== 'within-budget');
const num = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const escape = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
function table(rows) {
  console.log('| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of rows) {
    console.log(`| ${s.id} | ${s.status} | ${s.converged ?? '—'} | ${num(s.lowerBound)} | ${num(s.upperBound)} | ${num(s.upperBound - s.lowerBound)} | ${num(s.prepareMs)} | ${num(s.searchMs)} | ${num(s.totalMs)} |`);
  }
}
console.log(`# Champions 单打前十：${meta.startedAt.slice(0, 10)} 测量结果\n`);
console.log(`输入与复现口径见 [Champions 筛查](../champions-benchmark.md)。原始结果见 [JSONL](${basename(file)})。\n`);
console.log(`完成 ${samples.length}/405 项；可测 ${measured.length} 项，跳过 ${counts.skipped ?? 0} 项。10 秒内达标 ${counts['within-budget'] ?? 0} 项，未达标 ${failed.length} 项。状态计数：\`${JSON.stringify(counts)}\`。\n`);
console.log('## 环境\n');
console.log(`- 开始时间：${meta.startedAt}；数据版本：${meta.dataVersion}（${meta.sourceGeneratedAt}）。`);
console.log(`- 仓库基线：\`${meta.gitCommit}\`，加本次新增数据、fixture 和扫描脚本；求解器未修改。`);
console.log(`- Node ${meta.node}，@pkmn/sim ${meta.simulator}；${meta.platform} ${meta.release}；${meta.cpu}。`);
console.log(`- 命令：\`node dist/src/champions-benchmark.js\`。`);
console.log(`- backend=${meta.backend}，workers=${meta.workers}，预热=${meta.warmupRuns}，每 case 样本=${meta.runs}，串行、新进程；原生最大 PP。`);
console.log(`- 容差 ${meta.tolerance}，搜索预算 ${meta.searchBudgetMs} ms，watchdog ${meta.watchdogMs} ms，lazyCells=${meta.lazyCells}，selectionPolicy=auto。\n`);
console.log('prepare 为审计与准备；search 为实际搜索；total 从 fixture 创建开始。进程启动和模块加载不计入 total。未测得的时间及区间用 — 表示。安全区间是效用界，不是胜率；表内四舍五入，完整精度见 JSONL。单样本结果受环境影响，不能外推为常驻 worker 性能保证。\n');
console.log('## 未在 10 秒内求解的 case\n');
if (failed.length) table(failed);
else console.log('所有可测 case 均达标。');
console.log('\n## 所有可测 case\n');
table(measured);
console.log('\n## 各配对统计\n');
console.log('| 配对 | 10 秒内达标 | 未达标 |');
console.log('| --- | --- | --- |');
const pairs = new Map();
for (const s of measured) {
  const pair = s.id.replace(/-\d+-vs-/, ' vs ').replace(/-\d+$/, '');
  if (!pairs.has(pair)) pairs.set(pair, [0, 0]);
  pairs.get(pair)[s.status === 'within-budget' ? 0 : 1]++;
}
for (const [pair, count] of pairs) console.log(`| ${pair} | ${count[0]} | ${count[1]} |`);
console.log('\n## 跳过原因\n');
const reasons = [...new Set(samples.flatMap(s => s.reasons ?? []))];
for (const reason of reasons) console.log(`- ${escape(reason)}`);
console.log('\n完整 405 个 case 的状态及逐项跳过原因保存在 JSONL；跳过项不计作求解超时。');
const errors = measured.filter(s => s.error);
if (errors.length) {
  console.log('\n## 运行错误\n');
  for (const s of errors) console.log(`- ${s.id}: ${escape(s.error)}`);
}
