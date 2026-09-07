# Implementation Trace: 转移槽位形状缓存

Date: 2026-09-07
Source: 用户要求分析并优化转移／计算模块的重复成本；`src/showdown-adapter.ts` 与 `src/pp-transition-cache.ts`
Language: 中文

## Entries

### 1. 按快照身份缓存 PP 槽位形状

Type: unresolved-implementation-decision

Context:
同一个搜索状态会为每个行动组合调用 `enumerateTurn`。PP cache 已按快照身份缓存 `baseKey`，但每次调用仍重新计算 `slotShape(snapshot)`；该计算只读取快照中的队伍和招式槽位结构。来源没有规定是否可以复用这项派生数据。

Decision:
在每个 solve-scoped `PPTransitionCache` 中增加按快照对象身份的槽位形状缓存；缓存只保存 `slotShape` 的字符串结果，不改变 PP 模板键、槽位内容或回退条件。没有 PP cache 时继续使用原有直接计算路径。

Reason:
搜索期间快照按约定不被修改，且 `slotShape` 是纯派生值。将缓存限制在已有的 solve-scoped cache 和对象身份上，不跨求解、规则或快照序列化边界共享数据，因此不会把不同状态或不同规则误判为相同形状。该优化可由同一状态的多个行动组合是否减少重复形状遍历来验证；若收益不足，行为仍与原路径一致。

Follow-up: None
