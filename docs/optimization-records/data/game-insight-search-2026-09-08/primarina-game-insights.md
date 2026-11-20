# Primarina 满血局面：游戏见解（只读分析）

来源：固定 `fixtures/champions/singles-top10.json`、`src/champions-cases.ts`，以及固定版本 `@pkmn/sim` 的 moves/abilities/items/pokedex 源码。没有执行 native battle、测试、构建或性能测量。以下路线是调度假设，不是价值、胜率或安全剪枝证书。

## 固定输入与速度

| Pokémon | 配置 | 纸面属性：HP / 主攻 / 防御 / 特防 / 速度 |
| --- | --- | --- |
| Primarina | Modest，Torrent，Sitrus；Moonblast / Sparkling Aria / Aqua Jet / Encore | 187 / SpA 195（Atk 84）/ 94 / 136 / 82 |
| Archaludon | Modest，Stamina，Sitrus；Flash Cannon / Draco Meteor / Thunderbolt / Stealth Rock | 167 / SpA 194 / 150 / 85 / 137 |
| Mimikyu | Adamant，Disguise，Life Orb；Play Rough / Shadow Sneak / Swords Dance / Shadow Claw | 131 / Atk 156 / 101 / 125 / 148 |

属性由固定 level/IV/EV/nature 静态计算，尚未用 native 实例核对。两名对手普通优先级均先于 Primarina；Aqua Jet 与 Shadow Sneak 都是 +1，因此两者相遇仍是 Mimikyu 先动。

## Primarina100 vs Archaludon100

**最值得先证明的是 Moonblast 对 Thunderbolt 的路线。** Fairy 对 Steel/Dragon 合计中性，Water 被 Dragon 抵抗；Moonblast 还可能降低对方 SpA。Stamina 增加的是 Defense，挡不住 Moonblast，却令低 Atk 的 Aqua Jet 收尾更弱。即使 Torrent 激活，Water 的属性抵抗仍让“改用水招”不能仅凭低 HP 自动成立。

Thunderbolt 对 Water/Fairy 是超有效；Flash Cannon 的 Steel 优势被 Water 抵消，合计中性。Draco Meteor 被 Fairy 免疫；Stealth Rock 在当前双方最后一只且无换人的模型中没有即时入场伤害。后两者可排在较低调度优先级，但这不是按名称删除行动的依据。

**回复果恰好影响两回合生存边界。** 纸面粗算，普通非暴击 Thunderbolt 约 98–116，而 Primarina 的 187 HP 加一次约 46 回复，与两发上限非常接近；普通 Moonblast 对 Archaludon 约 123–145，后者 167 HP 加约 41 回复通常仍承受不了两发。这里真正需要分配证明预算的是 Thunderbolt 暴击/麻痹、Moonblast 的 SpA 降低、以及 berry 触发顺序。不能把粗算范围升级为 native 证书。麻痹不仅是速度问题：Primarina 原本已慢，关键是行动可能失败。

首回合 Encore 若对方先用了 Thunderbolt，会把最危险的攻击锁住，却让 Primarina 少打一发；若对方用了无即时伤害的行动，Encore 才可能创造免费输出窗口。Aqua Jet 更像极低 HP 收尾候选，而不是满血正面对轰的主线。

## Primarina100 vs Mimikyu100

**这里有真实的 setup / Encore 应对关系，不能用“双方重复同招两回合”代表策略。**

- Primarina 首回合攻击通常只破 Disguise。Mimikyu 若同时 Swords Dance，下一回合的强化 Play Rough 是关键反驳：纸面威力已足以威胁 Primarina 从满血直接倒下，Sitrus 不能救已经归零的 HP。命中与暴击需实际枚举。
- Primarina 首回合 Encore 会在更快的 Mimikyu 行动后锁住其刚用的招。若锁住 Swords Dance，可在后续改用攻击完成破盾和收尾；原生 Encore 在目标已经行动时会增加初始 duration，这个窗口比随意假设“两回合锁招”更长。
- Mimikyu 的反制是首回合直接 Play Rough 或 Shadow Claw，惩罚 Primarina 花一个回合 Encore 而没有破盾。二者都值得作为反驳优先检查：前者更强但会 miss，后者命中更可靠且提高暴击档，不能未经比较认定其中一个支配另一个。
- Shadow Sneak 的主要价值在残局压过 Aqua Jet；首回合无条件重复它可能浪费强攻击或 setup 的机会。Encore 锁住弱先制招，与锁住强攻击的后果不同。

