# 满血西狮海壬求解与单调 HP 矩形自适应细化（2026-11-20）

## 1. 基线与测量口径

- **代码基线**：`b7b6ebf`（紧凑单遍分支引擎已接入 `BoundedSolver` 默认 `'auto'` 路径）
- **环境**：Node.js `v24.22.3`，`@pkmn/sim@0.11.0`，`linux 6.12.105+`，2 vCPU（`Intel(R) Xeon(R) Platinum 8481C`）
- **统一口径**：原生满 PP（含 PP Up）、`workers=0`、`backend=sync`、`engine=compact`（`'auto'` 准入）、`tolerance=0.02`、`maxSearchMs=10000`、`lazyCells=false`、`selectionPolicy='auto'`、每例独立冷进程（`warmup=0`）
- **测量命令**：
  - 单例：`node dist/src/champions-benchmark.js <case-id>`
  - 历史 54 项全量：通过 `dist/src/champions-benchmark.js --child <id>` 逐例独立子进程扫描历史 4 只非 Mega 精灵（`garchomp`、`primarina`、`archaludon`、`mimikyu`）的 6 组配对 × 9 档 HP 组合（54 项）

基线 `b7b6ebf` 下历史 54 项为 **52/54 达标**，仅剩 2 项满血西狮海壬超时未收敛：

- `primarina-100-vs-archaludon-100`：`search=10000.8ms`，`V=[0.5266, 0.9010]`，`width=0.3744`，`nodes=65914`
- `primarina-100-vs-mimikyu-100`：`search=10125.4ms`，`V=[-0.9328, -0.2457]`，`width=0.6871`，`nodes=100000`（触及节点上限）

## 2. 瓶颈诊断

1. **冗余状态键拆分**：`canonicalStateKey` 无条件编码了双方 `lastMoveIdx`、`lastMoveId`、`lastMoveFailed`、`lastItemId`、`ateBerry` 以及无观测能力阶级（例如面对纯物理谜拟丘时，`Moonblast` 的 30% 降特攻副作用把每回合状态无意义地一分为二）。
2. **离散 HP 笛卡尔积爆炸**：`primarina-100-vs-archaludon-100` 的根节点单格（如 `Moonblast` vs `Flash Cannon`）在离散展开下产出 1,409 个子状态，其中绝大多数仅在 `(hp1, hp2)` 上不同；但在 `hpOutputMode: 'distributional'` 下仅 9 个独立分布分支。`BoundedSolver` 逐一扩展同模板的不同 HP 节点且不共享安全界，导致节点与转移开销成百倍放大。

## 3. 迭代策略与正确性条件

### 迭代 1：精确读驱动 `FeatureBit` 状态键极简

- 实现位置：[src/engine/types.ts](../../src/engine/types.ts)、[src/engine/context.ts](../../src/engine/context.ts)、[src/engine/state.ts](../../src/engine/state.ts)
- 按实际招式／特性读取关系拆分 `FIELD_LAST_MOVE`、`LAST_MOVE_ID`、`LAST_MOVE_FAILED`、`LAST_ITEM`、`ATE_BERRY`、`SIDE0_LAST_MOVE_IDX`、`SIDE1_LAST_MOVE_IDX`，并省略已空道具的冗余 `/IO:` 字段。
- 严格互模拟等价：无读取者时对应字段不影响任何后续转移。

### 迭代 2：1v1 严格 HP 单调性支配传播与角点优先选择

