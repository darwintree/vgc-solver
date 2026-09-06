# Implementation Trace: value-only 子状态剪枝

Date: 2026-09-06
Language: 中文

## Entries

### 1. 延迟 continuation 递归并保留根矩阵

Type: unresolved-implementation-decision

Context:
value-only 子状态原先在每个 action pair 生成 transition 后立即递归所有 continuation。
早期 continuation 可能形成长链，随后才发现同一行或同一列已经能确定价值。

Decision:
每个 cell 先保存完整 transition；终局 outcome 立即保留，continuation snapshot 延迟到 cell 被选中时递归。
root 请求仍补齐全部 cell，并返回完整 payoff matrix 与双方策略；value-only 缓存项升级为 root 请求时重新补齐。

Reason:
减少无效 continuation 搜索，同时保持随机分支完整枚举和公开 root 结果契约。
该机制只依赖矩阵与 transition 结构，不依赖招式、HP、PP 或突袭局面。

Follow-up:
同一 transition 的重复 child 使用局部 Map 复用，跨 transition 继续使用 solver memo。

### 2. 只采用逐 outcome 的极值证书

Type: unresolved-implementation-decision

Context:
未解析 continuation 可直观地给出 `[-1,+1]` 期望区间，但双精度概率乘法与求和没有定向舍入保证。
直接用区间边界做非极值鞍点判断可能在极小概率或舍入边界上误证书。

Decision:
整行只有在所有 outcome 已解析且逐项严格为 `+1` 时返回 `+1`；整列只有在所有 outcome 已解析且逐项严格为 `-1` 时返回 `-1`。
普通纯鞍点只使用完整精确行和完整精确列。

Reason:
极值证书直接由 outcome value 证明，不依赖期望值是否恰好等于 `±1`，也不会因为低于 `Number.EPSILON` 的非胜利分支而误剪枝。

Follow-up:
增加小于 `Number.EPSILON` 的非胜利分支回归，以及非对称 Sucker Punch / Knock Off / Protect / Tackle PP 局面。
