# 游戏见解与可扩展搜索探索（进行中）

本轮目标是固定 Champions 快照全部 54 项受支持 case，在原生满 PP、同步 workers=0、冷进程、10 秒 search、0.02 区间宽度下收敛。351 项不支持／缺失输入仍跳过。标准 fixture 与完整功能测试另作回归。本记录是探索中证据，不是最终交付或性能承诺。

## 基线与测量

代码基线 `51acee3b214822d1a096dac52004c76acf39e95e`，Node 24.20.0、`@pkmn/sim` 0.10.11。全量重测仍为 29/54 达标、25 未达标、0 error/watchdog；[基线原始结果](data/game-insight-search-2026-09-08/baseline.jsonl)包含环境与全部 405 项。构建／测试和性能分开运行；各候选性能串行、每项新进程，探索期仅单样本，尚未重复验收。

候选测量使用[辅助脚本](data/game-insight-search-2026-09-08/run-cases.cjs)，参数为 worktree 绝对路径、输出 JSONL、case ID 列表；调用该版本已有的 Champions child 路径，预算、原生 PP、backend 不变。各 JSONL 首行记录准确提交、Node、CPU、命令；结果分开保存 fixture、prepare、search、total。部分候选工作树有下一候选的未提交源码，但测量时 HEAD 与已编译 dist 固定，未重新编译，不把后续源码纳入对应样本。

## 第一、二轮独立比较

| 方向／版本 | 观察 | 证据 |
| --- | --- | --- |
| `602a658` 非极值纯策略继续下降 | 两个残血陆鲨／满血铝钢桥龙仍为 `[-1,1]`；排序改变未绕过鳞射格 | [调度 A](data/game-insight-search-2026-09-08/scheduling-a.jsonl) |
| `13101b6` 原生两回合采样提示；`de1959b` 与调度 A 组合 | 初始四个困难项均未达标；组合满血陆鲨 search 8219.84 ms，仍为 34902 次重放 | [提示 A](data/game-insight-search-2026-09-08/hints-a.jsonl)、[组合 A](data/game-insight-search-2026-09-08/combined-a.jsonl) |
| `74cfe20` 放宽已证明不可观察原始伤害的事件阻断条件 | 满血陆鲨 search 从本轮基线 8347.99 ms 降至 1879.30 ms，重放 34902→4146；同为 405 展开状态／1620 转移，说明收益来自转移工作减少。只是单样本 | [模拟器 A](data/game-insight-search-2026-09-08/sim-a.jsonl) |
| `0ed0f1e` 限定不透明格兄弟探测为当前证明轴；`8e3d700` 用区间内提示选择非并列候选 | 困难项未达标。后续完整 bounded 测试发现无提示 adapter 的调度回归，不能直接交付这一无条件规则 | [提示 B](data/game-insight-search-2026-09-08/hints-b.jsonl)、[提示 C](data/game-insight-search-2026-09-08/hints-c.jsonl) |
| `091fe22` 渐进转移概率证书 | 陆鲨 25%／铝钢桥龙 100% 宽度约 0.048845；50%／100% 约 0.111632；均未达标，但已不再丢弃整格已计算质量 | [渐进转移 A](data/game-insight-search-2026-09-08/progressive-a.jsonl) |
| `188b53e` 叠加生命宝珠及失效画皮的审计合并 | 铝钢桥龙 100%／谜拟丘 100% 区间约 `[0.781064,0.990176]`，仍未达标；满血陆鲨约 1876.18 ms | [模拟器 C](data/game-insight-search-2026-09-08/sim-c.jsonl) |

采样提示不是 OHKO／2HKO 概率证书：它使用同一隔离原生局面进行最多两回合的单次随机路线，可能误判换招、未命中及要害。调度提示不进入价值 backup。诊断曾怀疑完整提示矩阵超过 200 ms 被丢弃；[实际诊断](data/game-insight-search-2026-09-08/hints-c-diagnostic.json)显示首个 16 格矩阵约 47 ms 完成，多层均有提示，否定该原因。另一已确认交互是 sticky `autoJoint` 使后续 joint 选择绕过提示；正在单独探索提示与 joint 的交替。

