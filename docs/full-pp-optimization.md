# 突袭局面通用优化记录

日期：2026-09-06。本文区分 search 与端到端 total：search 已低于 1 秒，包含 fixture 和固定准备成本的 total 仍超过 1 秒。

## 结果口径

旧的满 PP 突袭基线为 **22.157 s**；root 在当前组合副本上的独立同步 fresh solve 为 **2.430 s**。该同步组合的 fixture 统计为 **820 个状态、2146 次 simulator runs、1966 次 PP cache hit**。最终 workers8 async 验收的 search 中位数为 **715.999764 ms**，达到 1 秒 search 目标；包含 fixture 与固定准备成本的 total 中位数仍为 **2201.062423 ms**。

计时每次搜索都重新创建 memo 和 PP cache。上述 2.430 s 是 root 的一次明确组合验证结果，包含该次 audit/setup；本文不从中扣除固定准备成本。用户允许在后续口径中将模块加载、JIT 和规则准备单列，不据此虚构中位数或额外 benchmark 次数。

根状态的收益矩阵、双方概率和策略与基线保持一致；root 的 **1273 个 state values** 已逐项比较通过。优化没有改变矩阵求解或概率含义。

正式复现命令：

```bash
npm run benchmark -- --case sucker-punch --workers 8 --warmup 1 --runs 5
```

5 次正式 run 全部为 `worker-async`，每次 1,070 个状态、2,235 次 simulator runs、2,938 次 PP cache hit；使用 CPU 8 线程，不需要 GPU。search 五次为 `846.586675, 802.019790, 712.497389, 710.694522, 715.999764 ms`，中位数 `715.999764 ms`（min `710.694522`，max `846.586675`）；prepare 中位数 `1398.338961 ms`，poolReady 为 `1371.879399 ms`，total 中位数 `2201.062423 ms`。每次正式 run 都创建新的 battle、solver、memo 和 PP cache。

## 已验证的通用路径

### PP transition cache

PP 模板只在受控条件下建立：读取来自原生 `getMoves`，写入来自原生 `deductPP`，并记录原生返回值。追踪器将读取分类、实际扣除量和返回值约束转换为各 slot 的初始 PP 区间；命中时验证区间并应用固定消耗量。区间不满足或出现未审计的读写时，回退原生 transition。PP=0 与正 PP 使用不同边界，不能把“招式列表相同”当成安全条件。Pokemon、move slot、队伍位置和变换后的 slot identity 也必须匹配，否则拒绝模板。

验证不是只跑招式名：独立语义测试覆盖真实 Spite（上一回合有 `lastMove`）、Encore 锁招、Leppa 在 PP 归零时恢复、Grudge 在非终局强制换人时把 source PP 清为 0、Transform 产生同 move id 的新 slot identity，以及双打 Ally Switch 后的位置交换。另有跨 PP=5/3/2/1 的 **80 个 cross-PP 比较**与原生 distribution/state key 一致；80 的脚本计数不包含上述六类实际机制语义测试。

### 快照与私有 key

快照优化保留原生 serializer 的 identity guard，并检查 `State.serializeBattle`、`serializeWithRefs`、`serializePokemon` 等依赖方法；自定义覆盖会回退完整 JSON 路径。优化只独立 clone Pokemon 的 `set`，不把旧 JSON roundtrip 中会分裂的 alias 错误地共享。

归一化保持 JSON 语义：对象中的 `undefined`/函数删除，数组中的对应元素变为 `null`，`NaN`/`Infinity` 变为 `null`，`-0` 变为 `0`；`__proto__` 等 plain-object 边界也按 roundtrip 结果处理。公开 `stateKey` 语义不变；相对 `effectOrder` 和完整无排序 key 只用于私有 memo，审核失败时回退完整路径。

### 全局空事件路径

event plan 每次 solve 重新建立静态 definition layout，不跨 solve 假设 Dex callback 不可变。曾验证过把一个已知 native callback 复制到另一个 effect 会使跨 solve callback-name cache 错误，因此没有保留跨 solve definition cache。

对固定且通过 native audit 的规则，callback 名集合一次预建，并展开所有匹配的 `on`/`Any`/`Ally`/`Foe`/`Source`/`Side`/`Field` 前缀；例如 `onAnyDamage` 同时索引 `AnyDamage` 和 `Damage`。动态状态通过 scalar/reference fingerprint 检查，命中时不创建临时 values 数组；未知 definition、custom event 或 guard 身份不可信时使用原生查找。

全局 `findEventHandlers` 只有在 event plan 证明当前 event 不可能存在时返回空数组；wrapper 身份由模块私有 WeakMap 认可，damage/residual/empty-event guard 共用该身份判断，避免伪造兼容标记。17-case eventPlan 显式测试记录了 **8883 queries**；双打测试记录 **9408 runs、1779456 queries**，并保留原生 fallback。

## 证据矩阵

- root 1273-state values：优化前后逐项一致，根矩阵和双方概率保持原值。
- async workers-pp：root 独立核对全部 **1273 个 archived baseline values**，逐项一致；并断言实际发生了 worker dispatch。该验证证明了 async 分发路径的语义一致性，未将其当作最终计时结果。
- async 其它 fixture：trivial `V=1`、leftovers `V=0`，根矩阵与 sync 一致；实际 worker dispatch 分别为 1 和 86，均未 fallback。
- PP cache：80 个 cross-PP 对照与原生一致；独立语义测试另覆盖上述六类真实机制和 PP 0 边界。
- event plan：17-case 显式开启路径，8883 queries；双打 9408 runs、1779456 queries。
- `randomDAG1000`：与 pruner 对照的状态/价值结果一致。
- main 完整测试及满 PP async 回归均通过，覆盖快照、native distribution、event plan、PP transition、stock guard 和 async lifecycle。

## 未保留的候选

rollback、object interner、sorted replacer 和简单的 `getCallback` 重排都做过独立 A/B 或语义审查，未显示稳定的净收益，因此没有进入组合实现。正则候选先发现裸 pattern 会被带转义的 JSON key（例如包含 `effectOrder` 后缀的 key）误匹配；修正对象键边界后再测仍更慢，因此最终候选也未保留。

## 泛化边界

当前 solver 仍依赖现有 action space。6 选 3 队伍预览、任意时点的完整自动换人/行动生成，以及双打双方联合 action space 尚未实现；本文的 doubles 证据只验证已有 action space 下的事件、快照和身份隔离。未知规则、自定义可变 effect、serializer/callback 覆盖、native 行为升级都会走 fallback，并需要重新做 native audit。