- 实现位置：[src/engine/adapter.ts](../../src/engine/adapter.ts)、[src/bounded-solver.ts](../../src/bounded-solver.ts)
- 在 1v1 单打回合态上构建保守单调签名 `createMonotoneAnalyzer`：仅当任意更高 `h1`（或更低 `h2`）严格保证 minimax 价值不降时才开放对应轴：
  - 含 `sitrus-berry`／`oran-berry` 且 `itemActive === true`（或存在 `recycle`/`harvest`/`trick`/`steal-item`/`steal-berry`/`teatime`/`magician`/`pickpocket`/`symbiosis` 且场上存在 HP 树果）时禁用该轴；
  - 含激流／猛火／茂盛／虫之预感（`pinchType` 且带对应属性或动态属性招式）时，仅在 `hp <= floor(maxhp / 3)` 且当前与后续不可回复时开放；
  - 含 `berserk`/`shieldsDown`/`gulpMissile`/`emergencyExit` 时仅在 `hp <= floor(maxhp / 2)` 且不可回复时开放；`galeWings` 仅在 `hp < maxhp` 且不可回复时开放；
  - 含 `flail`/`endeavor`/`rest` 禁用己方轴；对手含 `hard-press`/`drain`/`shell-bell` 禁用受击轴；含 `pain-split`/`copycat`/`transform`/`sleep-talk` 或特性变更机制时禁用双轴。
- `BoundedSolver` 维护 1D 有序数组与 2D Pareto 前沿，在 `_intern` 与 `_backupFrom` 中安全传递 `[lower, upper]` 界（绝不伪造 `exactCertified`，绝不越过根节点策略证书直接改写 `rootNode`），并在 `_selectFrontier` 优先展开最高杠杆角点。

### 迭代 3：无观测 `SpA`/`SpD` 能力阶级消除 + 自适应单调 HP 矩形二分细化

- 实现位置：[src/engine/context.ts](../../src/engine/context.ts)、[src/engine/state.ts](../../src/engine/state.ts)、[src/engine/adapter.ts](../../src/engine/adapter.ts)、[src/bounded-solver.ts](../../src/bounded-solver.ts)
- **精确互模拟（无观测 `SpA`/`SpD`）**：仅当某方无任何特殊招式（含 `shell-side-arm`）且全场不存在任何读取／复制／反转／消耗能力阶级的招式、特性或道具（`stored-power`、`psych-up`、`power-swap`、`guard-swap`、`topsy-turvy`、`baton-pass`、`stockpile`、`acupressure`、`lash-out`、`stomping-tantrum`、`transform`、`copycat`、`sleep-talk`、`defiant`、`competitive`、`contrary`、`mirrorArmor`、`opportunist`、`moody`、`imposter`、`curiousMedicine`、`white-herb`）时，才在 `canonicalStateKey` 中屏蔽该方 `boosts[2]`（或对手无特攻时屏蔽己方 `boosts[3]`）。
- **自适应单调 HP 矩形（`MonotoneBoxOutcome`）**：在 `hpOutputMode: 'distributional'` 的独立 HP 分布上，将可证明单调的 HP 区间保留为紧凑矩形，仅实例化最坏角点 `(min h1, max h2)` 与最好角点 `(max h1, min h2)` 用于严格区间界定；当且仅当矩形的角点差值成为前沿主要不确定性来源时，按最长轴二分细化，确保有限步内可收敛至任意容差，且未完全拆分的矩形永不标记 `exactCertified=true`。

## 4. 逐轮改进与验收数据

### 4.1 两个满血西狮海壬局面逐轮对比（单样本冷测，`10s` / `tol=0.02` / `workers=0`）

| 轮次 | 局面 | 状态 | 区间 `[L, U]` | 宽度 | prepare (ms) | search (ms) | total (ms) | nodes | boxSplits |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 基线 (`b7b6ebf`) | `primarina-100-vs-archaludon-100` | 未收敛 (time) | `[0.5266, 0.9010]` | `0.3744` | — | `10000.8` | — | `65914` | `0` |
| 迭代 1 | `primarina-100-vs-archaludon-100` | 未收敛 (time) | `[0.5266, 0.8645]` | `0.3378` | — | `10001.0` | — | `65401` | `0` |
| 迭代 2 | `primarina-100-vs-archaludon-100` | 未收敛 (time) | `[0.6308, 0.8992]` | `0.2685` | `215.0` | `10001.7` | `10216.7` | `54362` | `0` |
| 迭代 3 | `primarina-100-vs-archaludon-100` | **达标** | `[0.651011, 0.669934]` | `0.018923` | `205.4` | `3897.7` | `4103.1` | `25697` | `14` |
| 基线 (`b7b6ebf`) | `primarina-100-vs-mimikyu-100` | 未收敛 (time) | `[-0.9328, -0.2457]` | `0.6871` | — | `10125.4` | — | `100000` | `0` |
| 迭代 1 | `primarina-100-vs-mimikyu-100` | 未收敛 (time) | `[-0.6732, -0.1560]` | `0.5171` | — | `10001.0` | — | `93861` | `0` |
| 迭代 2 | `primarina-100-vs-mimikyu-100` | 未收敛 (time) | `[-0.5356, -0.3672]` | `0.1684` | `206.4` | `10000.6` | `10207.0` | `100000` | `0` |
| 迭代 3 | `primarina-100-vs-mimikyu-100` | **达标** | `[-0.441693, -0.421940]` | `0.019754` | `205.4` | `5173.4` | `5378.8` | `37954` | `1256` |