渐进转移保持完整回合重放，按随机前缀概率优先分批计算，不是回合中途暂停／恢复框架。已完成后继质量按实际概率计入上下界；未完成质量 `r` 贡献 `[-r,r]`，不能按已完成部分重新归一化。取消必须恢复当前前缀的剩余质量。当前独立候选未复用 PP 模板，标准 fixture 回归风险待验收。

## 首次组合全量筛查

`682e043be168876afc8ffa70baf9445edd2a1a1b` 组合渐进转移、模拟器等价合并、受限终局包络及审计／概率数值修复，未采用采样提示。按上述固定口径单次全量测得 **49/54 达标**，相比基线新增 20 项，基线 29 项无回退；351 skipped，0 error/watchdog。[原始结果](data/game-insight-search-2026-09-08/validated-682e043.jsonl)保留逐项 prepare/search/total、区间、PP 和统计。当前仍有 5 项未达标，目标尚未完成。

| 未达标项（双方 HP%） | 安全区间 | prepare / search / total（ms） |
| --- | --- | --- |
| 西狮海壬 50／铝钢桥龙 100 | `[-0.922135417,-0.875850287]` | 160.53 / 10000.43 / 10169.20 |
| 西狮海壬 100／铝钢桥龙 100 | `[-0.156876826,0.998652344]` | 160.51 / 10001.08 / 10169.89 |
| 西狮海壬 100／谜拟丘 50 | `[-0.506324226,-0.027657456]` | 161.68 / 10001.25 / 10172.00 |
| 西狮海壬 100／谜拟丘 100 | `[-0.986667897,0.374881271]` | 166.13 / 10001.38 / 10176.51 |
| 铝钢桥龙 100／谜拟丘 100 | `[0.749624055,0.803125000]` | 163.30 / 10000.77 / 10172.63 |

西狮海壬 100／铝钢桥龙 50 的 search 为 9876.24 ms，属于接近预算的单次达标，需重复验收。铝钢桥龙 100／谜拟丘 100 在较早无提示组合 `ed7a1bd` 单次曾于 8372.5 ms 达标，但本次未达标；不能把此前单样本视为稳定完成。

[joint 提示组合](data/game-insight-search-2026-09-08/joint-combined.jsonl)在所测困难项弱于[无提示渐进转移组合](data/game-insight-search-2026-09-08/progressive-sim.jsonl)，因此当前主候选不携带提示实现。[模拟器 D](data/game-insight-search-2026-09-08/sim-d.jsonl)与[初始终局包络](data/game-insight-search-2026-09-08/envelope-a.jsonl)是独立消融证据；后者的自定义回调审计漏洞已修复，不能单独交付初始版本。

## 审查处理

完整原评语保留在[渐进转移审查](data/game-insight-search-2026-09-08/review-progressive.md)、[终局包络审查](data/game-insight-search-2026-09-08/review-envelope.md)、[模拟器审查](data/game-insight-search-2026-09-08/review-sim.md)。下表保留各评语原始标题；其反例推导与限制以上述全文为准。T/F/U 分别为 true/false/unknown；评论项按 Grounded/Accurate/Reachable/Material/Owned，响应项按 Effective/Complexity justified/Semantic fit/Verifiable 排列。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| P2 — Partial mass accepted within the existing sum tolerance lacks equivalent numerical protection | partial transition backup | T/T/T/T/T | T/T/T/T | fix | `dc8b03b` 的 ±5e-10 质量漂移、正负效用反例在旧实现失败；对包含未知质量的整个分区统一归一化后通过，未对已完成部分单独条件化 |
| P1 — Callback admission loses the callback's event slot | terminal-envelope admission | T/T/T/T/T | T/T/T/T | fix | `1734cbc` 原生回调迁移反例复现攻击者回复后存活；准入改为事件槽与函数 identity 同时匹配，focused native oracle 通过 |
| P2 proof gap — Effective third types bypass the stated overflow bound | terminal-envelope damage bound | T/T/T/T/T | T/T/T/T | fix | `f803c31` 拒绝 addedType 并检查有效类型数；guard 与真实 Champions 证书测试通过。修复的是可达证明域缺口，未宣称复现 stock Champions 错值 |
| P2 — Capture the audited immunity implementation instead of comparing against the mutable prototype | simulator query audit | T/T/T/T/T | T/T/T/T | fix | `7f35491` 捕获 import-time Dex 查询 identity；无 PRNG 内省的原生状态修改反例复现 immunity 分布 12 对 1、effectiveness 分布 42 对 44，修复后全状态分布一致 |

