# Benchmark 指南

所有命令在仓库根目录运行。完整参数以 `npm run benchmark -- --help` 为准，`npm run benchmark` 先编译到 `dist/`，编译耗时不计入程序输出的 prepare/search/total；fixture 定义见[测试局面](cases.md)。

## 精确求解

默认使用同步 exact 求解器，**没有 bounded 模式的 5 秒预算**，复杂局面可能运行很久。

```bash
npm run benchmark -- --case leftovers
npm run benchmark -- --case sucker-punch --pp 8
```

`npm run benchmark` 默认运行满 PP 突袭局面，输出完整求解耗时、均衡结果和搜索统计，
当前 total 包含 fixture 创建；prepare 和 search 分项另行输出。每次运行均创建新的求解器、memo 和 PP cache，
没有沿用上次的求解缓存。
`--case` 可选 `sucker-punch`、`sucker-punch-1` 至 `sucker-punch-6`、`leftovers`、`trivial`；`--pp N` 仅覆盖本次运行的剩余 PP，允许 0。
历史统一 PP 测量中，5 PP 中位数从本轮基线的 3.54 秒降至 0.82 秒，约快 4.31 倍；
8 PP 中位数约 1.96 秒。剩饭／守住中位数约 0.65 秒。这些是历史测量，不是当前环境的性能保证。
方法、正确性证据及限制见 [通用优化记录](optimization-records/general-performance.md)；此前两轮数据见 [历史性能记录](optimization-records/performance.md)。

## 有界 benchmark

benchmark 默认使用 exact 求解器。需要明确传入 `--solver bounded` 才会启用有界区间搜索，例如：

```bash
npm run benchmark -- --solver bounded --case sucker-punch-3 --workers 9 --warmup 3 --runs 5 --tolerance .02
```

`--tolerance W` 指返回区间 `[lowerBound, upperBound]` 的最大宽度，默认是 `0.02`；`--search-ms N` 可为每次 bounded search 设置非负的毫秒预算，benchmark 默认预算为 `5000` 毫秒。`--selection-policy` 可选 `auto`（默认）、`security` 或 `joint`。`auto` 只根据当前根矩阵的纯策略安全界与混合矩阵值选择证明前沿：纯策略足以证明时使用 security，检测到混合均衡后使用 joint；它不读取局面名称或招式。`--tolerance`、`--search-ms` 和 `--selection-policy` 只接受 bounded 模式，exact 模式传入这些选项会报错。满 PP 局面和 fixture 的默认输入保持不变，除非显式使用已有的 `--pp N` 覆盖。

有界结果的 `value` 是区间中点，`valueErrorBound` 是区间宽度的一半。`converged` 表示在给定误差目标内完成了区间收窄；预算耗尽的 run 仍返回实际 elapsed 时间和当前安全区间，但不会计入 `completedRuns`。输出中的 `timing.elapsed` 汇总所有 run，`timing.convergedElapsed` 只汇总已收敛 run；`elapsedSearch`、`convergedSearch` 和 `prepare` 分别报告搜索和准备阶段的实际时间。区间可能表示期望效用而不是纯胜率；在胜／负／平效用为 `+1/-1/0` 时，`(V + 1) / 2` 才是“胜利加半个平局”的分数，不能直接称为胜率。

算法及 API／CLI 配置差异见[有界搜索技术](optimization-techniques/bounded-search.md)，case 3–5 的历史验收见[优化记录](optimization-records/bounded-fullpp.md)。预算检查发生在转移和 backup 之间，单次转移不会被强行中断，实际搜索耗时可能略超预算。

## 并行 benchmark 口径

`--workers` 命令使用常驻工作线程池，每次独立求解。

`--warmup` 使用所选 fixture 做目标路径预热，但每次都创建新的 battle、solver、memo 和 PP cache；预热结果全部丢弃，不会复用目标答案。这样可以让 JIT 覆盖真实搜索路径。输出分别报告 worker pool 初始化、prepare（规则审计与 init-solve）、search，以及 total 的 min／median／max。线程启动和 prepare 属于固定准备成本；按常驻 pool 口径衡量搜索目标时使用 search。单次端到端耗时仍应单独报告，不能把准备成本从用户可感知的首次调用中隐去。

同步模式也执行 `--warmup`，但只把正式 runs 纳入统计。若规则审计失败，exact benchmark 会标记 `sync-fallback`，不适用的 prepare/search 分项为 `null`；bounded 结果通过 `backend: fallback` 标记回退。验收时应检查 backend，避免把同步成绩当作 worker 成绩。

worker 并行只在精确 stock Gen 9/base Dex 审计通过时启用。自定义 callback、数值规则表或 worker stock profile 不匹配时，完整求解回退到同步 backend；这条回退覆盖 memo、事件和 PP transition，不只是关闭 PP cache。

## 已知问题：case 6 未在默认预算内收敛

case 6 已复现默认 5 秒预算内不收敛；后续键优化的 3 秒目标也未达成。首次超时区间、完整收敛对照与未采纳候选统一保存在 [case 6 优化记录](optimization-records/case6-performance.md)。

## 其他历史记录

- [满 PP 优化](optimization-records/full-pp-optimization.md)与[独立验收](optimization-records/full-pp-review.md)：优化准入条件与正确性证据。
- [实现决策追踪](traces/implementations)：历史取舍，不作为当前任务指令。

历史验收只描述记录对应的版本、输入和环境，当前性能结论需重新运行 benchmark。

## Champions 单打前十批量筛查

[Champions 筛查](champions-benchmark.md)提供固定使用率快照、独立三档 HP 的两两配对、每 case 10 秒 bounded 搜索、跳过原因和逐例结果。运行 `npm run build` 后执行 `node dist/src/champions-benchmark.js`；性能扫描与功能测试分开运行。

后续两条优化方向和建议的日常六项集合见[benchmark 选例](champions-benchmark-selection.md)。