### 4.2 3× 冷进程复现性验证（`node dist/src/champions-benchmark.js <id>`）

| 局面 | Run | 状态 | `[L, U]` | prepare (ms) | search (ms) | total (ms) | nodes |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| `primarina-100-vs-archaludon-100` | 1 | `within-budget` | `[0.651011, 0.669934]` | `217.5` | `4161.4` | `4391.8` | `25697` |
| `primarina-100-vs-archaludon-100` | 2 | `within-budget` | `[0.651011, 0.669934]` | `208.8` | `3990.6` | `4211.8` | `25697` |
| `primarina-100-vs-archaludon-100` | 3 | `within-budget` | `[0.651011, 0.669934]` | `222.1` | `3998.2` | `4233.1` | `25697` |
| `primarina-100-vs-mimikyu-100` | 1 | `within-budget` | `[-0.441693, -0.421940]` | `217.9` | `5537.3` | `5767.5` | `37954` |
| `primarina-100-vs-mimikyu-100` | 2 | `within-budget` | `[-0.441693, -0.421940]` | `216.1` | `5385.3` | `5614.0` | `37954` |
| `primarina-100-vs-mimikyu-100` | 3 | `within-budget` | `[-0.441693, -0.421940]` | `209.2` | `5459.8` | `5681.5` | `37954` |

### 4.3 历史 54 项全量与标准局面回归

- **历史 54 项 Champions Singles Top-10**：**54/54 `within-budget`**，0 未收敛、0 error、0 watchdog。54 项累计 `prepare=12091.1ms`、`search=13425.2ms`、`total=26218.6ms`；最慢两项即满血西狮海壬（`5596.9ms` 与 `3570.2ms`），其余 52 项全部 `< 650ms`。
- **标准 `src/cases.ts` 9 项**：**9/9 收敛**，全部与离散非矩形参考区间重叠（`suckerPunchOHKOTwoHKOGame`：`search=2334.8ms`，`[0.62494, 0.64307]`，严格落于离散参考 `[0.62470, 0.64460]` 内）。
- **功能与健全性测试**：新增 [test/monotone-bounds.test.ts](../../test/monotone-bounds.test.ts)；`npm run typecheck`、`npm run build`、全量 `284/284` 测试通过（2 vCPU 下 `--test-concurrency=4` 时 `async-bounded-solver.test.js` 两条限时 worker 用例因 CPU 争抢超时，单并发复跑 `8/8` 通过）。

## 5. 后续待处理项

- 扫描全部 252 项（含新解锁的 4 只 Mega 精灵）时达标 **223/252**，但发现 8 动作 Mega 矩阵在 `src/matrix-game.ts` 单纯形求解器中存在既有退化数值误差（如 `garchomp-100-vs-gyarados-25`、`primarina-100-vs-gyarados-100`、`archaludon-50-vs-metagross-100` 触发 `Invalid equilibrium certificate` / `Positive-cover LP is unbounded`），且部分 Mega 对局（主要涉及 Mega 快龙）仍超过 10 秒预算；这些属于 Mega 扩展后的后续议题。
