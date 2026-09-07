# 并行转移：并行执行，集中维护证明

## 方法：把可以独立完成的一回合交给 worker

给定同一快照和双方行动，一回合转移可独立枚举。当前把这项工作交给常驻 worker，主线程保留状态价值／区间、父子依赖与搜索选择权。这样并行化模拟器工作，而不用让多个线程同时修改同一份求解证明。

常驻池摊薄线程启动成本，批处理摊薄消息开销，路由亲和让相似行动组合更可能访问同一 worker 的 PP 模板。三者都不改变状态等价关系；路由提示不参与 memo 的正确性判断。

## 例子：3×3 行动矩阵分给三个 worker

假设某 bounded 前沿有三行三列行动，使用三个 worker。当前行优先路由编号为 `(i×列数+j) mod worker数`，编号从零开始：

| P1 行动 | P2 的 C | P2 的 D | P2 的 E |
| --- | --- | --- | --- |
| A | worker 0 | worker 1 | worker 2 |
| B | worker 0 | worker 1 | worker 2 |
| F | worker 0 | worker 1 | worker 2 |

主线程提交这九个独立任务，空闲 worker 从对应路由队列领取任务；队列中同路由任务可按批次合并传送。每个任务仍使用自己的快照重放。下一前沿若行动排序相同，对应格子倾向落到同一 worker，可能复用该 worker 在本次 solve 内建立的 PP 模板。

九个结果收齐后，主线程按原来的行列位置接收分布，并更新上下界。不能因为某个 worker 先返回好消息，就把尚未完成格子视为已知。本例的三 worker 与三列重合只是演示；实现可接受其他矩形大小，路由也不要求每列固定对应一个线程。

当前 exact 异步求解使用基于队伍形状与行动命令的路由提示，并维护进行中的状态求解及依赖关系，避免共享后继重复工作。bounded 使用上述行优先提示；两者不能混写成相同调度算法。

## 规则一致性比并行度更重要

worker 加载的是自己的模拟器规则。如果主线程修改了某物种的运行时数值或回调，worker 不能假装自己仍在求同一个游戏。当前每次求解检查原生方法与 stock profile；不一致时整次求解回退同步 backend，而不是仅关闭 PP cache 后继续派发。

每次 init-solve 重建 worker 的 PP 缓存与事件计划，主线程也重新建立求解状态。常驻的是线程和运行环境，不是上次局面的答案。池的占用、失败任务、退出和清理都需要明确处理；求解结束前要处理在途任务，避免污染下一次调用。

## 为什么更多 worker 不保证更快

收益上限受主线程串行工作、消息／快照传输、准备审计和最慢任务约束。整批同步等待时，一个昂贵转移可能让其它线程闲置；盲目提前搜索其他节点又可能增加对根证书无用的工作。

因此验收应测相同输入与误差下的完整收敛时间，并分列 poolReady、prepare、search 和 total，不能仅报告利用率或派发量。当前未采用跨节点流水；case 6 的相关候选没有形成足够的净收益证据。

独立转移的并行方法可用于未来单打与双打，但行动数量、快照大小和任务成本分布会改变最佳配置。既有 8／9 workers 是历史测量选择，不是对战规则或跨硬件承诺。

## 实现与证据索引

- [transition-pool.js](../../src/transition-pool.js)：生命周期、批处理与路由；[transition-worker.js](../../src/transition-worker.js)：每次求解初始化及转移执行。
- [async-solver.js](../../src/async-solver.js)、[async-bounded-solver.js](../../src/async-bounded-solver.js)：集中求解与并行转移的边界；[stock-rule-profile.js](../../src/stock-rule-profile.js)：跨线程规则一致性。
- 验证：[async-solver.test.js](../../test/async-solver.test.js)、[async-bounded-routing.test.js](../../test/async-bounded-routing.test.js)、[async-fallback.test.js](../../test/async-fallback.test.js)、[async-lifecycle.test.js](../../test/async-lifecycle.test.js)。
- 历史：[满 PP 正式测量](../optimization-records/full-pp-optimization.md)、[case 6 未采纳候选](../optimization-records/case6-performance.md)。
