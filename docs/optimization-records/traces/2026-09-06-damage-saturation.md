# 实现决策追踪：精确伤害饱和合并

Date: 2026-09-06
来源：用户请求与父 agent 的实现说明
Language: Chinese

## Entries

### 1. HP 饱和合并的运行时准入条件

Type: 未决实现决策

Context:
请求要求只有在后续所有观察结果等价时才合并随机伤害，但没有明确哪些 simulator 扩展点必须关闭合并。

Decision:
只在原生 Battle/Pokemon 伤害路径上启用饱和合并：`Damage` 与 `DamagingHit` 事件 handler 列表都为空、不存在 Substitute 路径，并且核心方法（`runEvent`、`findEventHandlers`、`spreadDamage` 与目标的 `damage`）保持原生 identity。其他情况关闭 HP 饱和合并，保留已有 raw randomizer 合并；不支持该 API 时再回到原生 randomizer。

Reason:
`spreadDamage` 会限制并施加伤害，记录 `lastDamage`/`hurtThisTurn`，再根据实际造成的数值计算反伤与吸血。因此，只有没有 handler 读取或改写限制前的伤害值、也没有 Substitute 分支重定向时，正的 raw 值在 HP 饱和后才可证明观察等价。原生方法 identity 防止 override 破坏这个证明。Sturdy 与 Focus Sash 会自然落入带 handler 的保护路径；每次 randomizer 调用重新检查也能保留 multi-hit 的状态转移。

Follow-up: 无

### 2. 零伤害映射

Type: 未决实现决策

Context:
Simulator 对零伤害与小于一的正伤害处理不同：`spreadDamage` 保留零，而非零值会限制为至少一。

Decision:
raw 为零时使用 `0`，其他 raw 值使用 `min(max(raw, 1), target.hp)`。

Reason:
这与 `Pokemon.damage` 之前原生 `spreadDamage` 的限制完全一致，也覆盖异常的非正值；只有实际伤害相同的结果才会合并。

Follow-up: 无

### 3. randomizer 位于后置 modifier 之前

Type: 偏离

Context:
父 agent review 指出，`Battle#randomizer` 在 `modifyDamage` 内运行，位置早于 STAB、属性克制、烧伤和最终伤害 handler。因此从 randomizer 返回 HP 饱和值会改变后续算术；仅凭 `activeTarget` 也无法把普通招式伤害与其他 randomizer 调用区分开。

Decision:
将 modifier 前的饱和映射改为带上下文的映射：保留 raw randomizer representative，只在计算完整原生 post-randomizer tail 后按结果分组。通过原生 `getSpreadDamage`/`getDamage`/`modifyDamage` identity wrapper 建立上下文；出现任何相关事件或可变特殊路径时回退。

Reason:
这样既保留原生 `modifyDamage` 消费的 raw 值，也能按最终实际伤害精确分组。上下文 wrapper 防止在 confusion 或无关 randomizer 调用中误启用。父 review 的 Grounded、Accurate、Reachable、Material、Owned 均为 true；拟议响应 Effective、Complexity justified、Semantic fit、Verifiable 均为 true，并由原生差分测试验证。

Follow-up: 无

### 4. 前置与父级伤害回调的上下文边界

Type: 未决实现决策

Context:
`WeatherModifyDamage` 在 randomizer 之前运行，且 `Damage` 事件使用父级 move 作为 effect；`getSpreadDamage` 传入的 moveData 可能是次级 effect。请求没有规定这些 callback 对伤害上下文的处理方式。

Decision:
在纯 tail 准入条件中要求 `WeatherModifyDamage` 无 handler，并在上下文中同时保存父级 move 与当前 moveData，分别检查父级和当前 effect 的 `onDamage`。同时要求 Dex 的 `getEffectiveness` 保持 pinned native identity。

Reason:
Weather handler 可能在当前 context 中再次调用 randomizer，父级 move 的 onDamage 可能观察最终进入 `spreadDamage` 的数值，而自定义 Dex effectiveness 可能有副作用。三项 guard 能在证明不完整时保留已有 raw 合并或回到 native 路径。

Follow-up: 无

### 5. 事件查询与天气优先级方法的 identity 守卫

Type: 未决实现决策

Context:
`noHandlers` 依赖 `findEventHandlers` 内部的 callback 解析与优先级排序；原生 `modifyDamage` 的天气前缀也会通过 `priorityEvent('WeatherModifyDamage')` 进入事件查询。只检查外层事件方法，无法排除被覆盖的内部解析方法在 context 中再次观察或触发 randomizer。

Decision:
纯 tail 准入条件同时要求 `getCallback`、`resolvePriority`、`priorityEvent` 保持 pinned native identity。任一方法被覆盖时，关闭 HP 饱和合并并保留已有 raw randomizer 路径。

Reason:
这些方法属于证明所依赖的事件发现与排序调用链；identity 守卫使 custom callback、priority 规则和天气前缀不会在无副作用证明之外被执行。该边界只收紧优化准入，不改变 native 伤害语义。

Follow-up: 无
