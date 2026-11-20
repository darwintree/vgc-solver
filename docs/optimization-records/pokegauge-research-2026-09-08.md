# PokeGauge 伤害计算调研（2026-09-08）

本记录仅为源码调研，不包含性能实验或生产代码改动。审阅版本为 `712257b6738384fb9e71dea2c3fdbdfe986f3ae8`；下列外部链接固定到该提交。结论是：值得借鉴的是**同一执行阶段的状态分布聚合与条件分布复用**，不能把 PokeGauge 的伤害计算器直接替换本项目的完整回合转移。

## 实际调用路径与优化

当前运行时采用固定的 `@smogon/calc@0.11.0`。ADR 0007 已取代早期本地伤害公式；ADR 0008 又取代“单次分布直接卷积”的概率接口。`damage-kernel.ts` 中仍有公式投影与旧接口，不能因此认定主路径在用本地公式。[依赖](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/package.json)、[ADR 0007](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/docs/adr/0007-smogon-calc-runtime-damage-engine.md)、[ADR 0008](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/docs/adr/0008-hit-composition-and-berry-state.md)。

主路径为 `evaluate.ts → compileScenario → evaluateExecutionPoint → compileHitComposition → calculateHitMatrixVariants → calculateHitMatrix → calc.calculate`，之后交给 `resolveHitComposition` 和 `sequenceKOProbabilities`。编译器准备情景条件；calc 返回逐段普通／会心伤害矩阵；本地概率层组合命中、随机段数、会心和有限状态变化。[情景入口](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/scenario/evaluate.ts)、[执行编译](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/hit-execution.ts)、[calc 适配器](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/calc-engine.ts)。

| 源码已实现的技术 | 如何减少工作 | 正确性边界 |
| --- | --- | --- |
| 每段后用 `Map` 合并相同累计伤害与状态 | 不保留全部 16 个伤害档位和会心组合的历史路径；下一段只扩展当前不同状态 | 仅在同一执行位置聚合；状态包含树果消费、是否会心、是否命中、已触发能力变化次数，不能只按伤害合并 |
| 第二次使用按 `berryConsumed + 2 * statChanges` 缓存条件分布 | 首次攻击的不同伤害结果若共享后续状态，就复用后一次攻击分布 | 固定情景内仅跟踪抗性果与支持的能力变化；没有通用战斗状态语义 |
| KO 查询排序、后缀概率和二分 | 针对不同剩余 HP 重复查询尾部概率，避免显式构造两次使用的全部伤害和分布 | 是累计伤害达到 HP 的概率查询，不是对手行动或完整对战价值 |
| 以 `calculationIdentity` 共享情景计算 | 不同展示／来源分组共用一次 `summarizeDamage` | 这是产品编译身份，通常含公式投影；仅存在 `statChange` 时额外加入 calc 上下文，不可当作通用模拟器等价键 |

前三项依据[概率实现](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-distribution/hit-composition.ts)与[执行缓存](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/hit-execution.ts)，最后一项依据[计算身份](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/scenario-compiler.ts)与[情景分组](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/scenario/evaluate.ts)。本次未证明该产品身份对 calc 全部语义完整，也未发现可引用的伤害引擎 A/B 加速测量。仓库的 `perf:scenario-explorer` 脚本测量目录初始化与构建资源大小，不能充当伤害算法提速证据。[性能脚本](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/scripts/verify-scenario-explorer-performance.ts)。

## 已有验证与完整转移的差距

源码测试覆盖独立伤害档位组合（而非同下标相加）、逐段未命中终止、相同伤害不同树果状态不合并、伤害与能力变化的相关性；执行测试包含 Crunch 降防与抗性果、Parental Bond Power-Up Punch 累积提升，并以显式枚举小规模组合核对 KO 概率。[概率测试](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-distribution/hit-composition.test.ts)、[执行测试](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/hit-execution.test.ts)。这些是已存在的测试证据；本次没有安装依赖或重新运行测试，不能报告为本次通过。

PokeGauge 明确选择受限顺序模型。其 `ResolutionState` 只有抗性果消费及已审阅招式的能力变化次数；招式变化表只覆盖部分攻击／特攻提升、防御／特防降低。条件特性还会通过预设 HP／状态等输入表达“假定已满足”。第二次执行只根据上述状态重新编译，并未按首次实际伤害更新完整双方战斗状态。[状态与算法](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-distribution/hit-composition.ts)、[受支持变化表](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/move/stat-change.ts)、[情景假设](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/scenario-compiler.ts)、[受限模型决策](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/docs/adr/0008-hit-composition-and-berry-state.md)。

因此，不能直接用其缓存键处理 Stamina（每次受击提升防御）、Sitrus Berry（HP 阈值触发回血）、反伤、退场、招式中断、其他事件回调以及完整回合结束效果。特别是其抗性果状态不等于 Sitrus 的治疗状态。calc 适配器还显式修正 Parental Bond 子段重复应用抗性果的行为，并复用 Power-Up Punch 的内部提升以防加两次；这说明外部伤害库本身也需要按固定版本审计，不能把它视为 `@pkmn/sim` 状态转移等价证明。[适配器及修正](https://github.com/darwintree/PokeGauge/blob/712257b6738384fb9e71dea2c3fdbdfe986f3ae8/src/lib/damage-calculation/calc-engine.ts)。

## 对本项目的建议（尚未实现或测量）

优先验证**受条件保护的逐段状态分布动态规划**：仍由本项目固定版本的 `@pkmn/sim` 决定事件与伤害语义，在某个可恢复的相同执行阶段，对足以决定所有后续行为的状态合并概率。收益假设是减少等价历史重放，适用于会产生许多重复后继的多段招式，不依赖 case 名或削减 PP。[本项目转移合同](../architecture.md#随机分支)。

落地前先证明“可恢复”：本项目目前从回合快照重放随机前缀，中途的 Battle JSON 不能自动代表模拟器循环局部变量、当前段数和目标处理进度。应先做受限原型，证明 continuation 所需信息完整，再谈生产实现；缺少审计条件时走原生路径。不能照搬 PokeGauge 的两字段键，不能跳过 `DamagingHit` 回调，不能用累计伤害分布代替全后继状态分布。

验证对象应为原生与候选路径的**完整后继状态及概率**，至少包含普通多段、逐段会心／未命中、Stamina + Sitrus 的逐段交互和不支持规则回退；通过后再测原生满 PP 的 prepare、search、total 与分支／重放数。KO 尾部查询可作为受限查询工具，但它本身不是 exact 价值证明或 bounded 安全区间证书。本记录没有速度承诺，也没有宣称已完成[可扩展性优化工作流程](../architecture.md#可扩展性优化工作流程)。
