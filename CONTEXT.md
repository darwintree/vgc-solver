# Pokémon 对战求解

本词汇表统一对战求解与优化讨论中的项目术语，并附紧凑引擎与诊断入口地图。

## Language

**游戏见解（Game Insight）**：
从玩家视角，依据对战局面、规则和双方可选行动，对获胜路线、关键威胁及应对关系形成的策略判断。游戏见解本身不等同于求解证明或安全剪枝证书。

**求解可扩展性（Solver Scalability）**：
在保持既定求解结果保证的条件下，求解器随对战过程延长、状态空间和行动空间增大，仍能在可用计算资源内提供结果的能力。

**可扩展性优化（Scalability Optimization）**：
以求解可扩展性为目标，包含瓶颈诊断、改进、验证和结果记录的一轮算法工程工作。

**精确求解（Exact Solver，`Solver` / `AsyncSolver`）**：
基于 `@pkmn/sim` 转移计算完整根收益矩阵与精确极小极大值，无近似误差。

**有界求解（Bounded Solver，`BoundedSolver` / `AsyncBoundedSolver`）**：
随时区间搜索，维护围绕极小极大值的安全证书 `[lowerBound, upperBound]`；仅在 `upperBound - lowerBound <= tolerance` 时标记 `converged: true`，仅在全部可达结果精确闭合时标记 `exact: true`。

**紧凑引擎（Compact Engine，`src/engine/*`）**：
零序列化单趟分支对战引擎，对齐 `@pkmn/mods/champions`（`@pkmn/sim@0.11.0`）精确分布（`TVD < 1e-8`）；在 `engine: 'auto'` 下通过 `canRunInEngine(battle)`（非 Champions 格式另需原生规则审计）自动准入。

**`optTraits`**：
与招式 / 道具 / 特性表并置的穷尽式 fail-closed 优化元信息（`MoveOptimizationTraits`、`ItemOptimizationTraits`、`AbilityOptimizationTraits`）。新增任何 `MoveSpecialKind`、`ItemArchetype` 或 `AbilityEffectFields` 字段在分类前都会在 `tsc --noEmit` 阶段报错。

**`FeatureBit`**：
`StaticBattleContext.featureMask` 上的读驱动位掩码，仅当对局中存在实际读取对应字段的机制时，才将该历史/场地字段（如 `HAZARDS`、`LAST_MOVE_FAILED`、`SIDE0_LAST_MOVE_IDX`）纳入 `canonicalStateKey`。

**`MonotoneBoxOutcome`**：
紧凑引擎适配器在 1v1 HP 单调轴上以 `hpOutputMode: 'distributional'` 返回的区间 HP 矩形结果；由最差/最优角点界定 `[lower, upper]`，仅在需要收窄时按需调用 `split()` 二分细化。

**PP 模板缓存（PP-Template Cache，`src/engine/adapter.ts`）**：
1v1 单打精确转移缓存：按 `canonicalStateKey(ctx, state, undefined, /* maskPp */ true)`（`PP >= 3` 归桶为 `+`，`0/1/2` 保留原值）缓存单回合转移模板，命中时按恒定 PP 差值实例化；存在非线性 PP 机制（`leppa-berry`、`spite`、`transform`、`imposter`、`instruct`、`copycat`、`sleep-talk`）时自动 fail-closed 关闭。

**Champions 快照（`fixtures/champions/`）**：
固定单打 Top-10 使用率快照（`2026-09` 已补全 405/405 可玩，`2026-11` 405/405 可玩）。对局 ID 按快照内规范排名顺序命名：`<p1Id>-<hp1>-vs-<p2Id>-<hp2>`（使用基础种 ID，如 `garchomp-100-vs-hippowdon-100`、`basculegion-100-vs-salamence-100`）。

相关原则见[项目方向与优化原则](docs/architecture.md#项目方向与优化原则)。

## Compact Engine Module Map

| File | Responsibility | Key Entry Points |
| --- | --- | --- |
| `src/engine/types.ts` | 核心状态/上下文类型、`FeatureBit`、`*OptimizationTraits` | `DynamicState`, `StaticBattleContext` |
| `src/engine/context.ts` | 对局准入（`SUPPORTED_VOLATILES`）、静态编译、`featureMask` 与死能力阶级分析 | `canRunInEngine(battle)`, `compileContextFromBattle(battle)` |
| `src/engine/state.ts` | 状态抽取、深拷贝、合法行动、规范状态键（`maskActiveHp`, `maskPp`） | `stateFromBattle(ctx, battle)`, `canonicalStateKey(ctx, state, maskHp?, maskPp?)` |
| `src/engine/adapter.ts` | `BoundedAdapter` 桥接、1v1 HP 单调性分析、`MonotoneBoxOutcome`、PP 模板缓存 | `createEngineBoundedAdapter(battle)`, `createMonotoneAnalyzer(ctx)` |
| `src/engine/turn.ts` | 单趟分支回合结算（~6.4k 行）：伤害/阈值（~1850–2650）、招式执行（~2950–5370）、回合末结算（~5950–6125）、`stepBattle` 编排（~6200–6450） | `stepBattle(ctx, state, p1Action, p2Action, policy)` |
| `src/engine/effects/moves.ts` | 招式特判与 Dex 编译、穷尽式 `MOVE_KIND_TRAITS` | `compileMoveSpec`, `isMoveSupported` |
| `src/engine/effects/abilities.ts` | 特性表、穷尽式 `ABILITY_FLAG_CLASS` → `optTraits` | `compileAbilitySpec`, `isAbilitySupported` |
| `src/engine/effects/items.ts` | 道具族编译器、穷尽式 `ITEM_ARCHETYPE_TRAITS` | `compileItemSpec` |
| `src/engine/coverage.ts` | `@pkmn/mods/champions` 实时覆盖率 + 机械 Dex 语义一致性审计（`--strict`） | `auditChampionsCoverage()` |
| `src/engine/parity.ts` | Showdown 与紧凑引擎精确分布对照 | `compareTurnWithShowdown(battle, p1Cmd, p2Cmd)`（返回 `exactMatch`, `totalVariationDistance`, `maxProbDiff`, `missingFromEngine`, `extraInEngine`） |

## Key Solver & Diagnostic Entry Points

- `src/bounded-solver.ts`: `BoundedSearch` / `BoundedSolver`（`_selectFrontier`, `_refresh`, `_backupFrom`, `_propagateMonotone`）。
- `src/matrix-game.ts`: 精确零和矩阵求解器（迭代弱支配消元 `reduceDominated` + 单纯形/顶点枚举回退）。
- `src/champions-cases.ts`: `championsCases(snapshotId: '2026-09' | '2026-11')`、`createChampionsBattle(fixture)`。
- `scripts/inspect-case.mjs`: 单局 `--matrix` / `--profile` / `--parity` 诊断脚本。
- `scripts/champions-ci-sweep.mjs`: 独立冷进程扫测脚本（`--scope`, `--snapshot`, `--failed-from`, `--search-ms`, `--shard`, `--resume`）。
