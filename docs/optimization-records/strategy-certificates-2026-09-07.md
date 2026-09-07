# 策略证书搜索：发现地震策略并省略无关招式

实验始于 2026-09-07 UTC，本地时间跨至 9 月 8 日。基线为 `f0d3383`，固定验收版本为 `286c7f1`（分支 `codex/strategy-certificates-validated`）。最终合入的生产实现与该验收版本一致。

## 目标与结论

目标是让通用算法自行发现满血烈咬陆鲨对铝钢桥龙的策略剪枝，不向生产求解器提供招式、物种、回合数或 case 答案。原生最大 PP、同步 workers=0、冷进程、10 秒搜索预算、bounded 容差 0.02 均保持不变。

目标三次均达标：search 为 8045.136、7824.551、7997.520 ms，返回相同区间 `[0.9802218964650942, 1]`，宽度 0.019778103534905833。P1 策略为 Earthquake 概率 1，另外三个招式的 12 个根矩阵格全部保持 `[-1,1]`。算法通过地震行的安全下界完成根证书，未将其他招式判为非法或硬删除。

这不是 exact 求解：尚未搜索的随机后继仍贡献未知界。另一个独立诊断穷举固定地震策略的两回合原生分支，确认该策略确实能覆盖所有合法回应；生产搜索不读取这个诊断答案。

## 采用的方法

1. **逐格生成与跨回合证明。** 初始化节点只建立行动矩阵维度。纯策略候选仍可能达到效用极值时，可以在一格生成后进入其后继，沿一次下降保持下界或上界证明方向，不先支付无关根招式的转移成本。
2. **按已有证书分配工作。** 行按 lower floor、lower mean 排序，列按 upper ceiling、upper mean 排序。已锁定的纯策略端点不再作为同方向改善目标，必要时转为 joint。候选近等比较采用 1e-9 的调度分辨率，区间算术和根容差没有放宽。
3. **按证明类型补充矩阵信息。** 混合证明或无法达到全局极值的纯候选，先处理当前节点尚未生成的格，再递归；完全未知的已生成格也会让出机会给同节点的新格。它限制过早深入的代价。随后仍按支持概率与区间宽度、后继概率与宽度调度，并沿共享依赖图回传安全界。
4. **延迟建立 PP 模板。** 求解器及 worker 第二次遇到同一归一化键时才启用追踪和捕获；第一次仍完整枚举。减少一次性状态的 PP 记账开销，模板命中的原审计与 PP 守卫不变。

当前方法借鉴同时行动 Alpha-Beta 与 BRTDP 的区间和证明前沿思想，未实现完整 SMAB 的 LP 支配与祖先窗口，也不套用 BRTDP 的 MDP 收敛定理。[研究依据](strategy-search-research-2026-09-07.md)区分文献结论与本项目工程选择；[有界搜索技术](../optimization-techniques/bounded-search.md)描述最终调度合同。

## 输入与测量口径

- Node v24.20.0，`@pkmn/sim@0.10.11`，Linux / WSL2 5.15.167.4，Intel i5-13600K。
- Champions 快照 `20260903163627216`；HP、性格、特性、道具、四招式及原生最大 PP 见[固定输入](../champions-benchmark.md)。未重新抓取网站或修改 fixture。
- 同步 backend，workers=0，warmup=0，每个样本独立新进程、新 solver/memo/PP cache。每个目标及对照 3 个样本；全量筛查每 case 1 个样本。测量串行，与编译、功能测试分开。
- `maxSearchMs=10000`、`tolerance=0.02`、`selectionPolicy=auto`、`lazyCells=false`；外部 watchdog 30000 ms。达标要求实际 search≤10000 且 converged=true。
- prepare 是规则审计与初始准备，search 是实际搜索，total 还含 fixture 构造；进程启动、模块加载、JSON 写盘不在 total 内。完整参数和原始日期在每段 JSONL metadata 中。

`lazyCells=false` 的参数保留，但本轮统一由前沿控制生成，不再承诺整层 eager 展开；默认 API 同样使用新调度。该内部行为变更已检查同步、异步、benchmark 和结果消费者，详见[实现决策](../traces/implementations/2026-09-07-strategy-certificates.md)。exact 根的完整收益矩阵与策略合同不变。

## 三次冷进程对照

单位均为 ms。prepare 与 total 为中位数；search 列为 min / median / max。

