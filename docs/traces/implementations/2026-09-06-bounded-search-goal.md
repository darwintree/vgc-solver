# Implementation Trace: 满 PP 扩展局面的性能目标

Date: 2026-09-06
Source: 用户要求 case 3 搜索少于 2 秒，case 4/5 各少于 5 秒，可使用通用剪枝与一定程度的近似；由 meta agent 设计、luna-high 实现、meta agent 验证。追加运行 4 小时停止条件。
Language: 中文

## Entries

### 1. 近似误差验收

Type: unresolved-implementation-decision

Context: 用户允许一定不精确性，由实现方把控程度。

Decision: 初始验收要求返回可证明的零和效用区间 [L,U]，宽度不超过 0.02；返回中点时效用误差不超过 0.01，若无平局则胜率误差不超过 0.005（0.5 个百分点）。存在平局时 (V+1)/2 表示胜加半平得分，不能直接称纯胜率。策略分别由下界矩阵的最大化方与上界矩阵的最小化方给出，并报告安全收益界；不把近似矩阵伪装成精确矩阵。

Reason: 将近似误差显式化，允许对任意局面的未知后继使用 [-1,1]，不依赖特定物种、招式或残局公式。

Follow-up: 检查区间是否覆盖可独立算出的精确案例，并区分未收敛结果与达标结果。

### 2. 精确接口与探索隔离

Type: tradeoff

Context: 现有求解器的完整根节点矩阵及精确策略被回归测试依赖；新增近似返回合同不同。

Decision: 优先新增独立有界求解入口，保留既有精确接口；精确调度改进与资源抽象实验在 /tmp 独立副本进行，确认正确性与收益后再集成。每次计时重建求解器、memo 和 PP 缓存，排除固定初始化但计入状态复制、模拟、通信、动态索引和证书维护成本。

Reason: 避免静默降低既有精确语义，也避免将目标答案缓存或局面预计算算作固定开销。

Follow-up: 在最终方案确定后补充公开入口和验证记录。

### 3. 四小时硬截止

Type: interpretation

Context: 用户追加“运行时间达到 4 小时”作为停止条件，未另外指定起算点。

Decision: 从本轮 goal 启动时间计时：2026-09-06 23:53:20 +08:00 开始，2026-09-07 03:53:20 +08:00 为硬截止；到点停止新实验并汇总已完成及未达标项目。

Reason: 包含此前已经花费的本轮探索时间，避免通过重新起算延长用户预算。

Follow-up: 每轮验收检查时钟，临近截止停止启动长实验。

### 4. 初版性能报告复核

Type: tradeoff

Context: 子 agent 交付报告称 "Case3 converges in ~0.36s"，但未提供该数字的满 PP 命令证据。

Decision: 不将该数字作为验收结果。主 agent 从 suckerPunchCoverageGame 创建局面，打印验证 PP=[8,32,16]/[16,56,8]，独立运行得到 searchMs=4680.148、661 个展开状态、9496 次模拟、区间 [0.62776763165,0.64773119249]。要求子 agent 核对来源，继续优化按需生成行动组合。

Reason: 验收必须同时满足指定输入、精度和真实搜索计时，不能混用缩小测试局面数据。

Follow-up: 最终使用独占 CPU 的预热后多次复测。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Case3 converges in ~0.36s | 满 PP case3 性能报告 | Grounded=false（未指出代码缺陷）；Accurate=false（当前独立复测不支持此耗时）；Material=true（会影响性能验收）；Owned=true | Effective=true；Complexity justified=true；Semantic fit=true；Verifiable=true | clarify | 主 agent 满 PP 复测 searchMs=4680.148；历史 probe-initial.jsonl 亦为 4.6–4.9 秒；报告数字来源待子 agent 说明。 |

### 5. Exact async backend label

Type: triage

Context: Read-only review found that `AsyncTransitionSolver` fallback paths return `OneVsOneSolver` results without a backend field, while normal exact async results expose finite `prepareMs`/`searchMs` only.

Decision: Bounded benchmark runs require explicit `result.backend` metadata. Exact benchmark runs preserve the existing finite-timing fallback convention until the exact async owner adds explicit backend metadata; no pool-dispatch inference is used.

Reason: A zero-budget bounded worker solve may dispatch no jobs while still using the worker backend, so dispatch counts cannot distinguish worker from fallback.

Evidence: `src/async-solver.js:115-131` returns synchronous fallback results without `backend`; `src/async-solver.js:410-417` stores normal exact results without `backend`; bounded async results set `backend` explicitly at `src/async-bounded-solver.js:167`.

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Async exact fallback may be mislabeled | benchmark backend reporting | Grounded=true; Accurate=true; Material=true; Owned=true | Bounded metadata required; exact legacy timing fallback retained pending owner field | fix | Focused `test/benchmark.test.js` covers exact worker/fallback, sync, and bounded zero-budget worker labels. |

### 6. One adaptive bounded policy

Type: implementation-decision

Context: Full-PP case3, case4, and case5 reached the width target with one numeric policy that starts from pure security proofs and switches to joint frontier selection when the root lower or upper matrix is detectably mixed.

Decision: Expose `auto` as the bounded benchmark default; retain `security` and `joint` as explicit diagnostics. The policy uses only matrix values and security bounds, with no fixture, species, move, or action-name branching.

Reason: A single generic configuration keeps the benchmark contract stable across current fixtures and future supported action sets while preserving explicit controls for diagnosis.

Evidence: Isolated full-PP adaptive probe with `tolerance=.02`, `maxSearchMs=20000`, `lazyCells=false`: case3 width `0.01996356` (661 expanded states), case4 width `0.0187500003` (3 expanded states), case5 width `0.0187500004` (6 expanded states); PP remained fixture maximum in all three.
