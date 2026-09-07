# Implementation Trace: 有界安全证明前沿选择

Date: 2026-09-07
Source: 用户要求改进 `BoundedSearch._selectFrontier` 的 security 证明调度；`docs/optimization-techniques/bounded-search.md`
Language: 中文

## Entries

### 1. 在选定安全行／列内选择真正约束的格子

Type: unresolved-implementation-decision

Context:
主代理提供的 U2 root 数据显示，lower proof 已选定的行中，最大 gap 格子不一定是该行的最小 lower 格子；展开它可能无法提高该行的安全 floor。upper proof 对称地需要优先处理选定列的最大 upper 格子。来源规定保留行／列选择和 mixed、joint fallback，但未给出格子内的排序细节。

Decision:
security 的 lower proof 在选定行内优先选择最小 `cell.lower`，同值时按 gap 降序；upper proof 在选定列内优先选择最大 `cell.upper`，同值时按 gap 降序。候选必须有正区间宽度，并且未初始化或至少有一个未收敛的 continuing child；若选定行／列没有可展开格子，保留既有 joint fallback。

Reason:
行的安全下界由该行所有格子的最小 lower 约束，列的安全上界由该列所有格子的最大 upper 约束，因此该排序直接针对当前证明瓶颈。可展开守卫避免选择已精确且无法继续下降的格子；其余矩阵界、概率、容差、mixed 检测和回退路径不变。toy 反例验证旧最大 gap 选择与新约束选择不同，并覆盖上下界对称性与精确行的 fallback。

Follow-up:
收益仍需在主代理统一 benchmark 中验证；本次没有测量速度或证明全局最优调度。
