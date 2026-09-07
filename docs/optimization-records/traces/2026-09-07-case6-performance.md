# Implementation Trace: case 6 三秒目标

Date: 2026-09-07
Source: 用户要求优化 sucker-punch-6，目标 3s 内；优先通用优化。
Language: 中文

## Entries

### 1. 验收口径

Type: interpretation

Context: 用户未重新指定误差、PP 和 3 秒包含的阶段。

Decision: 沿用有界求解验收：原生满 PP、区间宽度不超过 0.02，常驻 worker pool 下 search 不超过 3000 ms；单列 prepare、total 和 pool 初始化成本。最终预热 3 次、正式 5 次，每次重建 battle、solver、memo 和 PP cache。

Reason: 与现有 benchmark 口径一致，不以缩减输入、放宽精度或混淆准备时间达标。

Follow-up: 如用户要求首次端到端 3 秒，需要按不同口径重新验收。

### 2. 基线与探索隔离

Type: tradeoff

Context: 当前已有未提交的项目文档；用户明确鼓励子代理通过 worktree 并行探索。当前机器还有浏览器等进程争抢 CPU，绝对耗时有波动。

Decision: 主工作区保留文档并负责验收，搜索策略、转移成本和异步流水调度分别在临时 worktree 探索。重型计时串行分配窗口；同时对比节点、转移、模拟次数，候选只有在正确且有净收益时集成。

Reason: 隔离候选修改并避免并发 benchmark 干扰，不将其他应用负载变化视为优化收益。

Evidence: Apple M2 Pro（10 逻辑 CPU、16 GiB）、Node v25.8.1，原版 8c36db9，满 PP、9 workers、batch8、lazyCells=false、auto、无预热单次完整收敛：search 19513.937542 ms，prepare 3850.08825 ms，total 23372.3695 ms；区间 [0.6273551937263693, 0.6469988344254585]，expandedStates=1123、transitionCalls=9834、simulatorRuns=35578、nodes=13768、ppCacheHits=5372。这是探索基线，不是正式多样本验收。

Follow-up: 候选集成后在主工作区独立复测。

### 3. 转移键生成成本

Type: tradeoff

Context: 原生转移路径对同一非终局快照重复调用 outcomeKey；PP key 先复制全部 JSON，而修改范围只有 move slot 的 PP；相对 effectOrder 序列化对每个属性调用 replacer。

Decision: 一次生成分支 key 并用于 outcome 与 PP template 聚合；PP key 仅复制待改路径；相对 effectOrder 仅复制计数器所在路径，然后调用无 replacer 的 JSON.stringify。保持快照、公开 key、原生审计和回退条件不变。

Reason: 在当前 JSON 快照边界内减少重复遍历与分配，不引入局面语义假设；适用于已有单打与双打转移层。

Follow-up: 独立测试及组合性能复测；不把单样本加速视为 3 秒达标。

主代理复核：180 个 native memo key 与原版逐字节一致；`node --test --test-concurrency=2 test/native-memo-key.test.js test/pp-transition-cache.test.js test/pp-cache-semantic.test.js test/snapshot-serialization.test.js test/bounded-stochastic.test.js` 通过 43 项。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| 最确定的收益证据是 Tackle/Tackle 分支 key 调用 **96→48**，完整分布及模拟次数不变。 | 转移缓存 key 复用 | Reasonable reading/Grounded/Accurate/Reachable/Material/Owned=true | Effective/Complexity justified/Semantic fit/Verifiable=true | fix | 原版在 outcome 聚合及 template 聚合各调用一次 outcomeKey；候选复用同一分支 key。主代理原生 Tackle/Tackle 与缓存重放完整分布对照、key 调用计数测试通过。 |

### 4. 不集成未证明有收益的调度候选

Type: tradeoff

Context: 子代理分别完成误差预算前沿、延后昂贵 cell 和流式异步调度的正确性检查及探索计时。

Decision: 本轮不集成这三类调度候选，不新增 selectionPolicy 或调度配置；实验仍隔离在临时 worktree。

Reason: 误差预算候选在 15 秒后区间仍宽约 0.164；延后单个昂贵 pair 的两次 15 秒结果宽约 0.645/0.656。流水候选 pending9 保留 route 时约 24.950 秒收敛、展开 2588 个节点；pending72 的 30 秒测量及移除 route 的 25 秒测量均未收敛。上述为子代理探索报告，不是主代理多样本验收；源代码复核确认这些方案会改变展开顺序及工作量，目前没有足够净收益证据支持增加维护成本。

Follow-up: 后续可研究避免无关展开的证明调度；不能以 worker 忙碌率、减少局部模拟次数或减少节点数单独判定优化成功。

### 5. 本轮验收结果

Type: tradeoff

Context: 三秒目标仍未实现，需要区分可交付的局部改进和未完成的性能目标。

Decision: 保留通过原生语义对照的键生成优化，如实记录 3 秒达标数为 0/5。主代理预热 3 次、正式 5 次的原版／新版 search 中位数为 30.892／23.656 秒，全部正式样本区间、策略、矩阵和非计时搜索统计一致。原始样本见 [case6-key-optimization.json](../data/case6-key-optimization.json)。

Reason: 本轮观测到约 23.4% 中位数耗时下降，但系统负载有波动，不能据此宣称固定倍率，更不能声称达到 3 秒。

Validation: 全量首次 148/149 通过，原有 5 秒收敛断言失败；单独复测该用例通过，未改预算；全量重跑 149/149 通过。10 个正式 benchmark 样本、文档链接及 git diff --check 验证通过。

Follow-up: 三秒性能目标未完成；后续需要新的、可验证的通用改进。
