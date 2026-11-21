# 通用可扩展性优化记录（Phase 1–3）

- 日期：2026-11-20
- 基线提交：`38f6e4a`（Node.js 24 LTS，2 vCPU）
- 目标：按跨赛制通用性（1v1 → 完整单打 → 双打）优先级推进搜索调度、概率转移、状态分布与有限视界 PP 复用优化，保持严格 `[L, U]` 安全区间、完整行动维度与 `@pkmn/sim@0.11.0` 精确分布一致。

## 诊断证据

在 6 个典型长耗时 1v1 局面（1.5s 探测）及 2 个历史最慢满血局面上采样发现：
1. **调度层**：
   - `BoundedSolver._selectFrontier` 仅在 `root.upper === +1` 时有定向证明逻辑，在对称负值局（`root.lower === -1, root.upper < +1`）盲目 50/50 交替。
   - `flatUpper` / `flatLower` 策略替换在仅个别行维持 `upper = +1`（如 `golisopod-100-vs-charizard-25` 中 `Sucker Punch (Mega)`）时错误覆盖了见证策略，导致 `root.upper` 长期锁死在 `1.00`。
   - 根部高下界次优动作（如 90% 命中 `Play Rough`）可能长期遮蔽高潜力替代动作（如 100% 命中 `Shadow Claw`）。
2. **概率转移与引擎表示层**：
   - `Scale Shot` 多段暴击组合与 `Leech Life` 吸血联合耦合在未跨阈值时过早拆出 16–256 个 `ActiveBranch`，单回合耗时达 `740–1045 µs/call`。
   - 紧凑引擎适配器未接入 `BoundedSolver` 已有的 `createTurnCursor` / `remainingProbability` 渐进转移合同。
3. **状态空间 PP 重复**：
   - 实测状态去重率显示：`primarina-100-vs-mimikyu-100` PP 重复 `3.58×`（且 `minPp = 2`），`hippowdon-25-vs-dragonite-25` 达 `5.31×`，`garchomp-100-vs-hippowdon-50` 达 `2.82×`，`mimikyu-100-vs-dragonite-25` 达 `2.48×`。

## 实施的通用优化与正确性边界

1. **Phase 1A — 自适应定向调度与精确双最优见证检查**（`src/bounded-solver.ts`）
   - 补齐 `atLowerFloor && !atUpperCeiling` 对称负值边界定向证明；
   - 仅当对侧最优策略在平坦矩阵中同样达到该最优值时才替换 `rowStrategy` / `colStrategy`，保留单行/单列精确见证；
   - 根部周期性探测已在 `>= 50%` 对手回应上严格优于当前界且 `optFloor/optCeiling` 不劣于现任动作的候选行/列。
   - **适用边界**：纯零和矩阵有界搜索层，与规则、单打/换人、双打完全解耦。

2. **Phase 1B — 紧凑引擎 Sound 渐进式概率尾部游标**（`src/engine/turn.ts`, `src/engine/adapter.ts`, `src/engine/types.ts`）
   - 在 `certified` 模式新增 `deferMinProb` / `maxDeferredMass` / `deferMinBranches`（默认 `>= 12` 支才触发，单支 `< 0.08%`，累计上限 `<= 0.2%`，绝不重归一化），将延后质量精确计入 `remainingMass`。
   - `createEngineBoundedAdapter` 接入 `createTurnCursor`（复用支持 partial/complete 升级的 `ppTemplateCache`），按需二阶段精确补全；`tolerance = 0` 自动跳过延后直接精确求解。
   - **适用边界**：全赛制通用（双打 4 行动乘积扇出下收益更大）；`ExactSolver` 与 worker 保持完整 `enumerateTurn`。

3. **Phase 2 — 回合内条件 `HpDist` 分组与单宝可梦边缘 HP 折叠**（`src/engine/turn.ts`, `src/engine/state.ts`, `src/engine/adapter.ts`）
   - 吸血/反伤联合耦合按 `(effAtkDelta, sashUsed, isKo)` 分组并保留受击方精确条件 `HpDist`（满血吸血 16–256 支合并为 1 支，无 `Counter/Mirror Coat/Metal Burst` 时精确等价）。
   - `mergeActiveBranches` 与 `finalizeOutcomes`（`distributional`）执行单宝可梦边缘 HP 折叠（掩码单只宝可梦 HP、其余所有宝可梦 HP 与状态位完全相同才合并，严格保持跨宝可梦联合分布）。
   - `partitionMonotoneAxis` 对间隔 `> 6 HP` 的双峰 HP 簇（如 1/24 暴击尾与 23/24 非暴击主体）分箱，防止罕见暴击拉宽主单调矩形。
   - **适用边界**：全赛制（1v1 / 完整单打 / 双打）精确等价，与 `@pkmn/sim` 差分对拍 `TVD = 0`。

