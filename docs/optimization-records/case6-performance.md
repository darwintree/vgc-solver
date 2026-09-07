# Case 6：缓存键优化与三秒目标

日期：2026-09-07。**本轮未达到 search ≤ 3 秒的目标。** 合入的改动降低键生成成本，不改变搜索策略、输入 PP 或误差标准。

## 测量口径与结果

环境为 Apple M2 Pro（10 逻辑 CPU、16 GiB）、Node.js v25.8.1。原版为 `8c36db9`，新版为该版本加本轮三个源文件的键生成优化；原版与新版串行测量，各自创建常驻 pool，预热 3 次、正式运行 5 次。系统仍有其他应用负载，因此这些是本轮观测，不能承诺固定加速倍率。

两版均在各自仓库根目录运行：

```bash
node src/benchmark.js --solver bounded --case sucker-punch-6 --workers 9 --warmup 3 --runs 5 --search-ms 60000
```

输入保持原生满 PP：P1 `[8,56,16]`、P2 `[16,56,8]`；tolerance=0.02，auto，batch8，lazyCells=false。60 秒仅用于测出完整收敛时间，验收目标仍是 3 秒。每次重建 battle、solver、memo 和 PP cache；预热结果不计入正式样本。

| 版本 | Search min / median / max (s) | Prepare median (s) | Total median (s) | 区间达标 | 3 秒达标 |
| --- | --- | --- | --- | --- | --- |
| 原版 | 22.538 / 30.892 / 33.625 | 4.910 | 35.853 | 5/5 | 0/5 |
| 新版 | 19.858 / 23.656 / 27.025 | 5.761 | 27.931 | 5/5 | 0/5 |

本轮 search 中位数下降约 23.4%。Total 包含 fixture 和 prepare，不包含常驻 pool 启动；原版／新版 poolReady 分别为 2.086／1.272 秒。各列中位数独立计算，不应直接相加。

全部 10 个正式样本均走 worker backend，根区间相同：`[0.6273551937263693, 0.6469988344254585]`，宽度约 0.019644，中点为 0.6371770140759139。双方策略、完整上下界矩阵以及所有非计时搜索统计也完全一致：展开 1123 个节点、发现 13768 个状态、9834 次转移调用、35578 次模拟、5372 次 PP cache 命中。中点不是精确价值，仍按有界结果解释。

逐次样本、策略、矩阵、统计和配置见 [JSON 数据](data/case6-key-optimization.json)。

## 保留的通用优化

- `showdown-adapter.js`：同一随机分支的 outcome key 只生成一次，供后继聚合和 PP template 构建复用。
- `pp-transition-cache.js`：构建 PP key 时只复制需要改动的 move-slot 路径，不再 JSON roundtrip 整个快照。
- `native-memo-key.js`：相对 effectOrder 归一化只复制计数器所在路径，再直接 JSON.stringify，避免对每个属性调用 replacer。

这些改动依赖现有原生 JSON 快照边界，不依赖 1v1、招式名称、固定行动数或某个 case；公开 stateKey、原生审计与不兼容规则回退保持不变。它们不会让尚未实现的完整单打、双打行动生成自动可用。

## 验证与未采纳方案

主代理独立对照了 180 个 memo key，均与原版逐字节一致；相关 43 项测试通过，覆盖完整 Tackle/Tackle 原生后继及缓存重放、PP 机制、双打位置变化、冻结快照和序列化边界。新增的多层随机博弈检查覆盖共享后继、矩形行动空间及区间证书。

完整验证命令 `node --test --test-concurrency=4` 重跑后 149/149 通过（42.735 秒）。首次运行 148/149 通过，原有 `worker-backed full-PP interval contains the exact reference` 在 5 秒预算内未收敛，价值区间断言未失败；该用例随后单独运行通过（用例总耗时 2.317 秒），未修改其预算或断言。此限时检查存在本轮观测到的波动，不应把重跑通过当作性能稳定性保证。

误差预算前沿、延后昂贵 cell、跨节点异步流水三类候选未形成足够的收敛净收益证据，未合入主代码，也未增加配置选项。实验取舍见[实现记录](../traces/implementations/2026-09-07-case6-performance.md)。

本轮只减少了每次转移的辅助成本，仍需同样的搜索工作量。要继续逼近 3 秒，应进一步验证减少必要展开或复用已证明结果的通用方法；当前实验不足以证明哪一种方案能达标。

## 附：优化前的首次 5 秒预算复现

2026-09-07，本地 Node.js v25.8.1、`@pkmn/sim@0.10.11`，代码版本 `8c36db9`；满 PP P1 [8, 56, 16]、P2 [16, 56, 8]，9 workers，预热 1 次、正式运行 2 次：

```bash
node src/benchmark.js --solver bounded --case sucker-punch-6 --workers 9 --warmup 1 --runs 2
```

| Run | Search (ms) | Total (ms，含 prepare) | 根区间 | 收敛 |
| --- | --- | --- | --- | --- |
| 1 | 5020.555 | 7988.354 | [0.3238799048, 0.7848351355] | 否 |
| 2 | 5027.855 | 7437.556 | [0.4123401230, 0.7632597649] | 否 |

两次均为 worker backend，`stopReason: time`，`completedRuns: 0`。第二次区间宽度约 0.351，仍大于目标 0.02。以上是本机观测，不是跨机器性能保证；首次复现时已确认超时，尚未定位具体瓶颈；后续结果见本文前述测量。现有 case 6 测试覆盖局面和原生转移，不包含满 PP 限时收敛验收；case 3–5 的历史成功不能外推至 case 6。
