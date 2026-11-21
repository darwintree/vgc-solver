# VGC `<= 3v3` 残局可扩展性优化记录（Steps 1–3）

- 日期：2026-11-20
- 基线提交：`798bb02`（含 `cf43c22` 通用优化与 PR #2 Champions 60 场实战录像数据集；Node.js 24 LTS，2 vCPU）
- 目标：在保持 1v1 历史 54 集无回归（`10s, tol = 0.02`）与严格 `[L, U]` 安全区间、完整行动维度、`@pkmn/sim@0.11.0` 规则真值的前提下，打通并大幅加速 Pokémon Champions VGC `<= 3v3` 完全信息残局（每方至多 1 只替补，距终局 2–3 回合，目标预算 `30s, tol = 0.04`）。

## 诊断证据

基于 PR #2 中 30 场 Bo3 OTS 双打录像（1581–1792 Elo，`30/30` 含 `|showteam|`），在 `rem = 2`（`finalTurn - 1`）共提取 20 个完全信息 `<= 3v3` 残局（覆盖 `1v2 / 1v3 / 2v1 / 2v2 / 2v3 / 3v1 / 3v2 / 3v3`），全部通过 `canRunInEngine(battle) === true`。基线探测暴露 5 个具体瓶颈：

1. **双打合法目标膨胀**（`src/engine/state.ts`, `src/engine/effects/moves.ts`）：`legalSlotActions` 对 `2v1` 倒下空槽生成冗余目标（`+2`），将 `adjacentAlly`（`Helping Hand` / `Coaching`）误映射为可指向对手，`adjacentFoe` / `scripted` / `allies` / `allyTeam` 也存在非法或多余扇出。
2. **`16^4 = 65,536` 离散 HP 爆炸与 V8 栈溢出**（`src/engine/turn.ts`, `src/engine/adapter.ts`）：`createMonotoneAnalyzer` 仅限 `1v1` 启用，双打被迫走 `hpOutputMode: 'discrete'`，单回合峰值超过 65,536 个离散状态并在 `finalizeOutcomes`（`expanded.push(...arr)`）触发 `RangeError: Maximum call stack size exceeded`；且 `distributional` 模式仅 `~1.0–2.5 ms/turn`（比 `discrete` 快 `10×`）。
3. **单替补强制换人冗余节点**（`src/engine/adapter.ts`）：`3v2 / 3v3` 每回合产生 `0.9–2.1` 个 `phase.kind === 'switch'` 结局；仅剩 1 只替补时为 100% 确定性 `1×1` 换人，却打断 `HpDist` 压缩并生成大量冗余 `1×1` 搜索层。
4. **大矩阵 `fullyUnknown` 深度 1 锁死与 `O(M×N)` 调度开销**（`src/bounded-solver.ts`）：在 `48×60` 至 `142×64` 矩阵上，`fullyUnknown` 强制在根节点先展开全部数千至上万格才下探 Turn 2（3 秒内 `_init = 1`），且 `_selectFrontier` 与 `_refresh` 每次迭代重复分配 `.map()` 数组与全矩阵扫描（占 45%–57% CPU）。
5. **双打行动顺序与大矩阵方向/局部陷落**（`src/engine/adapter.ts`, `src/bounded-solver.ts`）：招式 0 为 `Protect` 或失效 `Fake Out` 时，搜索在根格 `[0, 0]` 陷入深层拖延子树；`1v2 / 1v3` 负值局中 `atUpperCeiling && atLowerFloor` 单边锁死 `lowerProof`；次优高下界行（如 90% 命中招式）在 `optFloor < 1` 时过早切换或长期遮蔽可闭合容差的 100% 必胜行。

## 实施的通用优化与正确性边界