## 第四轮调度消融

`7be204d` 将“继续随机枚举的剩余不确定性”与所有可展开后继的概率加权宽度之和比较，替代与最大单个后继比较；端点计算不变。46 项 focused 测试通过。[五项串行单样本](data/game-insight-search-2026-09-08/probability-sum.jsonl)中，铝钢桥龙 100／谜拟丘 100 于 9162.45 ms 达标，西狮海壬 100／谜拟丘 50 宽度改善，但另三项宽度退化；当前不全量采纳。特别是“总不确定性更多”不代表单位时间能消除更多不确定性，后续需定位实际转移与后继证明成本。

## 计算热点与功能回归

对 `682e043` 两个满血西狮海壬对局分别进行 Node CPU 采样，每个新进程、原生 PP、10 秒 search、0.02。采样有额外开销，不作为性能验收；[采样入口](data/game-insight-search-2026-09-08/profile-solver.cjs)与[归类脚本](data/game-insight-search-2026-09-08/summarize-profile.py)一并保存。复现时使用 `node --cpu-prof --cpu-prof-dir=OUTPUT_DIR PROFILE_SCRIPT WORKTREE CASE_ID`。归类为按栈匹配的粗粒度互斥估计，不是每个函数的精确计时。

| 满血对局 | restore | event | 其他 native | snapshot | key |
| --- | --- | --- | --- | --- | --- |
| 西狮海壬／谜拟丘 | 22.2% | 20.9% | 16.7% | 15.1% | 10.2% |
| 西狮海壬／铝钢桥龙 | 27.8% | 19.6% | 19.0% | 9.6% | 8.0% |

以上分母包括启动与 GC；原始 [Mimikyu profile](data/game-insight-search-2026-09-08/prim-mimi-682e043.cpuprofile)、[Archaludon profile](data/game-insight-search-2026-09-08/prim-arch-682e043.cpuprofile)及 [Mimikyu 汇总](data/game-insight-search-2026-09-08/prim-mimi-profile-summary.txt)、[Archaludon 汇总](data/game-insight-search-2026-09-08/prim-arch-profile-summary.txt)可复查。另按求解调用栈统计的比例存于 [Mimikyu solve 栈](data/game-insight-search-2026-09-08/profile-prim-mimi-solve-summary.txt)、[Archaludon solve 栈](data/game-insight-search-2026-09-08/profile-prim-arch-solve-summary.txt)，其分母排除了无可归属 JS 栈的 GC，勿混用。

独立的[证明负担诊断](data/game-insight-search-2026-09-08/proof-obligation-diagnostic-summary.md)显示约 94% search 花在转移／cursor，接受后继约 3.6–4.7%，backup 与选择合计不足 2%。大后继数本身不证明浪费；诊断按根的每个对手回应约束列出质量与未知区间。该证据支持转移吞吐优化，并提示需要结合实际证明成本选择工作，暂不支持“累计复制是主因”。

`682e043` 已完成 typecheck/build、相关 focused 测试及 `node --test --test-concurrency=4 dist/test/*.test.js`。[全量日志](data/game-insight-search-2026-09-08/validated-full-suite.log)记录 33 个测试文件中 32 个通过，唯一失败为 types 测试启动 TypeScript 子进程被沙箱 `spawnSync EPERM` 拦截；同一 `node --test dist/test/types.test.js` 提权运行通过。未为此修改代码或放宽类型断言。后续最终候选仍须重新完成相关验证。

## 概率包络与强制行动诊断

`792ff3e` 将原生单击暴击／伤害分布、命中率、Torrent HP 区域及回复果阈值组合为局部终局质量界。附加效果发生的质量保留未知；回复必胜质量使用先手 KO 概率上界的补集，避免重复认领概率。[33 项 focused 测试](data/game-insight-search-2026-09-08/probability-envelope-validation-final.log)通过，但[五项消融](data/game-insight-search-2026-09-08/probability-envelope.jsonl)未解决任一剩余 case：西狮海壬 50／铝钢桥龙 100 宽度退化至 0.15068，满血陆鲨／铝钢桥龙耗时增加至 3965 ms。额外证明计算未带来本轮收益，当前不采纳。

