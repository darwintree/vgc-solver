# 游戏见解与可扩展搜索：部分改善与停止交付

本轮目标是固定 Champions 快照全部 54 项受支持 case，在原生满 PP、同步 workers=0、冷进程、10 秒 search、0.02 区间宽度下收敛。351 项不支持／缺失输入仍跳过。标准 fixture 与完整功能测试另作回归。用户随后要求结束已启动的一轮测量、停止继续探索并创建 PR；54/54 目标未达成。本记录保留已验证改进、负结果和停止的候选，不把部分改善写成目标完成。

## 交付状态

基线为 **29/54**；首次无提示组合 `682e043` 为 **49/54**。随后 `73fe8b6`（prepared／概率／反伤安全包络候选）的全量初步筛查为 **50/54**，仍有4项未达标。这个结果属于该候选的一次冷进程筛查，不能代替最终 PR 版本验收，也不能把组合收益分摊给某个单独优化。**最终代码为 `a5a116c`，已包含累计概率数值修复并通过typecheck/build与65项focused测试；完整功能套件和最终全量筛查仍待确认，逐项时间与区间暂不落定。**

初步剩余项是西狮海壬50／铝钢桥龙100、西狮海壬100／铝钢桥龙100、西狮海壬100／谜拟丘50、西狮海壬100／谜拟丘100；最终列表以修复后完整筛查为准。所有版本保持原生最大 PP（含 PP Up）、同步 workers=0、无预热、每例新进程、10,000 ms search 预算和0.02区间宽度。prepare、search、total 分开记录；总耗时包括准备与 fixture 创建，不能把 search 限额称为端到端10秒保证。

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

采样提示不是 OHKO／2HKO 概率证书：它使用同一隔离原生局面进行最多两回合的单次随机路线，可能误判换招、未命中及要害。调度提示不进入价值 backup。诊断曾怀疑完整提示矩阵超过 200 ms 被丢弃；[实际诊断](data/game-insight-search-2026-09-08/hints-c-diagnostic.json)显示首个 16 格矩阵约 47 ms 完成，多层均有提示，否定该原因。另一已确认交互是 sticky `autoJoint` 使后续 joint 选择绕过提示；后续交替候选也未产生可采纳收益，未进入交付。

渐进转移保持完整回合重放，按随机前缀概率优先分批计算，不是回合中途暂停／恢复框架。已完成后继质量按实际概率计入上下界；未完成质量 `r` 贡献 `[-r,r]`，不能按已完成部分重新归一化。取消必须恢复当前前缀的剩余质量。原生游标不复用 PP 模板，重复 PP 局面可能退化；最终功能与标准 fixture 验收单独记录。

## 首次组合全量筛查

`682e043be168876afc8ffa70baf9445edd2a1a1b` 组合渐进转移、模拟器等价合并、受限终局包络及审计／概率数值修复，未采用采样提示。按上述固定口径单次全量测得 **49/54 达标**，相比基线新增 20 项，基线 29 项无回退；351 skipped，0 error/watchdog。[原始结果](data/game-insight-search-2026-09-08/validated-682e043.jsonl)保留逐项 prepare/search/total、区间、PP 和统计。该版本仍有5项未达标，不能视为最终目标完成。

| 未达标项（双方 HP%） | 该版本返回区间 | prepare / search / total（ms） |
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

`7be204d` 将“继续随机枚举的剩余不确定性”与所有可展开后继的概率加权宽度之和比较，替代与最大单个后继比较；端点计算不变。46 项 focused 测试通过。[五项串行单样本](data/game-insight-search-2026-09-08/probability-sum.jsonl)中，铝钢桥龙 100／谜拟丘 100 于 9162.45 ms 达标，西狮海壬 100／谜拟丘 50 宽度改善，但另三项宽度退化；当前不全量采纳。特别是“总不确定性更多”不代表单位时间能消除更多不确定性，后续诊断转向实际转移与后继证明成本。

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

