# Implementation Trace: 通用求解性能探索

Date: 2026-09-06
Source: 用户要求由 meta agent 指挥 gpt-5.6-luna high 子代理，尽力优化现有用例，并验证更广泛对局的适用性。
Language: 中文

## Entries

### 1. 优化的语义与验证边界

Type: interpretation

Context:
用户允许剪枝，但未指定近似误差或改变对外结果的方式。当前仓库为 private demo，可见调用方在仓库内；当前动作生成尚未支持完整队伍或双打。

Decision:
保留有限随机分布与均衡求解语义，不引入采样、招式专用公式或未经证明的状态合并。内部可采用价值证书剪枝；对外根结果仍提供完整收益矩阵及策略。用显式换人和双打动作验证转移层，不能据此宣称完整 solver 已支持这些模式。

Reason:
将底层优化的通用性与尚未实现的玩法接口区分开，避免为当前用例作无效的扩展承诺。

Follow-up:
具体剪枝和模拟器优化需经独立差分与性能验收后才能合并。

### 2. 隔离实现与串行验收

Type: tradeoff

Context:
主仓库已有跨轮次未提交修改；用户允许多个 worktree 并发探索，但没有要求必须使用 Git worktree。

Decision:
保存当前代码至 /tmp/pokemon-meta-baseline，各子代理使用独立 /tmp 副本实现。主代理检查候选源码，串行测量并按文件合并，不创建提交或变动现有 Git 历史。

Reason:
隔离副本保留当前未提交基线，避免并发修改冲突及计时相互干扰。

Follow-up:
最终记录采纳和拒绝的路径、数值验证结果及未解决的规模边界。

### 3. 随机分支就地继续

Type: unresolved-implementation-decision

Context:
未知随机调用原先通过异常退回枚举器，再为全部候选恢复整个 Battle。用户没有约束内部 PRNG 接口。

Decision:
新增未知随机调用回调：将其它候选的概率和决定前缀入栈，当前候选在当前模拟中继续。克隆共享决定记录并保持独立游标；原来的异常模式保留为测试对照。

Reason:
这是对同一有限随机树的不同遍历方式，减少中间节点重放，不改变叶节点概率。共享记录避免同一游标的克隆错误地抽取独立随机数。

Follow-up:
主代理用固定输入快照比较六类完整分布，结果一致。不同随机请求形状的克隆仍会显式报告 replay divergence，不假定已支持底层 PRNG 的所有用法。

### 4. 空事件消除的保守边界

Type: tradeoff

Context:
Showdown eachEvent 在寻找目标回调之前先随机解决同速顺序；即使所有目标均无回调也会扩大随机树。改写模拟器事件机制可能影响 mod 或天气递归。

Decision:
仅在枚举器恢复的单个 Battle 实例上安装空事件优化。限第九世代、原生事件和查询方法；运行时方法被替换则回退。仅所有 active 都无 handler 才跳过整批事件。Weather 保留原生路径，eventDepth 达到原有上限时保留错误。

Reason:
无回调的整批事件没有可改变战斗状态的处理程序；不对有回调事件的交换性作假设，不删除快照字段，不修改全局 prototype 或用户初始对局的固定种子运行过程。

Follow-up:
正式实现通过全量原有测试、方法覆盖与天气递归测试，以及固定输入快照的六类完整分布差分。

### 5. 子状态价值证书与根结果

Type: unresolved-implementation-decision

Context:
递归调用只读取子状态 value，但原实现为每个子状态求出完整矩阵。剪枝后无法再无条件返回完整矩阵。

Decision:
根始终求完整矩阵；子状态允许缓存仅 value 的结果。完整一行所有随机结果都严格为 +1 时证明必胜；完整行的最小值与对应完整列的最大值相等时证明纯鞍点。没有证书则补齐矩阵并求 LP。value-only 状态以后被作为根求解时补全结果，不重复计入已解状态数。

Reason:
利用零和矩阵的可证明上下界，保留根接口并避免把未知收益伪装成已计算值。没有使用概率阈值或近似相等来决定剪枝。

Follow-up:
主代理独立生成 100 个递归随机状态图，与完整求解对照根矩阵及所有访问状态价值，检查通过。已增加缓存升级、稀有失败、鞍点成功和失败的回归测试。

### 6. 矩阵规模与数值回退

Type: tradeoff

Context:
原 LP 求解器枚举约束组合，动作数增大时成本迅速增长；新 simplex 原型在主代理的近重复行测试中两次出现数值证书失败。

Decision:
用正移位、尺度归一化后的 primal simplex 求解，利用最终基重新计算 primal 与 dual，校验原收益矩阵的双边收益保证。数值失败时仅允许每个维度不超过 6 的矩阵使用有界枚举回退；大矩阵明确报错。不会把未通过证书的中间结果当作均衡返回。

Reason:
大幅改善较多动作下的常见计算成本，同时保留小残局的数值稳健性。simplex 不被描述为具有多项式最坏复杂度；浮点证书仍有明确数值容差。

Follow-up:
主代理完成 625 个离散 2×2 输入以及 500 个近重复矩阵的三种尺度检查。实际数值保证与规模限制需保留在性能文档中。

### 7. 模拟器内部随机结果合并

Type: unresolved-implementation-decision

Context:
原生副作用逻辑枚举 100 个整数但只观察一次阈值比较；原生伤害 randomizer 的 16 个 roll 也可能返回相同整数。

Decision:
在已审计的原生方法处按可观察结果合并桶概率。小数 chance 使用相同整数桶阈值；不服从原先无关的 forceRandomChance；未知类型仅回退当前比较，不重跑整个函数。伤害 mapper 必须纯且以 baseDamage 区分 replay key，自定义截断函数回退原生。

Reason:
这保留该调用返回结果的完整分布，不依赖特定招式或忽略后续事件。主代理审查时发现并修复了强制概率开关、循环中整体回退重复执行、旧世代 undefined chance 等问题。

Follow-up:
通过原生完整分布对照，包括小数阈值、自降能力和真实两次命中的 Double Kick。

### 8. 空 Weather 的递归语义

Type: tradeoff

Context:
第 4 项的初版为了保守而保留所有 Weather 调用的原生排序；审计后确认空 Weather 仍可跳过排序，但不能省略其 Update 递归。

Decision:
最终版仅在整批 Weather 无 handler 时跳过排序和 dispatch，仍调用 Update；有 Weather handler、方法身份不匹配或达到深度上限时调用原生实现。

Reason:
在保留后继调用语义的条件下，移除仍然存在的无效随机分支。

Follow-up:
空 Weather、有 Update handler、有 Weather handler 和原生回退均已纳入测试。

### 9. 不合并没有完整求解收益的快照候选

Type: tradeoff

Context:
选择性复制 snapshot 的微基准改善明显，但完整求解三次测量未显示稳定收益。

Decision:
候选保留在隔离实验目录，不改变生产 snapshotBattle。完成所有已通过正确性及收益验收的候选后停止本轮探索。

Reason:
不为未证明的整体收益增加序列化契约假设。当前主要成本仍是模拟器事件处理和对象恢复；进一步改变这些行为需要新的语义证据。

Follow-up:
最终基准、回归证据及更大对局边界见 docs/optimization-records/general-performance.md。