| Case | 版本 | prepare | search | total | 达标 |
| --- | --- | ---: | --- | ---: | --- |
| Garchomp 100 / Archaludon 100 | 基线 | 161.301 | 10000.476 / 10000.654 / 10000.994 | 10171.139 | 0/3 |
| 同上 | 最终 | 163.150 | 7824.551 / 7997.520 / 8045.136 | 8168.576 | 3/3 |
| U2：Garchomp 100 / Primarina 50 | 基线 | 161.031 | 8863.163 / 8882.569 / 8917.028 | 9051.858 | 3/3 |
| 同上 | 最终 | 161.091 | 3739.325 / 3740.755 / 3783.861 | 3910.586 | 3/3 |
| C1：Primarina 50 / Archaludon 25 | 基线 | 162.508 | 3953.707 / 4079.526 / 4104.976 | 4250.474 | 3/3 |
| 同上 | 最终 | 163.044 | 2599.697 / 2662.362 / 2733.777 | 2833.508 | 3/3 |
| C2：Garchomp 50 / Primarina 50 | 基线 | 161.450 | 821.783 / 835.588 / 854.245 | 1003.957 | 3/3 |
| 同上 | 最终 | 161.046 | 615.889 / 622.636 / 635.159 | 792.030 | 3/3 |

U2、C1、C2 的最终宽度分别为 0.019466146166、0.017968750217、约 2e-10，与本轮基线相同。目标基线的 1.916666666611 是尚未收敛的区间宽度；10 秒是预算耗尽时间，不能用它计算“完整求解加速比”。

目标最终每次均展开 405 个状态，生成 1620 个行动格，执行 34902 次模拟器重放，PP cache 命中 0。基线只展开 1 个状态、调用 9 次转移，却在根的昂贵招式上耗尽预算。节点数增加在这里意味着实际完成了后继策略证明，不能孤立地当作退化。

原始样本：[基线](data/strategy-certificates-2026-09-07/baseline.jsonl)、[最终重复测量](data/strategy-certificates-2026-09-07/final-repeats.jsonl)。

默认 API（不传 lazyCells/warmStartRoot）另测一个冷进程样本，prepare 约 161 ms、search 7895.138 ms、total 8064.463 ms，返回同一目标区间；[原始结果](data/strategy-certificates-2026-09-07/default-api.json)证明收益不只存在于 benchmark 配置。

## 54 项全量回归

405 项配对全部记录：54 可测中 29 达标、25 返回未收敛区间，error=0、watchdog=0；351 项仍跳过。上一轮的 24 个达标项全部保留。所有返回 search 的最大值为 10002.659 ms，仍存在合作式截止带来的轻微超预算。

| 新增达标项 | search ms | 区间宽度 |
| --- | ---: | ---: |
| garchomp-100-vs-archaludon-100 | 7891.685 | 0.019778104 |
| primarina-25-vs-mimikyu-25 | 4362.265 | 0.018777413 |
| primarina-25-vs-mimikyu-50 | 8643.093 | 0.016173246 |
| primarina-25-vs-mimikyu-100 | 9298.976 | 0.019996401 |
| primarina-50-vs-mimikyu-25 | 9013.033 | 0.015625000 |

原来紧贴 0.02 的数值边界项 `primarina-25-vs-mimikyu-50` 也通过进一步搜索收敛，没有改变数值余量。全量筛查是每项一个冷进程样本；接近预算的新增项仍需后续重复测量，不能视为稳定余量已充分。

全部 prepare/search/total、25 项失败列表与区间见[筛查明细](strategy-certificates-sweep-2026-09-07.md)，机器可读结果见[原始 JSONL](data/strategy-certificates-2026-09-07/final-sweep.jsonl)。

### 标准 fixture 的性能取舍

case 5 另以 `node dist/src/benchmark.js --solver bounded --case sucker-punch-5 --search-ms 5000 --selection-policy security` 复测，原生最大 PP、workers=0、warmup=0、单个冷进程样本。基线 prepare/search/total 为 178.954 / 1314.676 / 1502.029 ms；最终为 182.194 / 1768.768 / 1959.225 ms，两者均在 5 秒内收敛。

该样本变慢，展开状态由 6 增至 11、转移调用由 72 增至 114，说明本轮调度并非普遍减少工作。将其保留为后续一般证明调度的回归点；不能用 Champions 成功数掩盖这项取舍。该时间比较是单样本，不宣称已测得稳定的加速／退化倍数。[基线](data/strategy-certificates-2026-09-07/case5-baseline-security.json)和[最终样本](data/strategy-certificates-2026-09-07/case5-final-security.json)保留完整统计。原生证书测试的总耗时还包含独立重放审计，不等于 search。

