# Implementation Trace: 渐进转移总质量归一化

Date: 2026-09-08
Source: review-progressive.md P2 概率总和误差与本轮正确性修复要求
Language: 中文

## Entries

### 1. 对完整概率划分统一归一化

Type: unresolved-implementation-decision

Context:
接受转移时允许总概率误差 1e-9，但 partial 未归一化且节点保护余量仅 1e-10。已完成胜利质量 0.7500000005、剩余质量 0.25 即可产生排除合法剩余全败结果的过高下界。任务允许统一归一化或显式外扩两种修复。

Decision:
所有已完成 outcome 与 remainingProbability 一同除以该批报告的总质量，保持与完整转移的既有语义一致。绝不只按已完成质量归一化。累计游标仍返回其原始累计分区，solver 接受时转换为总质量为一的同一分区；不改变游标重放、取消恢复或 exact 条件。

Reason:
统一修复允许的总和误差，不新增另一个误差字段或传播路径。四种正负效用、正负总和误差的 custom-adapter 测试直接比较两个剩余极值完成，断言不再追加可掩盖问题的比较容差。

Follow-up:
focused 渐进转移与原生独立证书验证；累计 outcomes 复制和重 intern 的潜在 O(N²) 开销保持不变，需独立剖析后再决定接口调整。
