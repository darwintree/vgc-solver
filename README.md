# Pokémon 1v1 残局求解 Demo

使用 `@pkmn/sim@0.10.11` 作为战斗规则引擎，并在每个回合求解零和矩阵博弈：

\[
Q_s(a,b)=\sum_{s'}P(s'\mid s,a,b)V(s'),\qquad V(s)=\operatorname{val}(Q_s).
\]

## 运行

```bash
npm install
npm test
npm run demo
npm run benchmark
npm run benchmark -- --case leftovers
npm run benchmark -- --case sucker-punch --pp 8
```

需要 Node.js 20 或更高版本。

## 随机分支

求解器不会枚举 PRNG 种子。对每个行动组合，它会：

1. 用 `battle.toJSON()` 保存当前状态；
2. 用 `Battle.fromJSON()` 从同一状态重放；
3. 拦截本回合实际发生的 `random(n)` / `randomChance(p, q)`；
4. 当前随机分支就地继续，其它分支排队重放；在已审计的模拟器方法中合并等价随机结果，省略无回调的空事件排序；
5. 未结束的分支按相同后继状态合并并递归求值；终局按胜／负／平效用合并概率，直接计入期望收益。

子状态在必胜行或纯鞍点证书成立时停止展开，其余状态补齐矩阵求解。
根节点仍返回完整收益矩阵和双方策略。随机树与状态空间仍可能随局面复杂度迅速增长。

## 基础测试局面

### 1. Trivial

双方均为 1 HP：Scizor 使用 Quick Attack，Blissey 使用 Tackle。先制攻击保证 P1 获胜：

```text
V = +1
```

### 2. Leftovers + Protect + 3HKO

双方均为 50 级 Pikachu，携带 Leftovers，技能为 Seismic Toss 与 Protect。Pikachu 有 110 HP，Seismic Toss 固定造成 50 点伤害，因此是 3HKO。

Demo 将残局 PP 设为：

```text
Seismic Toss: 4 PP
Protect:      1 PP
```

双方完全对称，因此：

```text
V = 0
```

### 3. Sucker Punch 博弈

双方均为 1 HP：

```text
低速 Kingambit: Sucker Punch / Knock Off
高速 Electrode: Protect / Tackle
```

Demo 默认使用 Showdown 初始化的最大 PP（包含 PP Ups）：

```text
Sucker Punch:  8 PP
Knock Off:    32 PP
Protect:      16 PP
Tackle:       56 PP
```

守住后对局会继续，后续价值取决于剩余 PP 以及连续守住的成功率。
完整满 PP 求解结果（策略为根节点策略）为：

```text
V = 0.601097268633219
P1 胜率 = 0.8005486343166095
P2 胜率 = 0.1994513656833905
```

根节点收益矩阵和策略为：

```text
收益矩阵 = [[0.593927528471411, 1], [0.6298748389209616, -1]]
P1 突袭／拍落 = 0.8005486343166093 / 0.1994513656833907
P2 守住／撞击 = 0.9823436931471409 / 0.0176563068528591
```

历史性能测量还使用过将四个招式人为统一 PP 的缩小局面，结果如下：

| 每招剩余 PP | 收益矩阵（行：突袭／拍落；列：守住／撞击） | 价值 | P1 突袭／拍落 | P2 守住／撞击 |
| --- | --- | --- | --- | --- |
| 2 | `[[0, 1], [1, -1]]` | `1/3` | `2/3, 1/3` | `2/3, 1/3` |
| 5 | `[[3/5, 1], [1, -1]]` | `2/3` | `5/6, 1/6` | `5/6, 1/6` |
| 8 | `[[3/4, 1], [1, -1]]` | `7/9` | `8/9, 1/9` | `8/9, 1/9` |

优化前的满 PP 基线求解 1,273 个状态、执行 62,732 次模拟器重放，单次耗时约 22.25 秒。
自动测试覆盖显式 2 PP、5 PP，以及默认满 PP 的完整异步求解；benchmark 用于独立测量性能。

`npm run benchmark` 默认运行满 PP 突袭局面，输出完整求解耗时、均衡结果和搜索统计，
当前 total 包含 fixture 创建；prepare 和 search 分项另行输出。每次运行均创建新的求解器、memo 和 PP cache，
没有沿用上次的求解缓存。
`--case` 可选 `sucker-punch`、`sucker-punch-1` 至 `sucker-punch-6`、`leftovers`、`trivial`；`--pp N` 仅覆盖本次运行的剩余 PP，允许 0。
历史统一 PP 测量中，5 PP 中位数从本轮基线的 3.54 秒降至 0.82 秒，约快 4.31 倍；
8 PP 中位数约 1.96 秒。剩饭／守住中位数约 0.65 秒。全量测试已通过。
方法、正确性证据及限制见 [通用优化记录](docs/general-performance.md)；此前两轮数据见 [历史性能记录](docs/performance.md)。

## 有界 benchmark

benchmark 默认使用 exact 求解器。需要明确传入 `--solver bounded` 才会启用有界区间搜索，例如：

```bash
npm run benchmark -- --solver bounded --case sucker-punch-3 --workers 9 --warmup 3 --runs 5 --tolerance .02
```

`--tolerance W` 指返回区间 `[lowerBound, upperBound]` 的最大宽度，默认是 `0.02`；`--search-ms N` 可为每次 bounded search 设置非负的毫秒预算，benchmark 默认预算为 `5000` 毫秒。`--selection-policy` 可选 `auto`（默认）、`security` 或 `joint`。`auto` 只根据当前根矩阵的纯策略安全界与混合矩阵值选择证明前沿：纯策略足以证明时使用 security，检测到混合均衡后使用 joint；它不读取局面名称或招式。`--tolerance`、`--search-ms` 和 `--selection-policy` 只接受 bounded 模式，exact 模式传入这些选项会报错。满 PP 局面和 fixture 的默认输入保持不变，除非显式使用已有的 `--pp N` 覆盖。

有界结果的 `value` 是区间中点，`valueErrorBound` 是区间宽度的一半。`converged` 表示在给定误差目标内完成了区间收窄；预算耗尽的 run 仍返回实际 elapsed 时间和当前安全区间，但不会计入 `completedRuns`。输出中的 `timing.elapsed` 汇总所有 run，`timing.convergedElapsed` 只汇总已收敛 run；`elapsedSearch`、`convergedSearch` 和 `prepare` 分别报告搜索和准备阶段的实际时间。区间可能表示期望效用而不是纯胜率；在胜／负／平效用为 `+1/-1/0` 时，`(V + 1) / 2` 才是“胜利加半个平局”的分数，不能直接称为胜率。

完整的算法说明、满 PP 向量、原始样本和验收口径见[有界搜索说明与满 PP 验收](docs/bounded-search.md)及其[紧凑 JSON 数据](docs/benchmarks/bounded-fullpp.json)。当前正式验收分别运行：

```bash
node src/benchmark.js --solver bounded --case sucker-punch-3 --workers 9 --warmup 3 --runs 5
node src/benchmark.js --solver bounded --case sucker-punch-4 --workers 9 --warmup 3 --runs 5
node src/benchmark.js --solver bounded --case sucker-punch-5 --workers 9 --warmup 3 --runs 5
```

15 次正式 run 全部收敛并走 `worker` backend。单位为毫秒；total 包含 prepare，search 是区间搜索本身。

| 局面 | 根区间 | value | total min / median / max | search min / median / max |
| --- | --- | --- | --- | --- |
| `sucker-punch-3` | `[0.6277676317, 0.6477311925]` | `0.6377494121` | `2989.035 / 3028.871 / 3192.204` | `1785.217 / 1831.342 / 1933.907` |
| `sucker-punch-4` | `[-0.8000000005, -0.7812500001]` | `-0.7906250003` | `1323.604 / 1368.457 / 1582.912` | `152.465 / 166.629 / 176.949` |
| `sucker-punch-5` | `[-0.8000000005, -0.7812500000]` | `-0.7906250003` | `1707.421 / 1764.039 / 2012.746` | `538.785 / 565.184 / 591.166` |

验证命令 `node --test --test-concurrency=4` 通过 29 个测试文件，失败数为 0。

## 突袭扩展局面

五个新增局面按顺序累积，均使用最大 PP，保留原始物种、等级、性格和能力。P1 为低速 Kingambit，P2 为高速 Electrode。

| benchmark case | P1 HP | P2 HP | 本步变化 |
| --- | --- | --- | --- |
| `sucker-punch-1` | 6 | 1 | P2：守住／撞击／高科技光炮；撞击普通命中为 2HKO，强攻击为 OHKO |
| `sucker-punch-2` | 6 | 1 | P2 强攻击换为 90% 命中的破坏光线 |
| `sucker-punch-3` | 6 | 1 | P1 新增优先级 0 的地震 |
| `sucker-punch-4` | 6 | 130 | P1 原有拍落变成 2HKO，地震仍为 OHKO |
| `sucker-punch-5` | 6 | 130 | P1 新增守住，双方都能保护 |
| `sucker-punch-6` | 6 | 56 | 与第 4 项并行：P1 用撞击替换拍落，突袭为 OHKO，撞击为 2HKO；不累加第 5 项的守住 |

新增招式的满 PP：高科技光炮／破坏光线各 8，地震 16，守住 16。原有突袭 8、拍落 32、撞击 56。
撞击非暴击伤害为 3–4，暴击可能一击击倒 6 HP；拍落非暴击伤害为 70–84，暴击为 106–126，均无法一击击倒 130 HP。
这里使用自定义对局允许的原生招式组合，不限定物种学习面。100%／90% 强攻击通过两个不同的原生招式表达，以避免全局规则修改；二者命中均立即结束对局，因此破坏光线的休息回合不可达。
第 6 项使用原生撞击替换拍落，目标为 56 HP；突袭伤害为 76–90（暴击 114–135），成功发动并命中时恒定 OHKO，撞击伤害为 29–35（暴击 44–52），普通命中两次必定击倒且单次不会 OHKO。其满 PP 向量为 P1 `[8, 56, 16]`、P2 `[16, 56, 8]`。

可单独运行新增局面，默认所有招式均为满 PP：

```bash
npm run benchmark -- --case sucker-punch-1 --workers 8
npm run benchmark -- --case sucker-punch-5 --workers 8
```

扩展局面未纳入默认 demo；原始突袭的满 PP 性能数据不代表新增局面的求解时间。

## 文件结构

```text
src/showdown-adapter.js  Showdown 状态复制、合法行动、随机分支枚举
src/branching-prng.js    可回放且可分叉的 PRNG facade
src/empty-events.js      空事件消除与原生方法检查
src/simulator-optimizations.js  副作用与伤害随机结果的等价合并
src/matrix-game.js       零和矩阵 simplex、数值证书与小矩阵回退
src/solver.js            同步状态递归、缓存与价值证书剪枝
src/async-solver.js      异步转移调度与状态依赖管理
src/transition-pool.js   常驻工作线程池与批量派发
src/pp-transition-cache.js  受审计的 PP 转移模板复用
src/event-plan.js        事件处理函数索引
src/stock-rule-profile.js  跨线程规则一致性检查
src/cases.js             基础局面与五个突袭扩展局面
src/demo.js              命令行输出
src/benchmark.js         局面及 PP 可选的性能基准
```

## 当前边界

这是小状态空间的精确 Demo，不是完整生产求解器：

- 支持测试局面会触发的有限离散随机调用；无参数的连续 `random()` 暂不支持；
- 当前自动行动生成只处理双方各一只 active 的招式选择，尚未实现完整换人、6 选 3、双打行动空间；显式双打和换人命令的测试验证的是转移层；
- 假设残局由 PP 保证有限；若存在真正可再生的循环，需要改为随机博弈不动点求解；
- 矩阵求解使用双精度浮点数及收益证书校验，不是有理数符号求解；
- 状态序列化和随机等价优化依赖固定的模拟器实现。升级依赖需重新审计；不匹配的原生方法会保留原模拟路径。

## 并行 benchmark 口径

上述 `--workers` 命令使用常驻工作线程池，每次独立求解。

`--warmup` 使用所选 fixture 做目标路径预热，但每次都创建新的 battle、solver、memo 和 PP cache；预热结果全部丢弃，不会复用目标答案。这样可以让 JIT 覆盖真实搜索路径。输出分别报告 worker pool 初始化、prepare（规则审计与 init-solve）、search，以及 total 的 min／median／max。线程启动和 prepare 属于固定准备成本；按用户允许的常驻 pool 口径，search 才是 1 秒目标的核心指标。单次端到端耗时仍应单独报告，不能把准备成本从用户可感知的首次调用中隐去。

同步模式也执行 `--warmup`，但只把正式 runs 纳入统计。若规则审计失败，benchmark 会明确标记 `sync-fallback`，并将不适用的 prepare/search 分项输出为 `null`，避免把同步耗时误报成异步搜索成绩。

worker 并行只在精确 stock Gen 9/base Dex 审计通过时启用。自定义 callback、数值规则表或 worker stock profile 不匹配时，完整求解回退到同步 backend；这条回退覆盖 memo、事件和 PP transition，不只是关闭 PP cache。
