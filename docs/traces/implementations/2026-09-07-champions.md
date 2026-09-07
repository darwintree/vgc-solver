# Implementation Trace: Champions 使用率实例

Date: 2026-09-07
Source: 用户要求单打前十、最高使用率配置、原生满 PP、独立三档血量、bounded 0.02 / 10 秒；允许跳过不支持内容。
Language: 中文

## Entries

### 1. 数据不完整和 Mega 行动

Type: interpretation

Context: 当前数据生成于 2026-09-03；魔幻假面喵、河马兽只有第 6–10 名招式，最新日期快照也没有补全魔幻假面喵。Gyarados、Delphox、Dragonite、Metagross 的首选道具为 Mega 石；仓库 legalActions 只生成普通 move 命令。

Decision: 保留原始前十，不用第十一名补位；缺少前四招式或需要尚未实现的 Mega 行动时跳过相关对局并记录原因。不使用低使用率配置替代。

Reason: 避免把错误配置、无法发动的核心机制当成用户要求的样本。

Follow-up: 后续可以补全数据或支持 Mega 行动后复测。

### 2. Champions 能力点移植

Type: interpretation

Context: 网站提供 stat_points 而不是 EV/IV；仓库固定 Gen 9 custom game，没有 Champions mod。

Decision: 等级 50，IV 全 31；能力点 p 换成 p=0 时 0 EV，否则 8p−4 EV。按 Gen 9 公式，这使性格修正前能力值比零 EV 增加 p。网站各类别独立取第一名，不把边际最高项声称为联合最常用完整配招。HP 为 floor(maxhp×比例)，至少 1，满 PP，回合一行动前设置 HP。

Reason: 保持网站能力点效果；某些 66 点配置对应 EV 总和大于 510，只用于 custom game 的等效数值实例，不能声称是合法 Gen 9 排位队伍或完整 Champions 规则复刻。HP 设置发生在初始入场效果之后，其他状态保留原生初始状态。

Follow-up: None.

### 3. 测量环境与硬停止

Type: tradeoff

Context: 用户没有指定 workers、预热次数；bounded 在单次转移结束后才检查预算。

Decision: 同步 backend，workers=0，预热=0，每 case 一个全新子进程及一个正式样本，串行运行；搜索预算 10000 ms，独立 30000 ms 进程 watchdog。仅 converged 且实际 searchMs≤10000 计为达标。进程启动不计入 fixture/prepare/search/total；total 从 fixture 创建开始。watchdog 不伪造区间和精确耗时。运行错误单独列出，不混作证明未收敛。

Reason: 隔离失控转移，避免缓存跨 case 复用与并行测试争抢资源。此结果描述冷进程单样本筛查，不外推成常驻多 worker 性能。

Follow-up: None.

### 4. 以代表性输入建立后续优化集合

Type: interpretation

Context: 用户明确本轮目标是寻找 test case 构建 benchmark，提出未收敛与拿不到结果两个方向，并要求记录实验、推荐代表性 case；没有指定选例数目和排序。

Decision: 新增独立选例文档，建议四个目标（窄区间、较多展开、低血量困难、watchdog）与两个仅改变 HP 的已达标对照。另列满血压力、根区间未缩小及数值边界项。已交付的原始测量保持不变，不在本次实施优化或重跑性能扫描。

Reason: 用较小集合覆盖不同观测行为，并保留全量 54 项作为阶段回归，避免仅按最慢项或同一配对选样。统计只能支撑选例，不能代替根因诊断；原始宽度 0.020000000054120726 的样本应单独处理。

Follow-up: 建议集合待后续优化任务采用；正式比较前重复复现。
