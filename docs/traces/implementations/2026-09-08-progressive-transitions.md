# Implementation Trace: 渐进式概率转移

Date: 2026-09-08
Source: Champions 原生满 PP、10 秒、0.02 容差可扩展性优化
Language: 中文

## Entries

### 1. 有界求解器独立的可续跑转移游标

Type: unresolved-implementation-decision

Context:
完整枚举单格可能消耗整个搜索预算；取消时完整转移 API 丢弃已完成分支。用户允许按未探索概率质量维护安全界，不允许侵入式回合内状态合并。现有 exact 调用和 worker API 已有消费者。

Decision:
新增同步 bounded 可选 createTurnCursor adapter 接口，每批最多 32 个整回合重放、25 ms 合作式截止。按前缀概率最大堆选择待处理分支；回合仍从同一 snapshot 完整重放，取消后保存已选择的随机前缀和该前缀剩余质量。结果给出累计 outcomes 和 remainingProbability，后者按 [-1,1] 参与 backup。调度比较剩余质量宽度和后继概率宽度决定继续枚举还是展开后继。

Reason:
可在昂贵格只生成少量质量后改做其他证明，也可直接利用已知高概率终局收窄区间；不会把已探索质量单独归一化。exact enumerateTurn 与 worker 完整分布路径保持不变。游标不读写 PP 转移模板，避免 partial 污染完整分布缓存；因此存在完整便宜转移路径退化风险，需实测。

Follow-up:
通用概率证书测试、原生分布等价、随机前缀取消恢复与同口径性能验证。大量近等概率叶仍可能需要大量重放，不声称解决组合爆炸。
