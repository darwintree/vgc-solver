# Implementation Trace: bounded 原生转移预算截止

Date: 2026-09-07
Source: 用户要求恢复 Champions watchdog case 的 bounded 安全返回
Language: 中文

## Entries

### 1. 使用绝对 deadline 作为唯一取消接口

Type: unresolved-implementation-decision

Context:
原生 `enumerateTurn` 需要在随机分支边界响应 bounded 搜索预算；同步 solver 和 worker solver 共享转移接口。用户要求优先最小可信方案，且尚未证明需要额外 callback 才能测试真实中断边界。

Decision:
在 `TransitionOptions` 中增加可选绝对 `deadline`，由同步 solver 和 worker solver 传入；不增加 callback 或额外取消配置。`enumerateTurn` 只在有 finite deadline 时检查取消。

Reason:
绝对时间点可通过结构化克隆传给 worker，不会把每个 action pair 的相对预算重新开始计时；默认未传 deadline 时 exact 调用保持原合同和对象形状。worker 与主线程使用同一进程时间基准，若运行时验证显示不成立，再调整为 epoch deadline。

Follow-up:
测试同步真实分支边界、worker 预算传播和 exact 默认路径；记录实际转移完成后的超预算，不宣称硬实时。

### 2. 丢弃未完成 cell 的完整结果

Type: unresolved-implementation-decision

Context:
随机树可能在一个 replay 中途达到 deadline。已完成的 sibling branches 不能组成完整概率分布，也不能安全地归一化为 transition；bounded cell 需要保留未知区间。

Decision:
中断的 `enumerateTurn` 返回 `complete: false` 和空 outcomes；solver 不接受该 cell，保留其默认 `[-1, 1]`，PP cache 只在整个 pending 队列完整排空后写入。

Reason:
这是安全丢弃方案，避免丢失概率质量、误把未展开部分当作已知值，且不改变 exact 路径。

Follow-up:
None.
