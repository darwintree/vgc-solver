# 消除无作用的事件工作

## 方法：先证明没有观察者，再省掉查询与随机排序

模拟器的通用事件系统要寻找回调、收集目标、按优先级排序并分发。残局里大量事件没有处理者；即使结果为空，查询和同速排序仍可能花时间，排序还可能产生随机分支。

当前方法不是缓存上一次事件结果，而是建立“可能有回调”的保守集合。集合可以多报，不能漏报：判定“不可能有处理者”才能跳过；判定“可能存在”继续原生查询；遇到未知规则也继续原生路径。每次 solve 重建规则定义索引，避免跨次求解复用已经改变的回调布局。

动态状态发生变化后重新组合候选集合；同一状态中的重复查询通过标量／引用指纹复用集合。集合的作用是证明空，不是替代非空事件的原生顺序。

## 例子一：无天气回调也不能跳过 Update

考虑一个所有 active 均没有 Weather handler 的回合：

1. 规则索引与当前效果集合证明 Weather 为空，或逐个 active 的原生查询全部为空。
2. 因为没有回调消费目标顺序，不需要为了 Weather 收集和随机排序整批目标。
3. 但原生 Gen 7 及以后 Weather 分发还会递归触发 Update。当前优化保留这一步；Update 若存在处理者，仍按原生流程执行。

“Weather 没有效果”只证明可以删除 Weather 的空工作，不证明调用它的整个函数都无作用。类似地，若第一个目标的回调可能给第二个目标新增 handler，就不能只跳过第二个目标的初始空列表；只要整批中有任意 handler，保留整批原生处理。

索引还必须覆盖不同前缀：某效果含 `onAnyDamage` 时，`Damage` 查询也应视为可能非空，不能仅索引字面上的 `AnyDamage`。

## 例子二：两个独立到期状态不需要随机排列

设两个存活的 Pokémon 各有一个 duration=1 的临时状态；两状态均没有 Residual callback、没有 onEnd、没有 linkedPokemon，结束行为仅为原生移除自身 volatile，且队列中没有待结算濒死。

执行 A 后 B，或 B 后 A，都只是把两个独立计时器减至零并移除对应状态；没有回调能观察中间顺序。若原本排序在它们之间掷骰，这个骰子对完整后继没有影响，可以采用确定性次序。即使两个独立状态属于同一只 Pokémon，只要状态身份与 volatile 槽位不同，也不必按持有者身份强行拒绝。

这与跳过结算不同：duration 仍递减，状态仍移除，只省去无意义的顺序随机性。若增加 onEnd、关联状态、濒死副作用等，交换执行不再有证明，整次排序回到原生。当前只替换 Residual handler 列表的首次排序；嵌套和后续排序仍用原生行为。

## 正确性边界与推广

事件空集证明与可交换执行证明是两种不同方法：前者没有工作需要执行，后者仍有工作但顺序不可观察。都必须审计真实依赖链，而不能只检查最外层方法名称。动态未知效果、被覆盖的事件方法或异常递归深度会阻止相应捷径。

概念适用于更大队伍与双打，但参与效果越多，越难证明为空或独立，命中率可能下降。已有显式双打转移对照不代表完整双打求解已经可用。

## 实现与证据索引

- [event-plan.js](../../src/event-plan.js)：`createEventPlan`、`hasPossibleEvent`；[empty-events.js](../../src/empty-events.js)：整批空分发及可信 wrapper 身份。
- [residual-optimization.js](../../src/residual-optimization.js)：`isIndependentDurationHandler`、`installResidualOptimization`。
- 验证：[event-plan.test.js](../../test/event-plan.test.js)、[empty-events.test.js](../../test/empty-events.test.js)、[residual-optimization.test.js](../../test/residual-optimization.test.js)。
- 历史：[满 PP 优化](../optimization-records/full-pp-optimization.md)、[满 PP 决策](../optimization-records/traces/2026-09-06-sucker-punch-full-pp.md)。
