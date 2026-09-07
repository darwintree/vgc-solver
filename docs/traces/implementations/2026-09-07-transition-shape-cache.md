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

### 2. 固定事件方法身份检查

Type: unresolved-implementation-decision

Context:
U1 的 CPU profile 将 `isNativeEventMethod` 列为事件路径的高频自耗时；现有实现每次检查都枚举固定的 native 方法名并调用通用按名比较。来源要求保留被替换方法的回退，但没有规定检查的具体表达方式。

Decision:
保留所有原有方法身份和第九世代守卫，改用固定字段的直接比较；`findEventHandlers` 继续通过现有 wrapper-aware 检查允许事件计划包装器。移除仅用于逐名枚举的辅助函数。

Reason:
比较集合完全由本模块的固定 `nativeMethods` 常量决定，直接比较与逐名 `every` 具有相同的接受集合和回退条件，同时减少事件热路径上的函数调用和临时键枚举。该改动不缓存可变状态，也不改变事件计划或模拟器行为。

Follow-up: None

### 3. 传递紧邻的事件计划判定

Type: unresolved-implementation-decision

Context:
CPU profile 与调用路径显示，`hasNoEventHandlers` 在计划判断为 possible 后，立即调用被 event plan wrapper 包装的 `findEventHandlers`；wrapper 又重新运行同一个 `hasPossibleEvent` 和 fingerprint 检查。来源没有指定这两个边界之间如何共享已经完成的判定。

Decision:
在 event plan 模块内用按 Battle 身份的 WeakMap 保存一次性 pending 判定，并由已注册的同一个 `findEventHandlers` wrapper 消费；如果 wrapper 身份、plan 或 event 名称不匹配，则继续原有完整检查。只记录 possible=true 的同步紧邻调用，false 仍由上层直接返回，unknown 仍走原生查询。

Reason:
该 token 只跨越同一同步调用边界，不把判定缓存到后续状态，也不放宽 native 方法守卫；方法被替换时注册检查会清理 pending token，wrapper 不匹配时回退原路径。事件计划测试断言正向查询只计一次，同时完整原生分布和事件测试保持通过。

Follow-up: None

### 4. 撤销紧邻事件判定复用

Type: tradeoff

Context:
相邻事件判定复用已在独立 guard 消融中测量三次：固定 guard 为 `4354/4296/4303ms`，加 PP shape 为 `4250/4239/4233ms`，再加 adjacent token 为 `4334/4356/4301ms`。新增 WeakMap/token 复杂度没有显示稳定收益。

Decision:
移除 pending event check 与 wrapper registration 接口、相关测试和 wrapper 消费逻辑，恢复事件计划的原有同步查询路径；保留固定 native method guard 与 PP shape cache。

Reason:
该候选没有达到稳定收益证据门槛，删除其接口和测试可让代码保持与实测收益一致。事件计划仍保留原有 fingerprint、unknown fallback 和 native handler wrapper 守卫。

Follow-up: None
