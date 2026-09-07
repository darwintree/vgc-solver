# Implementation Trace: Bounded Strategy Frontier

候选阶段的历史记录，后续实验已替代下文的固定 lower proof 决策。最终取舍与验收见[本轮主追踪](2026-09-07-strategy-certificates.md)和[最终记录](../../optimization-records/strategy-certificates-2026-09-07.md)。文件名采用本地日期，记录日期采用实验开始时的 UTC 日期。

Date: 2026-09-07
Source: 用户要求候选 A：generic scalable certificate-driven strategy search
Language: 中文

## Entries

### 1. eager 节点的增量前沿调度

Type: unresolved-implementation-decision

Context:
`lazyCells:false` 路径虽然允许节点保留未知格，但 `_expand` 原先在返回前生成该节点的全部行动组合。因此根节点会先支付与当前证明无关的昂贵转移，之后才有机会沿已生成的有利后继递归。

Decision:
`_expand` 只负责初始化行动维度；行动格由同一证明前沿选择器逐格生成。`lazyCells:false` 保留完整行动矩阵形状和按需转移语义，但不再规定初始化后立即填满整层。

Reason:
每个未生成格仍使用保守的 `[-1,1]`，延迟生成只能保留不确定性，不能扩大下界或缩小上界。外层循环在生成一个格后立即 backup；若该格通向未收敛后继，下一次选择会沿该后继继续下降。完整行动数组仍由 `_initializeNode` 创建，根结果的矩阵维度和策略合同不变。

Follow-up:
用排列行动顺序、随机 DAG、混合矩阵和原生满 PP case 验证区间包含 exact，并比较根层昂贵转移是否被推迟或省略。

### 2. 根全局上界已到顶时继续下界证明

Type: unresolved-implementation-decision

Context:
security 策略原先严格交替 lower/upper proof。若根的上界已经达到效用全局上限 `+1`，而选定的候选行仍有未生成的对手回复，下一次 upper turn 可能选择别的未知行，延迟该行的必要回复并扩大搜索。

Decision:
根节点的上界达到 `+1` 时，security 选择固定 lower proof，直到根收敛或上界不再处于全局上限；其它节点和上界不在顶点的情形继续使用既有交替调度。

Reason:
虽然 upper proof 仍可能把当前上界从 `+1` 收紧，但先做 lower proof 可以让候选行覆盖每个对手列，并检验它是否已经足以完成根证书。若区间没有因此收窄，后续迭代仍可回到 upper proof。该规则只改变调度，不改变矩阵界、概率质量或 convergence 条件。

Follow-up:
需在混合支持、已知终局、共享随机后继和循环 toy graph 上验证不会停滞或错误收敛。