4. **Phase 3 — 有限视界 PP 界复用（Depth-Certified PP Bound Reuse）**（`src/bounded-solver.ts`, `src/engine/adapter.ts`）
   - 每个节点追踪认证下界与上界的精确证明深度 `lowerDepth` / `upperDepth`（含单调传播深度继承）。
   - 在无非线性 PP 机制（`Leppa Berry` / `Spite` / `Transform` / `Imposter` / `Instruct` / `Copycat` / `Sleep Talk` / `Eerie Spell` / `Grudge` / `Trump Card` / `Lunar Dance`）且考虑 `Pressure` 扣率 `maxPpLossPerTurn` 的前提下，若两状态非 PP 部分完全相同且所有 PP 不同的招式均满足 `pp > maxPpLossPerTurn × D`，则前 `D` 回合内转移分布完全一致，允许安全共享深度为 `D` 的上下界（不标记 `exactCertified`）。
   - **适用边界**：不依赖 1v1 或 HP 单调性，对完整单打与双打同样成立（完整单打/双打收益待后续集成验证）。

## 否决项（正确性审计）

- **Sitrus Berry 与 Blaze+Roost 分段 HP 单调**：构造了严格反例（例如 Sitrus Berry 在 `hp = 101` 先吃 4 点伤害触发回血至 `147` 可存活后续 `102` 伤害，而 `hp = 105` 不触发则暴毙；Blaze+Roost 同理），确认为非单调机制，维持 fail-closed，未强行放宽。
- **低扇出回合无条件延后尾部分支**：初期测试发现无 `deferMinBranches` 门槛会在低扇出局面引入 `0.006` 残余宽度导致 `primarina-100-vs-archaludon-100` 退化 +38%；加入 `minBranches >= 12` 与 `maxDeferredMass <= 0.002` 后消除退化。

## 前后测量结果

### 历史 54 集严格验收（`budget = 10000ms`, `tol = 0.02`, 同步 compact 引擎）

命令：
- `node scripts/champions-ci-sweep.mjs --scope=historical-54 --snapshot=2026-09`
- `node scripts/champions-ci-sweep.mjs --scope=historical-54 --snapshot=2026-11`

| 指标 | 基线（`38f6e4a`） | Phase 1–3 后 | 变化 |
| --- | ---: | ---: | ---: |
| `2026-09` 达标数 | 54 / 54 | **54 / 54** | 0 回归 |
| `2026-09` 总 search | ~11.6 s | **9.87 s** | **-15%** |
| `2026-09` `primarina-100-vs-mimikyu-100` | 4.08 s | **2.01 s** | **2.03× 提速** |
| `2026-09` `garchomp-100-vs-archaludon-100` | 154.3 ms | **36.0 ms** | **4.29× 提速** |
| `2026-11` 达标数 | 54 / 54 | **54 / 54** | 0 回归 |
| `2026-11` `primarina-100-vs-mimikyu-100` | 8.26 s | **4.05 s** | **2.04× 提速** |

### 代表性长耗时 1v1 局面 1.5s 探测（`scripts/inspect-case.mjs --search-ms=1500 --profile`）

| 局面 | 基线 | Phase 1–3 后 | 改善 |
| --- | --- | --- | --- |
| `golisopod-100-vs-charizard-25` (`2026-11`) | `[-0.5238, 1.0000]`（宽 `1.524`），`472 µs/call` | **`[0.0204, 0.6927]`（宽 `0.672`），`275 µs/call`** | 区间收窄 **2.27×**，吞吐 **1.72×** |
| `garchomp-100-vs-hippowdon-50` (`2026-09`) | `1045 µs/call` | **`422 µs/call`**（阶段 2） | 单回合提速 **2.5×** |
| `mimikyu-100-vs-dragonite-25` (`2026-09`) | `7182 calls`，`Shadow Claw` 锁死在 `-0.78` | `Shadow Claw` 解锁至 `7/8` 列 `1.00`、`c5 = 0.85`，`ppUpd = 13234` | 打破次优 incumbent 锁死 |
| `primarina-100-vs-golisopod-100` (`2026-11`) | `740 µs/call` | **`387 µs/call`** | 单回合提速 **1.9×** |

## 尚未解决项

- `Slack Off` / `Roost` / `Yawn` 引发的深准循环（需持续消耗 8–16 PP 才分胜负）以及未消耗 `Sitrus Berry` / `Torrent` / `Blaze` 导致的非单调 HP 16× 扇出，在 1.5s 内仍未收敛；后续需面向准循环的随机博弈不动点/可认证策略界方法。
