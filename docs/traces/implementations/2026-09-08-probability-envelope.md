# Implementation Trace: 单击概率终局包络

Date: 2026-09-08
Source: 682e043 同口径 49/54 扫描，Primarina 对 Archaludon 两项仍未收敛
Language: 中文

## Entries

### 1. 单击原生伤害概率取代极值唯一准入

Type: tradeoff

Context:
现有包络要求首招所有暴击/伤害结果均不 KO，并要求回复所有结果均 KO。临界暴击和伤害档会使整个格无法利用局部终局质量。Primarina 的 Torrent 及回复果又令简单使用初始 HP 不安全。

Decision:
对单击使用原生 getDamage 的完整小随机树取得 KO 质量上下界；暴击率、必中暴击、无暴击以及每个伤害随机桶均由 BranchingPRNG 与原生调用给出，不假设暴击均匀。保留多击的“最大单击×最多击数仍不 KO”准入，不推导多击概率分布。

Reason:
只增加一个一回合终局证明，不能输出虚构完整转移。新增准入仍排除 Disguise、接触反伤、未知回调、动态威力、场地/异常等状态，预计主要帮助 Primarina/Archaludon 后继，不声称覆盖剩余 Mimikyu 项。

Follow-up:
先原生分布对照与守卫检查，再串行检查两个失败项以及已通过回归项；无收益则不采用。

### 2. 定理：不重叠终局质量与条件界

Type: interpretation

Context:
首招命中、KO、副作用与回复行动不能未经证明视为独立。HP 恢复及 Torrent 的条件会改变伤害。

Decision:
记首招直接 KO 的安全质量区间为 [aL,aU]，包含首招原生命中率。对每个未 KO 前缀，副作用发生概率至多 c；对每个保留的无副作用前缀，回复命中率至少 h，回复命中后的 KO 概率至少 k。回复终局质量下界为 qL=(1-aU)(1-c)hk。首手为 P1 时返回 [2aL-1,1-2qL]，为 P2 时交换方向。余下质量完整未知。

Reason:
qL 使用 aU 而非 aL；它是条件概率下界逐层相乘，不是独立性假设。副作用 c 对准入的纯目标属性变化/常规异常使用原生 uint32 概率的联合上界；出现副作用的全部质量被放回未知。目标在首招直接 KO 后，这些准入副作用不能伤害先手，故不改变该已知终局。

Follow-up:
原生命中/暴击与麻痹分布对照，明确数值保护余量。

### 3. HP 与事件依赖

Type: tradeoff

Context:
初始低 HP 的 Sitrus 可能在行动前后回复，Torrent 可随之开启或关闭；原生回调来源审计不证明调用时机。

Decision:
继续按事件槽与函数 identity 准入，新增 Torrent 的 onModifyAtk/onModifySpA。水招在 HP=1 与 HP=max 两个原生伤害区域取最坏 KO 界，非水招该回调无作用。可能回复的目标使用 [当前HP,min(maxHP,当前HP+向上取整的一次Sitrus回复)] 作为 KO 阈值区间。回复伤害用首招前较高的防御取得保守下界；首招提高防御或改变命中/闪避仍拒绝。原生伤害探测只改变隔离 battle 的上下文，HP/PRNG 在 finally 恢复；无状态伤害回调、无额外 PRNG、无截断溢出的原有限制保持。

Reason:
这些范围覆盖所有被保留的前缀，无需猜测果实触发先后，也不把 Torrent 的强区误当回复伤害下界。保留完整 PP 与所有行动，不新增公共 API。

Follow-up:
检查原生 HP/PP/snapshot 不受探测污染，未分类事件继续回退。
