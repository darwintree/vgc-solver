# Implementation Trace: 突袭扩展局面

Date: 2026-09-06
Source: 用户新增五个突袭 case 的请求，以及第 4 项改为低速方原有优先级 0 招式变成 2HKO 的确认。
Language: 中文

## Entries

### 1. 五个局面按顺序累积

Type: interpretation

Context: 用户列出五项变化，第 2 项明确继承第 1 项，其余项未明确独立还是累积。

Decision: 按 1→5 累积，每项提供独立 fixture 和 benchmark 名称。保留已被回归测试依赖的原始突袭局面。所有新招式默认最大 PP。

Reason: 逐步增加血量、命中随机性、行动数量和双方保护，便于后续性能对照。

Follow-up: None.

### 2. 血量与招式选择

Type: unresolved-implementation-decision

Context: 用户未指定具体血量、新增普通攻击或高速方强攻击名称。

Decision: 低速 Kingambit 为 6 HP，高速 Electrode 初始为 1 HP；第 3 项低速方新增地震，第 4 项高速方升至 130 HP，第 5 项低速方新增守住。撞击的非暴击伤害为 3–4，按通常的非暴击定义为 2HKO，暴击可能 OHKO。拍落对 130 HP 高速方即使暴击也无法 OHKO，两次最低伤害足以击倒。

Reason: 保留原物种、性格、能力与属性配置。地震在第 4 项仍可 OHKO，使新增普通攻击和拍落存在实际差异。第 4 项的拍落来自用户明确确认。

Follow-up: None.

### 3. 使用原生招式表达强攻击命中率差异

Type: tradeoff

Context: 修改全局 Dex 招式命中率会影响其他 fixture，并导致当前 worker 规则检查回退；用户未要求自定义规则基础设施。

Decision: 第 1 项使用高科技光炮（100%），第 2–5 项使用破坏光线（90%）。两者最大 PP 均为 8，命中对当前低速方必定 OHKO；破坏光线命中即终局，休息回合不会进入后继状态。不修改全局 Dex。

Reason: 在这些局面的可达非终局状态中实现所需的命中概率差异，并保持原生规则和跨线程兼容。二者不是同一招式，也不宣称对任意不同配置仍然等价；若后续提高低速方血量到能承受强攻击，需要重新评估。

Follow-up: None.

### 4. 并行的 Sucker Punch OHKO / Tackle 2HKO 局面

Type: unresolved-implementation-decision

Context: 用户要求新增与第 4 项并行的 fixture：低速方的突袭必须一击击倒，低速方的普通优先级 0 攻击必须为 2HKO，并明确允许替换拍落；具体原生伤害与目标血量需要在实现中选择。

Decision: 新增独立 `sucker-punch-6`，保留 Kingambit/Electrode 的原有物种、等级、能力、性格和属性；P1 使用 `Sucker Punch`、`Tackle`、`Earthquake`，P2 使用 `Protect`、`Tackle`、`Hyper Beam`，P1 HP 为 6，P2 HP 为 56。所有招式保持原生最大 PP。

Reason: 在保留既有物种、属性和原生规则的约束下，选用目标 56 HP；实测突袭为 76–90（非暴击）和 114–135（暴击），因此成功命中时恒定 OHKO；Tackle 为 29–35（非暴击）和 44–52（暴击），因此非暴击两次必定击倒且不发生 OHKO。独立 factory 避免改变累积第 1–5 项的语义。

Follow-up: None.