满血西狮海壬／谜拟丘的原生 Encore×Swords Dance 后继只有一个，下一回合合法维度为 4×1，Encore 剩余 duration=3。初始局面的 10 秒搜索仍把该后继留在约 `[-0.9417,1]`；[把同一后继独立作为根](data/game-insight-search-2026-09-08/encore-child-auto.json)，现有 auto 调度却在 191.5 ms 内得到 `[0.9892187497,1]`，使用 Moonblast 纯策略。[固定 P1 首行动对照](data/game-insight-search-2026-09-08/encore-child-policy.json)也得到同一区间，248.2 ms；这只是诊断，固定行动的上界不能移作完整游戏上界。证据支持“已存在便宜的证明，但全局调度未及时完成”，不支持另建重复的策略评估器。

## 共享计算与后续消融

| 候选 | 证据与取舍 |
| --- | --- |
| `2cc0f75` 融合原生编码与 JSON 规范化，后续元数据修正 `72a6f34` | [五项配对](data/game-insight-search-2026-09-08/snapshot-paired-corrected.jsonl)吞吐收益小且混合，没有新增收敛；[39 项 focused 验证](data/game-insight-search-2026-09-08/snapshot-validation-final.log)通过。当前保留为实验，计时对应 `2cc0f75`；修正版尚未重复计时。原记录 workers=1 是元数据笔误，实际入口直接运行同步 BoundedSolver，修正为 workers=0/backend=sync；原始文件也保留 |
| `333ddcc` joint 支持分数除以可见未完成工作数，与原始选择交替 | [五项测量](data/game-insight-search-2026-09-08/proof-cost.jsonl)无新增收敛，故不采用；估计工作数并不等于实际证明成本 |
| 终局包络损耗定位 | [满血陆鲨诊断](data/game-insight-search-2026-09-08/envelope-cost-baseline.json)的 6480 次尝试均无证书，耗时 1776 ms／总 search 3536 ms。后续测试受审计伤害范围的随机端点计算，而非无条件保留昂贵证明 |

对 Encore 后继进一步显式使用 joint，也在 194 ms 内得到接近 +1 的证书，否定“joint 本身不能证明这条路线”的假设；因此未实施局部切换选择模式。后续探索聚焦于根反复重新选点造成的计算分散，以及共享已经完成的行动执行。所有这些调度和缓存候选仍须保持完整概率、具体状态和原有安全区间。

## 待完成

`abfe802` 的完整行动结束 checkpoint 已通过[27 项 focused 验证](data/game-insight-search-2026-09-08/action-checkpoints-validation-final.log)及[原生区间证书测试](data/game-insight-search-2026-09-08/action-checkpoints-certificates.log)。[六项冷进程测量](data/game-insight-search-2026-09-08/action-checkpoints.jsonl)通过内部 executed/skipped 计数确认复用了已执行行动，但收益混合，未直接采纳。铝钢桥龙 100／谜拟丘 100 的 8753.8 ms 达标不能单独证明加速：此前其他版本／样本也曾在约 8.3–9.1 秒内达标。西狮海壬 100／谜拟丘 100 的区间反而更宽；保存 checkpoint 的成本与低复用率需要继续控制。

用户补充的 [PokaiTrainer 研究](pokaitrainer-research-2026-09-08.md)已纳入探索。该笔记的“当前实现”指其研究时的 `51acee3`，不能误读成这里的 `682e043`：部分转移保留已经实现，成本感知排序在实验；下一独立方向是受审计的共享计算与 HP 延迟展开。原研究没有性能验收数据，后续本地实验单独记录。

- 对提示／joint、渐进转移和模拟器候选进行组合及消融，剔除无收益的复杂度。
- 验证受限制的一回合终局区间证明，并检查 unsupported 状态回退。
- 继续优化剩余 5 项，完成目标重复测量、标准 fixture 回归及完整功能测试。
- 更新最终采用的技术文档、验收记录和剩余未达标项；当前不宣称目标达成。
