# 测试局面

实现见 [`src/cases.ts`](../src/cases.ts)。下文数值为参考结果，历史性能数据不是当前机器的耗时保证。

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

## 突袭扩展局面

第 1–5 项按顺序累积，第 6 项独立于第 5 项；六个扩展局面均使用最大 PP，保留原始物种、等级、性格和能力。P1 为低速 Kingambit，P2 为高速 Electrode。

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

运行参数和 case 6 的已知限时收敛问题见[benchmark 指南](benchmarking.md)。

## Champions 单打使用率前十

新增独立数据驱动的 405 项配对清单（可用配置、独立三档 HP、原生满 PP），输入来源、跳过规则和实例口径见 [Champions 筛查](champions-benchmark.md)。实现见 [`champions-cases.ts`](../src/champions-cases.ts)，与原有 demo 局面分开运行。
