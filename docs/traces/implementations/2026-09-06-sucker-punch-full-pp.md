# Implementation Trace: 突袭博弈满 PP

Date: 2026-09-06
Source: 用户要求将突袭博弈调整为满 PP（提升后）
Language: 中文

## Entries

### 1. 调整自动测试的验证范围

Type: tradeoff

Context:
原测试依赖所有招式只有 1 PP，断言价值为 0、双方各以 50% 出招。
恢复满 PP 后该前提不再成立，完整搜索试跑数分钟仍未完成，已手动停止。
用户未要求扩展求解器性能或指定新的均衡值。

Decision:
替换该局面的旧均衡断言，验证提升后的满 PP 以及四种首回合行动组合。
Demo 保留完整求解入口；README 说明搜索成本和自动测试范围。

Reason:
直接覆盖本次设置变更及其关键行为影响，不引入未经验证的均衡预期。
该仓库为 private Demo，已知消费者是本地测试和 Demo，随本次变更同步更新。

Follow-up:
满 PP 局面的完整均衡值与求解性能仍待验证。

### 2. 用户将最终局面改为统一 8 PP

Type: tradeoff

Context:
用户随后要求四个招式先统一为 2 PP 试跑，最后统一为 8 PP，替代此前的满 PP 要求。
2 PP 完整搜索已完成，耗时约 0.65 秒；8 PP 搜索显著更慢。

Decision:
默认局面设为 8 PP。自动测试保留其 PP 和首回合检查，同时以 2 PP 版本验证完整搜索的收益矩阵、价值和混合策略。

Reason:
兼顾用户最终设置与可快速执行的完整求解回归测试。

Follow-up:
8 PP 试跑结果记录在 README。

### 3. 8 PP 完整搜索完成后恢复完整回归覆盖

Type: tradeoff

Context:
8 PP 试跑约 25.8 秒完成，求解 332 个状态，价值为 7/9。

Decision:
自动测试对 2 PP 和 8 PP 均执行完整搜索，断言收益矩阵、价值与混合策略；删除临时首回合检查。

Reason:
已确认 8 PP 在可接受时间内完成，无需缩减为首回合覆盖。

Follow-up:
None.

### 4. 恢复实际对战的最大 PP 默认局面

Type: tradeoff

Context:
用户要求将默认突袭局面改为实际对战中的最大 PP。Showdown 初始化该局面的四个招式分别为 Sucker Punch 8、Knock Off 32、Protect 16、Tackle 56 PP；完整求解约需 22.25 秒。

Decision:
移除 `suckerPunchGame` 的人工 PP 覆盖，保留 2 PP 和 5 PP 的快速完整求解回归，并让适配器测试断言默认满 PP。README 将 5 PP 和 8 PP 标为历史统一 PP 测量；不把约 22 秒的满 PP 完整求解加入默认测试套件。

Reason:
默认 fixture 与实际对战规则一致，同时保持常规回归测试的运行成本可控。满 PP 的完整结果由独立 benchmark 验证。

Follow-up:
None.
