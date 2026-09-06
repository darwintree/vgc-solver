# Implementation Trace: 求解性能优化

Date: 2026-09-06
Source: 用户要求优化求解效率，随后指定以四个招式均为 5 PP 的突袭局面为基准。
Language: 中文

## Entries

### 1. 终局分支只传递效用

Type: unresolved-implementation-decision

Context:
5 PP 基线约 6.33 秒，85 个已求解状态、7,384 次模拟器重放。
性能采样中 cloneJSON 占约 23%，状态键生成约 15%，另有状态序列化开销。
用户没有指定优化手段。仓库为 private Demo，enumerateTurn 的已知生产代码消费者仅为 solver.js。

Decision:
保留公开求解结果与完整随机分支枚举。内部转移结果改为两种互斥形式：
未结束分支 `{snapshot, probability}`；终局分支 `{utility, probability}`。
相同终局效用合并概率，求解器直接使用效用，不再序列化、恢复和缓存终局快照。
默认局面和回归测试同步使用用户指定的 5 PP，并添加独立 benchmark 命令。

Reason:
终局没有后续决策，效用足以决定期望收益。消除冗余表示和处理，不近似概率，也不依赖突袭局面的特殊规则。
内部接口尚无已知外部消费者，直接更新唯一调用方；对外 solve 结果结构不变，统计计数可能因终局不进入缓存而变化。

Follow-up:
验证终局概率合并、混合终局／非终局转移、快照隔离及原有局面回归，并记录优化前后基准。

### 2. 第二轮只复制反序列化会保留的引用

Type: tradeoff

Context:
用户要求继续优化。阅读固定依赖 `@pkmn/sim@0.10.11` 的 State.deserializeBattle、deserializePokemon 和 deserializeWithRefs：
日志和 Pokemon.set 直接保留引用，其余可变字段由反序列化递归重建。
全快照深拷贝重复了这部分工作。

Decision:
restoreBattle 在传入 Battle.fromJSON 前仅复制日志数组及各 Pokemon.set，并浅复制其上层容器。
继续使用官方反序列化流程重建对局引用关系，保留 restoreBattle 接口和快照隔离契约。
添加冻结快照、嵌套状态、日志和配置隔离测试。依赖升级时必须重新核对直接保留引用的字段。

Reason:
减少每次重放的复制成本，避免自行维护完整模拟器状态恢复逻辑。
已知消费者是仓库求解器和测试，它们需要保持隔离和求解结果一致，不依赖复制的具体实现。

Follow-up:
测量三次独立进程运行，并与本轮修改前的所有非终局缓存项进行差分比较。