### Step 1 — 引擎基础修复与确定性强制换人内联（`src/engine/types.ts`, `src/engine/effects/moves.ts`, `src/engine/state.ts`, `src/engine/turn.ts`, `src/engine/adapter.ts`）
- **精确目标合法性**：在 `MoveTargetType` / `mapTargetType` 中区分 `adjacentAlly`、`adjacentFoe`、`scripted` 与 `allies`/`allyTeam`，并在 `legalSlotActions` 中跳过已倒下对手槽位、严格按 `@pkmn/sim` `validTargetLoc` / `chooseMove` 规则生成合法目标。
- **消除离散展开栈溢出**：`finalizeOutcomes` 将 `expanded.push(...expandStateHpDists(ws))` 改为显式循环。
- **确定性 `1×1` 强制换人内联**（`resolveForcedSwitches`）：在 `createEngineBoundedAdapter` 中，对 `phase.kind === 'switch'` 且双方均只有 1 个合法行动的后继立即调用 `stepBattle` 展开并合并；`stepBattle` 自身保持暂停语义不变，不破坏 `@pkmn/sim` 对拍合同。正确性依据：对任意 `1×1` 节点 $V(s) = \sum_{s'} P(s' \mid s, a^*, b^*) V(s')$ 精确等价。
- **双打规则化行动排序**（`doublesActionOrderScore`）：保留全部合法行动维度，仅按通用规则排序（对敌进攻/先制/范围技优先 → 辅助/强化 → 守住/换人 → 必定失败招式如非首回合 `Fake Out` → 攻击队友排最后）。

### Step 2 — 多宝可梦 N 维 HP 单调矩形与惰性非单调盒（`src/engine/adapter.ts`, `src/engine/state.ts`）
- **多宝可梦 HP 单调性审计**（`createMonotoneAnalyzer`）：推广 `isPokeHpMonotone(state, side, pokeIdx, hp)` 至任意单双打/多精灵对局，严格 fail-closed 守卫所有多精灵反例：
  - 若本方仍有存活替补（`aliveBench > 0`），直接禁止（防范低 HP 主动送死换取免费无伤上场反例）；
  - 若存活队友携带 `allAdjacent` 伤害技（如 `Earthquake` / `Surf`），禁止（防范倒下导致范围伤害系数 `0.75× → 1.0×` 跃升反例）；
  - 若存活队友携带 KO 增益机制（`Last Respects` / `Fell Stinger` / `Moxie` / `Supreme Overlord` / `Battle Bond`）或自身携带 `Fairy Aura`，禁止；
  - 若存活对手携带吸血技（本方存活 `> 1` 时）或反伤技配 HP 阈值触发器或 `unsafe-target` / `Shell Bell`，禁止；
  - 保留原有 `Sitrus Berry`、激流/猛火、`Berserk`、`Emergency Exit`（仅 `aliveBench === 0` 安全）及治疗可达性检查。
  - 在多精灵搜索树进入 `1v1` 残余子博弈时，通过 `canonicalStateKey` 指定索引掩码自动复用二维单调前沿缓存。
- **通用 N 维 `MonotoneBoxOutcome`**（`makeMultiBoxOrSingleton`）：默认全程以 `hpOutputMode: 'distributional'` 运行 `stepBattle`；单调轴取精确最坏/最好角点构造紧密安全界，大乘积非单调轴以 `lowerSnapshot = upperSnapshot = null`（贡献安全 `[-1, +1]`）惰性二分，避免任何 `16^4` 预展开爆炸。

### Step 3 — 大矩阵 `BoundedSolver` 加速与调度改进（`src/bounded-solver.ts`）
- **精确 Double-Oracle（活跃子矩阵 LP）**：在 `solveMatrixFast` 中对 `M > 12` 或 `N > 12` 的大矩阵采用迭代最优回应子矩阵求解（热启动上一解支撑集），通过全局最优回应检验确保返回完整 `M×N` 矩阵的精确极小极大均衡。
- **`O(M+N)` 增量缓存轴统计与稀疏支撑选择**：在 `SearchNode` 上缓存 `populatedCells`、就地复用的 `lowerMatrix`/`upperMatrix`、增量维护的 `rowFloor / rowOptFloor / rowLowerSum / colCeil / colOptCeil / colUpperSum / rowOpaqueProbes / colOpaqueProbes`，并在 `chooseJoint` / `chooseJointUnexpanded` 优先遍历正支撑对 `|supp1| × |supp2|`，将 `_selectFrontier` 耗时降低 `3.8–4.0×`、整体扩展吞吐提升 `1.7–2.8×`。
- **大矩阵深度探索、双边交替、容差闭合优先与渐进拓宽**（仅对 `M×N > 25` 生效，1v1 路径不变）：
  - 打破 `fullyUnknown` 与零支撑 `preferUnexpanded` 导致的根节点深度 1 锁死；
  - 双边未定（`[-1, +1]`）时立即可交替探索上下界，并在存在可闭合容差的替代行/列时避免过早单边锁死；
  - 优先选择 `optFloor >= upper - tol`（或 `optCeil <= lower + tol`）的可闭合行/列，并对持续不透明格按 `cell.probes` 轮转渐进拓宽（避免陷入单格 `Protect` / 拖延子树）。

## 测量结果

### 1. VGC `<= 3v3` 实战残局（`scripts/vgc-endgame-bench.mjs --rem 2 --max-ms 3000 --tol 0.04`，全部 20 局，同步 compact 引擎）

- **收敛率（3 秒短预算）**：基线 `1/20`（`2v2/3v2/3v3` 栈溢出或 `_init = 1` 锁死） → **Steps 1–3 后 `7/20`**（总 search 降至 `41.13s`，0 崩溃、0 跳过）。
- 典型提速对比（同为 `rem = 2, tol = 0.04`）：

| 录像 ID | 阵型 | 矩阵 | 基线（3s） | 优化后（3s） | 备注 |
| --- | --- | --- | --- | --- | --- |
| `2704565612` | `2v1` | `42×7` | `765.9 ms` (`YES`) | **`4.1 ms` (`YES`)** | **187× 提速** |
| `2699713547` | `1v3` | `7×55` | `3000 ms` `[-1, 1]` | **`4.9 ms` (`YES`)** | `[-1.0000, -0.9973]` |
| `2700990654` | `1v2` | `8×30` | — | **`12.0 ms` (`YES`)** | `[-1.0000, -1.0000]` |
| `2701017094` | `3v1` | `41×7` | `3000 ms` `[-0.45, 1]` | **`243.8 ms` (`YES`)** | `[0.9606, 1.0000]` |
| `2704624028` | `3v1` | `47×7` | — | **`248.2 ms` (`YES`)** | `[0.9629, 1.0000]` |
| `2700284144` | `2v2` | `48×60` | 栈溢出 / 锁死 | **`259.4 ms` (`YES`)** | 首个实测收敛 VGC `2v2`（`[0.9696, 1.0000]`） |
| `2704411887` | `1v2` | `7×36` | `3000 ms` `[-1, -0.80]` | **`1332.6 ms` (`YES`)** | `[-1.0000, -0.9926]` |
| `2700392806` | `2v1` | `49×7` | `3000 ms` `[0.917, 1]` | `3001 ms` `[0.9515, 1]` | 宽度 `0.0485` |
| `2700880268` | `3v1` | `55×14` | `3000 ms` `[0.952, 1]` | `3000 ms` `[0.9325, 1]` | 宽度 `0.0675`（5s 曾达 `4.17s YES`） |
| `2698512543` | `2v2` | `72×120` | `3000 ms` `_init=1` | `3002 ms` `[-0.998, 0.354]` | 宽度 `2.00 → 1.35`（7,137 cells） |

### 2. 30 秒目标预算验证（`--rem 2 --max-ms 30000 --tol 0.04`，同步 compact 引擎，单样本冷进程，`workers=0`，默认 `maxNodes=100000`）

在 3 秒已收敛的 7 局基础上，对 6 个重点/近收敛局面运行 30 秒预算：

| 录像 ID | 阵型 | 矩阵 | Prepare | Search | Total | 收敛 | 区间 `[L, U]` | 宽度 | Nodes | Cells |
| --- | --- | --- | ---: | ---: | ---: | :---: | --- | ---: | ---: | ---: |
| `2700880268` | `3v1` | `55×14` | `2.9ms` | **`3833.8ms`** | `3837.0ms` | **YES** | `[0.9641, 1.0000]` | `0.0359` | `23257` | `15577` |
| `2700392806` | `2v1` | `49×7` | `2.5ms` | `30013.5ms` | `30016.2ms` | NO | `[0.9587, 1.0000]` | `0.0413` | `99021` | `89923` |
| `2700945124` | `1v2` | `5×56` | `2.8ms` | `30002.8ms` | `30005.8ms` | NO | `[-1.0000, -0.8499]` | `0.1501` | `100000` | `99934` |
| `2698512543` | `2v2` | `72×120` | `2.5ms` | `30002.1ms` | `30004.8ms` | NO | `[-0.9428, 0.0475]` | `0.9903` | `50464` | `58197` |
| `2700388082` | `2v2` | `80×100` | `2.6ms` | `30003.8ms` | `30006.6ms` | NO | `[-0.9594, 1.0000]` | `1.9594` | `100000` | `66377` |
| `2700441321` | `2v1` | `49×6` | `2.5ms` | `30000.9ms` | `30003.6ms` | NO | `[-1.0000, 1.0000]` | `2.0000` | `100000` | `110588` |

合计 **`rem = 2` 已确认 30 秒内至少 `8/20` 收敛**（含全部 `3/3` 的 `3v1`、`1/1` 的 `1v3`、`2/3` 的 `1v2`、`1/3` 的 `2v1`、`1/5` 的 `2v2`），且 `2700392806` 宽度已收窄至 `0.0413`（距 `0.04` 仅 `0.0013`），`2698512543`（`72×120` `2v2`）区间由 `2.00` 收窄至 `0.9903`。

### 3. 1v1 Champions 非回归检查（`tol = 0.02, maxSearchMs = 10000`，同步 compact 引擎）

增量 `axisStats` 与稀疏 `_refresh` 带来额外 1v1 收益，历史最慢项均显著提速且零回归：
- `2026-09 primarina-100-vs-mimikyu-100`：`2.01s → 1.64s`（`-18%`）
- `2026-09 primarina-100-vs-archaludon-100`：`3.6s → 2.68s`（`-26%`）
- `2026-09 garchomp-100-vs-archaludon-100`：`36.0ms → 5.5ms`（`6.5×`）
- `2026-09 archaludon-25-vs-mimikyu-100`：`130.7ms → 35.1ms`（`3.7×`）
- `2026-11 primarina-100-vs-mimikyu-100`：`4.05s → 2.60s`（`-36%`）
- `2026-11 primarina-100-vs-archaludon-100`：`3.5s → 2.48s`（`-29%`）

## 正确性验证与未解决项

### 正确性验证
- 新增 `test/engine-vgc-endgame.test.ts`（5 项）：覆盖双打目标合法性、多精灵 HP 单调性准入与全部 fail-closed 反例守卫、2v1 多精灵单调盒与离散 oracle 区间一致性、确定性 `1×1` 强制换人等价性与 `stepBattle` 暂停合同、以及 30×30 混合博弈 Double-Oracle 与精确 LP 一致性。
- 全量验证（`npm run typecheck`、`npm run build`、`npm run engine:coverage:strict`、`npm run test:engine`、`npm run test:native`、`npm run test:async`）结果见交付汇报。

### 尚未解决的阻塞与下一步方向
1. **高分支 `2v2 / 3v2 / 3v3` 的跨回合组合爆炸**：当回合 1 无立刻 KO 且双方均有 `60–120` 合法双打动作时，验证纯策略仍需覆盖全部 `60–120` 对手回应（其中 ~50% 为攻击队友、另含大量等效提前倒下分支）；后续可探索基于状态/动作等价性的安全转移复用（例如先手必 KO 槽位时复用同一受击方行动组的转移结果）与多核并行转移。
2. **默认 `maxNodes = 100,000` 上限在 30 秒 VGC 搜索中被打满**：`2700945124`、`2700388082`、`2700441321` 在 30 秒内均触及 `100,000` 节点上限（`2700392806` 达 `99,021` 节点）；且 `2700945124` 中 `Last Respects` 禁用队友单调性导致大量离散节点分裂。后续需提高/动态化 VGC 节点预算并增加更精细的局部状态去重/单调化（如绝对不致死区间的受限单调）。
3. **有替补侧（`aliveBench > 0`）的非单调 HP 展开**：`3v2 / 3v3` 中有替补一侧的 HP 因免费换人反例保持 fail-closed，导致该侧多目标伤害仍需按需二分。
4. **带 `Protect` + `Sucker Punch` 的多回合心理博弈**（如 `2700441321`）：在 `2v1` 下因 `Protect` 必然拖入下一回合及 `Last Respects` 禁用队友单调性，30 秒内仍打满 `100,000` 节点。
