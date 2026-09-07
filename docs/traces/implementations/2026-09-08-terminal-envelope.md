# Implementation Trace: 原生一回合终局包络

Date: 2026-09-08
Source: 用户要求保持规则和完整 PP，以通用证书优化 Champions 有界求解
Language: 中文

## Entries

### 1. 直接收窄 bounded 未生成格的区间

Type: tradeoff

Context:
纯行动排序无法免除一个必需回应格的昂贵多击分布。完整转移接口不表示剩余未知概率，但 bounded 格本身已有安全上下界。

Decision:
新增限定状态的原生终局包络，初始化行动格时可给出 [L,U]，outcomes 仍为 null，exact 仍为 false。后续真实转移与包络取交集。回复招命中的已知终局概率计入区间，未命中质量保持 [-1,1]，使用 BranchingPRNG 的 uint32 离散质量，不替换原生规则或制造完整分布。

Reason:
对安全区间的矩阵单调 backup 不要求每个区间都由已展开子节点给出。固定数值规则及所有中途效果审计后，可以证明先手不能击倒后手，且后手命中必杀。原生 getDamage 穷举 critical/noncritical 与全部 16 伤害随机值，原生 getActionSpeed 决定确定先后，原生 hitStepAccuracy 给出命中质量。

Follow-up:
需原生小多击完整分布对照、阈值边界、反例守卫、全套 bounded 测试及独立性能实验。

### 2. 显式限定单调效果与数值区域

Type: tradeoff

Context:
原生来源审计不等于单调性证明。多击中可能发生加攻、降防、回复、变形、异常状态或 HP 相关威力变化；原生伤害还存在 16bit 截断。

Decision:
仅支持 Gen9 单打双方最后一只、无异常/volatile/field/side 状态、固定威力非接触普通单目标招式。按原生回调 identity 允许 Stamina 的防御增加、Sitrus 对存活者的回复、非接触下不触发的 Rough Skin、低 HP 下不触发的 Focus Sash；先手持有回复效果时回退。首招无命中中途 secondary/self 效果，末尾 selfBoost 不得提高其防御或改变命中/闪避；回复招为单击，非伤害附加效果仅允许属性增减。未知回调、条件威力、优先级平局、替身、接触反伤、自伤、吸血、溢出区域均回退。

Reason:
这些可检查条件确保第一击原生最大伤害对以后每击仍是上界，初始防御下原生回复最小伤害对首招后的回复仍是下界。Sitrus 与 Stamina 的实际后继不用于捏造新状态；只使用它们的单调方向。范围依赖原生固定版本，不依赖 case、物种、具体招式答案；仍仅覆盖当前 1v1 状态。

Follow-up:
未覆盖规则一律保持已有转移路径。是否扩大支持由实测收益与独立证明决定。


### 3. 审查发现原生回调搬移破坏单调性

Type: CONFLICT

Context:
交叉审查指出仅匹配函数 identity 不限制事件槽：把原生 Sitrus.onEat 放在 FocusSash.onAfterMoveSecondarySelf，会在先手行动后回复 HP，却绕过只检查 onUpdate 的先手回复排除。通用 native audit 的合同只保证回调原生来源。

Decision:
承认缺陷，准入改为事件名与函数 identity 同时匹配；不收紧通用 native audit。补充原生回调搬移仍通过 native audit、却被包络拒绝的反例，且用原生回合证明先手回复后实际存活。

Reason:
单调性依赖回调何时触发，不能只根据函数体判断。事件槽绑定在拥有包络语义的模块内，避免改变其他原生优化的准入合同。

Follow-up:
重新运行类型、构建、相关包络守卫测试后才能采用修正版本。


### 4. 伤害溢出证明显式拒绝附加属性

Type: interpretation

Context:
审查指出 Pokemon.types 不包含 addedType，而 getTypes() 会返回第三属性；原始溢出上界只允许最多两种属性的四倍克制。

Decision:
准入显式拒绝 addedType，并检查 getTypes() 的实际属性数量。新增没有 volatile 的原生 addType 负例。

Reason:
这是缩小包络证明适用域，不能用 stored types 数量代替原生实际属性数量。固定 Champions 输入不受影响。

Follow-up:
None.