## 探索与未采纳方案

- 固定策略探测队列候选 `a8b53f6` 在目标 10 秒时仍为宽度 1.9167；对照可收敛，但 C1 明显变慢，未采纳。
- 仅逐格生成仍会在后继切换证明方向；携带方向后目标宽度大幅收窄，但未单独达到 10 秒要求。
- optimistic/pessimistic 候选优先级让部分案例反复探索尚未证实的行列，曾造成原生 case 4/5 超时或触及原节点限制；移除该排序，没有提高测试预算或节点上限。
- 仅补完全未知格、仅处理浮点排序平局、仅避开锁定端点、仅补混合矩阵，均不足以独立解决 case 5。最终还按极值证明与一般证明区分信息获取顺序。失败轨迹和证书测试使这一边界具体可检验。
- PP 二次请求准入与早期前沿候选组合，首个目标样本从 10 秒未收敛改善到 7.857 秒收敛。这是组合样本，不将最终整体收益拆分归功于单一技巧。延迟准入会让真正复用的键多枚举一次，也增加按不同键增长的 seen 集合。

[候选原始数据](data/strategy-certificates-2026-09-07/candidates.jsonl)、[case 5 轨迹](data/strategy-certificates-2026-09-07/case5-frontier-trace.jsonl)、[审查记录](strategy-search-review-2026-09-07.md)与[实现决策](../traces/implementations/2026-09-07-strategy-certificates.md)保留过程证据。

## 正确性证据

`npm run typecheck`、`npm run build`、36 项针对性验证和完整 `node --test --test-concurrency=4 dist/test/*.test.js` 均通过，完整套件为 180/180。两个满 PP 原生证书项保持 30000 ms 搜索预算、maxNodes=5000，并要求未触及节点限制；对已生成转移重新执行独立原生枚举，再用独立矩阵 oracle 复核区间与返回策略的安全收益。未生成格在独立回传中仍取 `[-1,1]`。

保留[完整测试日志](data/strategy-certificates-2026-09-07/tests-full.log)与[针对性日志](data/strategy-certificates-2026-09-07/tests-focused.log)。最终主工作区的 `src/`、`test/` 与固定验收提交逐文件核对一致；文档和记录单独检查链接与命令。

新增独立策略测试覆盖 32 层随机链、非第一行动的正负策略、低概率反例、共享后继和循环；现有 exact、worker、原生分布、PP 耗尽与不安全回调回退测试一并通过。测试中的循环只验证安全未知界与可用替代行动，不证明一般可再生循环已可求解。

目标的[独立固定策略诊断](data/strategy-certificates-2026-09-07/policy-diagnostic/README.md)在原生 oracle 与优化枚举两条路径分别覆盖所有合法 P2 回应及两回合随机后继，均无反例。原生路径执行 189060 次重放；优化路径 52206 次。保存的 HP/utility 投影概率一致至约 3.8e-15，这是投影核对，不是完整序列化状态分布等价证据。完整转移等价性由专门的原生分布测试检查。

## 复现

在固定验收版本构建后，以下单例命令分别运行三次；每次保存生成的 `champions-single.jsonl`，下一次会覆盖它。

```bash
npm run typecheck
npm run build
node --test --test-concurrency=4 dist/test/*.test.js
# 等测试完成再测量
node dist/src/champions-benchmark.js garchomp-100-vs-archaludon-100
node dist/src/champions-benchmark.js garchomp-100-vs-primarina-50
node dist/src/champions-benchmark.js primarina-50-vs-archaludon-25
node dist/src/champions-benchmark.js garchomp-50-vs-primarina-50
node dist/src/champions-benchmark.js
```

## 可推广性与限制

候选、界、概率和共享依赖图均不读取案例名称，不设两回合或其他固定深度上限。32 层测试说明实现可以推进较长证明；它不是完整对战长度下的性能保证。当前收益最明确的是可达效用极值的纯策略证明；一般与混合证明可能需要较多同层转移，这一取舍仍需更大行动空间的 benchmark。

当前自动行动生成仍局限于双方各一只 active，固定模拟器审计和有限 PP 假设不变；完整队伍单打、双打、换人以及可再生循环尚未由本轮实现解决。调度启发式不保证最少展开或任意局面 10 秒内收敛。性能结论以此处冷进程口径为限，不能外推到常驻多 worker 或其他硬件。