对 Encore 后继进一步显式使用 joint，也在 194 ms 内得到接近 +1 的证书，否定“joint 本身不能证明这条路线”的假设；因此未实施局部切换选择模式。随后检验了根重新选点造成的计算分散和共享行动执行，结果如下；这些候选均未进入已采用的调度。

## 后续消融与未采用方案

| 候选 | 正确性与机制证据 | 完整搜索结论 |
| --- | --- | --- |
| `cd04183` 受限伤害范围端点 | Typecheck/build及28项包络／原生区间测试通过；固定暴击分支的单调性允许只计算两个roll端点 | 满血陆鲨／铝钢桥龙配对样本3517.5→2863.8ms；该局包络探测虽无成功证书，开销下降。不可把其他局偶然达标归因于端点；[消融摘要](data/game-insight-search-2026-09-08/envelope-endpoints-summary.md) |
| `333ddcc` 按当前暴露工作量调整joint分数 | 39项focused测试通过；普通joint轮次保留服务，所有界不变 | 剩余5项无新增收敛，满血西狮海壬／谜拟丘更差；[结果](data/game-insight-search-2026-09-08/proof-cost-summary.md) |
| `644e35f` 25ms合作式局部证明 | 38项focused测试通过，根deadline每步检查 | 5项无新增收敛；目标Encore后继仍仅7次访问，第一个昂贵cursor批次耗尽量子；[结果](data/game-insight-search-2026-09-08/proof-burst-summary.md)、[逐项数据](data/game-insight-search-2026-09-08/proof-burst.jsonl) |
| `4ca7d80` 按剩余预算和根不确定性份额保留证明 | 39项focused测试通过；局部／全局交替，份额钳制为[0,1] | 先到的无关义务占住唯一槽位，目标即使取得55–99%份额也没有局部服务；两次中间诊断均失败，因此未再跑5项。未采用；[诊断](data/game-insight-search-2026-09-08/proof-credit-summary.md) |
| `abfe802`→`9a276bb`→`4f75d2d` 行动边界checkpoint | 最后版本28项focused测试通过；固定1725次重放的完整分布相同，减少重复捕获后攻击转移约15%改善 | 最后版本5个困难项全部未收敛，额外prepare约0.3秒；微基准收益不代表完整搜索改善。未采用；[摘要](data/game-insight-search-2026-09-08/action-checkpoint-prefix-summary.md)、[逐项数据](data/game-insight-search-2026-09-08/action-checkpoint-prefix.jsonl) |
| `328e31b` prepared概率包络 | 29项包络测试通过；一次准备供同节点多个行动组合复用 | 独立版本仍未解决两个西狮海壬／铝钢桥龙项，不能单独采纳；它是后续反伤候选的底座，[摘要](data/game-insight-search-2026-09-08/prepared-envelope-summary.md) |
| `73fe8b6` 反伤安全后继包络 | focused原生证书通过；准入放宽不绕过反伤或剩余未知质量 | 配对样本铝钢桥龙／谜拟丘10秒未收敛→4.05秒收敛，其余困难项混合。随后全量初筛50/54；最终修复版验收待确认。[配对摘要](data/game-insight-search-2026-09-08/recoil-envelope-summary.md)、[数据](data/game-insight-search-2026-09-08/recoil-envelope-paired.jsonl) |

上述生命宝珠／画皮随机等价、渐进质量保留和受限证书与候选提示／缓存／调度必须分开看。提示、SUM分配、工作量分数、burst、单槽credit及checkpoint没有因功能测试通过而自动进入生产代码。较早概率／prepared包络独立负结果也不能直接替代后续组合的正确性与性能验收。