Disguise 破坏还扣自身 HP，Life Orb 成功攻击后的自损继续改变收尾阈值。Play Rough 的 Atk 降低会削弱 Primarina 的 Aqua Jet，但不影响 Moonblast。Sitrus 可能把 Primarina 从 Torrent 阈值以下拉回去，故“低 HP 水招更强”也必须看实际行动时刻。

**旧 hint 丢失的正是关键换招：** `Swords Dance → 攻击` 被测成 `Swords Dance → Swords Dance`，`Encore → 攻击` 被测成 `Encore → Encore`。两回合 HP 分数还看不出破盾后第三次行动的胜负；它可以系统性低估 setup 威胁和 Encore 的收益，而不只是随机噪声。

## 可泛化的下一步

1. **调度先看回应关系。** 对“对方刚强化/被锁招/一次性盾已破/进入先制击杀范围”的状态，用合法行动重新选择 continuation，不机械重复上一招。对混合矩阵必须把这种候选/反驳信息用于 joint 的实际工作项，否则 sticky autoJoint 后提示不会参与搜索。仍需给非提示路线正常调度机会。
2. **优先验证强攻击、setup、反 setup 三类的少量交叉格。** 不按物种或招式名称写策略；依据动作改变的状态、原生请求中的强制行动、优先级及可验证伤害范围分类。Shadow Sneak/Aqua Jet 收尾必须比较双方优先级与当前 HP，不能只按“是先制招”加分。
3. **最有希望的新增证书是“已形成的无伤输出窗口”。** 例如原生 Encore 已生效，敌方未来若干回合只能执行不会造成伤害的强化，己方有足够 PP 和命中下界在窗口内完成破盾及击杀。须审计锁招倒计时、PP 提前结束、残余伤害、护盾和伤害范围；这比直接证明初始混合策略更局部，也比全域新增启发式更容易验证。
4. **Archaludon 对局优先给接近两回合终局的高概率分支预算。** 暴击、麻痹、SpA 降低和 berry 状态才是证书分叉。可用已有渐进转移与后继质量调度验证；当前受限 one-turn envelope 排除 Torrent/麻痹等效果，不能直接扩大准入而省略对应证明。

## 补充：概率终局包络可行性

**对单击招式可行，且明显小于完整回合内 DP；适用范围应先限定为“原生 damage 的 HP 依赖及副作用已审计”的行动格。** 可以在原生 damage 的暴击/伤害随机树上累计一击 KO 质量，而不是生成所有回合后继。回复伤害在非 KO 第一击之后仍须有统一下界，或按已审计 HP 区域取保守最小值。

令先手直接 KO 质量为 `a`，先手未 KO 分支上有害 secondary 发生率的条件上界为 `c`，安全分支上回复命中率的条件下界为 `b`。若回复命中必杀，则可认证回复 KO 质量至少 `q=(1-a)*(1-c)*b`。这不应靠“几个裸概率相乘”来假设独立：`c` 必须对每种未 KO 前缀都成立，`b` 必须对每个保留前缀都成立；由条件界逐层相乘即可。第一击 miss 分支通常没有 secondary，可以另外计入以减少保守性。

先手是 P1 时，区间为 `[2a-1, 1-2q]`；先手是 P2 时对称为 `[2q-1, 1-2a]`。其余质量完整保留未知。**数值上尤其注意：**若 `a` 只有区间 `[aL,aU]`，计算 `q` 必须用 `1-aU`，而先手已知胜利质量用 `aL`；不能拿 `1-aL` 当已证明存活质量，否则会重复认领不确定概率。命中前后护盾、Sash、反伤/自损导致的平局等仍需准入守卫。

Torrent 可按原生 callback **事件槽与函数 identity** 识别，再证明当前两招均非 Water 时它无作用；这是比普遍建两个 HP 区域更小的入口。需要水招时，才考虑 HP 高/低两个区域的原生范围，回复取跨区最小值，因为 Sitrus 可以把使用者从 Torrent 阈值下方拉回上方。第一击使用者持 Sitrus 也不必永远拒绝：若起始 HP 高于触发线且第一击期间不会失血，可证明其在回复前不发动；低 HP 或可能自损时仍回退。

**对 Primarina100/Archaludon100 的限制：**纸面粗算中，先手 Thunderbolt 连暴击也通常不能从满血直接击倒 Primarina；而回复 Moonblast 的最低伤害不能从满血一击击倒 Archaludon。因此“第一击概率 KO + 回复必杀”的新公式未必在根得到非平凡质量，主要可能帮助后续掉血状态。若再计算 Moonblast 的暴击 KO 质量，根可获得小部分终局证据，但大多数正常分支仍是两回合生存/击杀问题，不能据此期待直接达到 0.02。先以完整失败清单和后继热点验证收益，再扩大准入。
