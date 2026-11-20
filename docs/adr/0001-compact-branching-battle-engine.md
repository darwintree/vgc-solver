# ADR 0001: 紧凑单遍分叉对战计算引擎

- 状态：Accepted
- 日期：2026-11-20

## 背景

此前求解器直接将 `@pkmn/sim` 运行时 `Battle` 对象作为搜索状态机，每次随机分支重放都要执行 `Battle.fromJSON()` → `makeChoices()` → `battle.toJSON()` → `canonicalizeSnapshot()` → `JSON.stringify()`。

CPU 采样（`prim-mimi`、`prim-arch`）表明，约 45%–52% 的总求解时间花在序列化、反序列化、深拷贝、状态键构造和 GC 上；同时，`@pkmn/sim` 快照中保留了大量只对少数机制有效的历史与协议字段，既增大了单状态体积，也人为分裂了搜索图中的等价状态。

参考 [PokaiTrainer (arXiv:2608.29197v1)](https://arxiv.org/html/2608.29197v1) 中 PokaiEngine 的设计思路，并结合本项目对**精确/可认证安全区间**及未来扩展至**完整单打与双打**的要求，决定独立构建一套通用紧凑对战计算引擎（`src/engine/`）。

## 决策

1. **TypeScript 先行，面向未来可移植的扁平数据模型**：
   - 先用 TypeScript 实现，便于与现有求解器及 `@pkmn/sim` 差分对拍无缝集成；状态与编译数据保持扁平、整型化，避免嵌套动态对象与热路径字符串查表，为后续按需迁往 Rust 保留清晰边界。

2. **静态配置与动态状态彻底分离 + 规则依赖掩码（`FeatureMask`）**：
   - `StaticBattleContext` 在建局时编译一次、只读共享，绝不跨分支拷贝（包含物种、实数能力、招式/特性/道具整型元数据及 `FeatureMask`）。
   - `DynamicState` 仅保存演进所需的最小动态状态（场域、双边、槽位、HP/PP/状态/能力等级/挥发性状态、决策阶段），不存日志、请求对象、PRNG 内部状态或无关历史字段。
   - 仅当 `FeatureMask` 表明本局存在读取者时，才追踪并将 `lastMove` 等历史字段纳入状态键，消除假分裂。

3. **通用单双打拓扑与可暂停回合阶段**：
   - 从设计之初支持单打（1 active）与双打（2 active）、1–6 只队伍、主动换人、倒下补位以及 pivot 招式（如 U-turn / Volt Switch）引发的回合中途暂停（`phase.kind === 'switch'` 携带未结算队列）。

4. **单遍分支批推进（`BranchBatch`）+ 回合内 HP 分布（`HpDist`）+ 跨分支批共享**：
   - 回合主循环直接推进带权状态批次，遇到随机事件就地分叉并在步骤末按规范化哈希合并，彻底告别从回合起点重放随机前缀。
   - 伤害 16 档乱数在回合内默认留在目标的稀疏 `HpDist` 中，仅在跨过行为阈值（KO、Focus Sash、Sitrus Berry、1/3 血线特性、Disguise 等）时拆分；当攻击方与受击方 HP 存在联合相关性时显式保持联合准确，不错误相乘边缘分布。
   - 同一行动步骤对共享相同伤害/命中签名的分支批量计算一次，再广播应用。

5. **同一内核统一三种模式，以 `@pkmn/sim` 为真值 Oracle 与回退**：
   - `compute`：单时间线 RNG 采样；
   - `certified`：精确枚举或按预算合作式停止，未展开质量显式归入 `remainingMass`，直接满足 `BoundedSolver` 安全区间合同；
   - `pruned`：按 `minProb` / `maxBranches` 剪枝的快速近似模式；
   - 回合边界输出支持 `discrete`（精确/有界纳什默认）与 `distributional`（跨回合保留 `HpDist`）切换；
   - 建局通过严格白名单 `canRunInEngine(battle)` 准入，未覆盖机制透明回退 `@pkmn/sim`，并用自动化差分测试校验完整离散分布与 `@pkmn/sim` 100% 一致。

6. **以 Pokémon Champions 官方规则为基线，面向不定期规则迭代的数据驱动架构**：
   - 上游真值源升级至官方 `@pkmn/sim@0.11.0` + `@pkmn/mods@0.11.0`（内含 `champions` 与 `championsregmb` 规则模组）。
   - **规则参数外置**（`src/engine/ruleset.ts`）：Champions 与 Gen 9 的核心机制差异（麻痹 1/8 vs 1/4、睡眠 `[2,3,3]` vs `[2,3,4]`、冰冻 1/4 + 最多 3 回合、戏法空间 `-speed`、Mega 进化开关、破盾倍率 0.25×、治愈之心 50% 等）集中配置在 `RulesetConfig` 中，不散落硬编码。
   - **数据驱动编译器**（`src/engine/effects/`）：
     - 物种（含 Mega 形态与体重）、实数能力（通过 `battle.spreadModify` 直接复用 Champions Stat Points 公式）、全部 81+ Mega 石与 328+ 纯数据招式全部直接从 Dex 编译，后续新 Regulation 新增物种 / Mega / 常规招式时**零代码改动自动接入**。
     - 特性与特殊招式按原型家族（Archetype）声明式注册，不写逐 ID 面条代码。
   - **活体覆盖率审计器**（`npm run engine:coverage`，`src/engine/coverage.ts`）：每次升级 `@pkmn/sim` / `@pkmn/mods` 后运行一次即可实时列出新增未覆盖物种、Mega、道具、特性与招式，按需补齐原型 hook 并通过 `test/engine-champions.test.ts` 与官方 mod 做全分布差分对拍。

## 后果

- 正面：消除 `@pkmn/sim` 序列化/恢复瓶颈与前缀重放开销；缩小搜索状态键与内存占用；天然具备单双打、换人、Mega 进化、中途暂停与近似/精确双模切换能力；规则迭代仅需“升级依赖 → 跑覆盖率审计 → 补差量 hook → 对拍验证”。
- 权衡：需要维护引擎规则实现与固定版本 `@pkmn/sim@0.11.0` + `@pkmn/mods@0.11.0` 的精确对拍测试集；尚未实现的少量冷门/变形/复制机制在准入阶段透明回退 `@pkmn/sim`。