用户提供的[PokaiTrainer研究](pokaitrainer-research-2026-09-08.md)作为方法参考；其中“当前实现”指研究时的 `51acee3`。论文原生分叉、共享计算和成本感知搜索没有被当作本项目的已验证加速比。这里的部分质量证书与所有性能结论来自本地实现和测量。后续[PokeGauge源码研究](pokegauge-research-2026-09-08.md)仅记录同阶段状态聚合与条件分布复用的边界，没有替换本项目转移引擎，也没有运行新的性能实验。

## 正确性修复与最终验收

已完成的必要修复包括：已完成与剩余概率统一归一化；包络回调同时匹配事件槽与函数身份；有效属性数量／addedType守卫；固定捕获Dex属性与免疫查询身份。它们见前述审查表，不能为性能回退到带有已知证明缺口的版本。

最终复审发现，`dc8b03b` 按每批当前总质量归一化仍不能保证不同累计批次之间的单调证书安全：后续完成批次的允许总质量可能不同。`48f5f23` 改为未完成批次用允许的最大总质量 `1+1e-9` 缩放已完成概率，将全部残余留为未知；完成批次才按实际总质量归一化。这样早期区间包含所有被合同允许的最终归一化结果。该修复及组合准入守卫进入最终代码 `a5a116c`，不能省略为仅有吞吐收益的版本。

最终代码已通过typecheck/build及[65项focused测试](data/game-insight-search-2026-09-08/pr-integrated-focused.log)。完整功能套件、标准fixture回归和54项完整扫描尚待验收证据。本文不把 `73fe8b6` 的初步50/54转写为最终PR成绩；最终确认后补入实际剩余项的区间与prepare/search/total，并保留error/watchdog/skipped计数。

## 已停止的工作

- `602a658` 在当前 `682e043` 底座的六行独立消融：只有未提交源码、原测试及说明，未运行typecheck/build、测试或原生测量；不作为已验证改动交付。
- chance后继工作债务：只有设计trace，无生产代码、测试、构建或性能执行。
- 局部auto／joint切换：独立joint已在194ms证明Encore子局面，假设被否定，没有实现。
- retained-credit仲裁、更多共享HP／回合内执行，以及进一步参数扫掠：未继续实施。

停止原因是用户明确要求收尾并创建PR，不是54项全部达成，也不是已证明不存在更好的通用算法。后续问题保留为记录；本轮交付不自动启动新一轮探索。

## 补充证据索引

- 原生局面与逐格诊断：[游戏见解分析](data/game-insight-search-2026-09-08/primarina-game-insights.md)、[Mimikyu逐格数据](data/game-insight-search-2026-09-08/primarina-mimikyu-uncertainty.json)、[Archaludon逐格数据](data/game-insight-search-2026-09-08/primarina-archaludon-uncertainty.json)、[诊断脚本](data/game-insight-search-2026-09-08/proof-uncertainty-diagnostic.cjs)。
- Encore模式对照：[显式joint结果](data/game-insight-search-2026-09-08/encore-child-joint.json)、[独立子局面脚本](data/game-insight-search-2026-09-08/encore-child-diagnostic.cjs)。
- checkpoint历史验收：[初版六项结果](data/game-insight-search-2026-09-08/action-checkpoints.jsonl)、[初版focused日志](data/game-insight-search-2026-09-08/action-checkpoints-validation-final.log)、[原生区间日志](data/game-insight-search-2026-09-08/action-checkpoints-certificates.log)、[最后版本focused日志](data/game-insight-search-2026-09-08/action-checkpoint-prefix-validation.log)。
- 其他消融：[伤害端点配对数据](data/game-insight-search-2026-09-08/envelope-paired.jsonl)、[工作量调度focused日志](data/game-insight-search-2026-09-08/proof-cost-validation.log)、[快照审查](data/game-insight-search-2026-09-08/review-snapshot.md)、[修正metadata后的快照对照](data/game-insight-search-2026-09-08/snapshot-paired-corrected.jsonl)。原快照结果误写workers/backend，已改用修正记录；未复制重复原件。
