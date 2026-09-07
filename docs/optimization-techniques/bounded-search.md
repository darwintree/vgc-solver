# 有界搜索：把搜索指向尚缺的证明

有界搜索把每个状态的价值表示为安全区间 `[L, U]`。终局的效用是已知值；未展开的状态和行动格从 `[-1, 1]` 开始。展开一个行动组合只生成它的直接随机后继，后继状态再由共享节点表示。搜索随后把后继区间沿依赖边回传到父节点。

对状态中的每个行动组合，按随机后继概率分别加权下界和上界，得到下界矩阵与上界矩阵。零和矩阵价值对每个收益单元单调，因此有：

```text
value(lowerMatrix) <= trueValue <= value(upperMatrix)
```

实现还用矩阵解返回的策略重新计算最低和最高安全收益，并加入浮点保护余量，然后单调收窄节点区间。返回的 `value` 是中点，`valueErrorBound` 是区间宽度的一半。只有根区间宽度达到 `tolerance` 才返回 `converged: true`；预算耗尽、节点上限、转移不完整、停滞或访问循环都不会自动成为完成证明。`exact` 只有在完整行动矩阵及其后继都通过 exact 证书时才为真。

若效用是胜 `+1`、负 `-1`、平 `0`，`(V + 1) / 2` 表示“胜利加半个平局”的分数。它只有在没有平局的额外前提下才等于胜率。

## 一个区间传播例子

假设一个 1×1 行动有概率 `0.75` 直接胜利，概率 `0.25` 进入未知状态 `X`。开始时：

```text
X = [-1, 1]
root = [0.75 + 0.25×(-1), 0.75 + 0.25×1] = [0.5, 1]
```

如果后来证明 `X = [0.2, 0.6]`，根变成 `[0.8, 0.9]`；如果再证明 `X = [0.4, 0.46]`，根变成 `[0.85, 0.865]`。最后一个宽度已经小于 `0.02`，所以中点 `0.8575` 的误差至多为 `0.0075`，无需把 `X` 求成 exact。

多行动时不能把格子平均。P2 会选择回应，所以必须分别求上下界矩阵的博弈值；未知格仍然影响矩阵的安全界。

## 前沿选择与证明方向

`security` 和 `joint` 都只决定下一项工作，不改变区间计算。

`security` 先决定本轮要改善的证明方向：

- 下界证明先按每个 P1 行的 lower floor（该行格子下界的最小值）选择行，近等时按该行 lower mean 选择；再在选中行中选择下界最需要改善的格子，端点近等时比较格子宽度。
- 上界证明先按每个 P2 列的 upper ceiling（该列格子上界的最大值）选择列，近等时按该列 upper mean 选择；再在选中列中选择最需要限制的格子，端点近等时比较格子宽度。

根节点使用自适应方向。当根仍在全局上界 `1` 时，先找下界最强的 incumbent 行；如果该行所有格子的 optimistic floor（格子上界的最小值）仍能达到根上界，就继续做 lower proof；否则切到 upper proof，检查可能压低根上界的回应列。根上界已经低于 `1` 后，`proofTurn` 在 lower 和 upper 方向之间交替。

一旦方向在一次 `_selectFrontier` 下降中确定，它会沿当前选择的正概率后继继续携带。这样，正在改善根下界的路径不会在后继节点突然改做上界搜索；上界路径同理。当当前证明方向对应的矩阵价值严格超出最佳纯行安全界或严格低于最佳纯列安全界时，局部选择优先填充当前矩阵中尚未生成的格子，再使用 joint 支持；单一纯行或纯列不能表示该矩阵的安全策略。

纯方向候选按当前区间的 lower floor/mean 或 upper ceiling/mean 排序；比较使用 `FRONTIER_TIE_EPSILON = 1e-9`，只影响调度，不放宽证书。如果选中的纯行或纯列已没有可收窄的端点潜力，就回退到 joint。行最低收益的可能范围是 `[min L, min U]`，列最高收益的可能范围是 `[max L, max U]`；例如列中已有 exact +1，计算其他格也不能降低该列的最高收益，但该列仍保留在混合矩阵中。

若 lower proof 选中的行的 `min U` 不能达到全局上界 `+1`，或 upper proof 选中的列的 `max L` 已高于全局下界 `-1`，会先在当前矩阵填充未生成格，再沿已生成后继继续下降。这些极值候选在每轮根据增量更新后的区间重新选择，不会把早期的行列判断冻结。

`joint` 使用：

```text
upper-solution 的 P1 概率
× lower-solution 的 P2 概率
× 当前格宽度
```

来选择行动组合，再用“后继概率 × 后继宽度”选择下一层后继。上下界解来自不同矩阵，不能当作已证明的真实联合均衡分布。分数为零或选择路径没有可展开后继时，会使用宽度回退。

`auto` 默认从 `security` 开始。若根下界矩阵的价值高于所有纯行安全界，或根上界矩阵的价值低于所有纯列安全界，就认定根需要混合证明并切换到 `joint`。一旦 `auto` 切换，`autoJoint` 在本次 solve 中保持为真，不会因下一次局部矩阵暂时看起来纯而切回 security。显式选择 `security` 时仍可在当前调用失败后尝试一次 joint。

## 已生成未知格、循环与图回退

行动格一旦生成，就保存完整随机后继和概率。若选中的已生成格传播后仍为完整 `[-1, 1]`，它没有提供方向信息；在下降到这个后继前，会先扫描当前节点的未生成兄弟格。security 下界证明优先同一行，再同一列，再其余格；上界证明优先同一列，再同一行，再其余格，同级按支持度与宽度排序。joint 本身已优先处理未生成格。这避免忽略同一矩阵中仍能提供证据的行动组合；兄弟格规则只改变调度顺序，保留未知格的 `[-1,1]` 语义。

异步版继承相同的 `_selectFrontier` sibling 选择。它的差异在于 `_cellBatch` 可以把多个未生成格一次交给 worker：选中的 frontier 格优先，其余格按当前支持度和间隔组成批次。worker 的完成顺序不改变主线程持有的区间和证书规则。

如果 security 和 joint 都因循环、不可用后继或没有可展开支持而返回空，`_findAnyFrontier` 会扫描已经 intern 的图：跳过终局和区间已足够窄的节点，选择尚未初始化的节点或尚未生成的行动格。它只恢复可达图上的工作机会，不把循环当作已解，也不删除任何行动。若图中确实没有可展开工作，结果保持当前安全区间并报告停滞或节点限制。

循环节点的上下界只会在端点有用地收窄时传播；当前实现不是随机博弈不动点求解器。访问过自身或其他已在路径中的节点，不能推出 exact 或收敛。

## 增量传播与证书停止

共享后继只 intern 成一个节点，并记录所有父节点。后继端点或 `exactCertified` 标志变化时，沿父节点依赖队列传播。因此即使数值端点不动，仅 `exactCertified` 从 false 变为 true 也会使父节点刷新；只有节点对外端点和 exact 状态都没有变化时，才不重复求解上游矩阵。

根达到容差后可以停止，即使某些行动格尚未生成。停止表示根的区间证书已经足够窄，不表示这些行动被硬删除、被判定为不合法或被按 fixture 名称排除。完整行动行列仍然保留在矩阵形状中，未生成格仍以 `[-1,1]` 参与安全界；因此结果可以是 `converged: true` 且 `exact: false`。这也是为什么“达到容差”与“求完所有策略后精确求解”必须分开报告。

## 同步、异步和当前边界

同步版的 `warmStartRoot` 只初始化根的行动维度；之后由证明前沿逐格生成转移。`lazyCells` 仍作为兼容输入保留，但同步和异步都不再用它切换前沿调度或节点填充方式；完整行动矩阵始终保留，未生成格始终以 `[-1,1]` 参与安全界。

异步版把选中的前沿工作交给常驻 worker 批次。主线程拥有节点、矩阵、区间 backup 和前沿选择；worker 只生成直接转移。`_cellBatch` 按当前策略支持度和格宽度排序，把选中的 frontier 格放到批次前面，并最多提交 `min(workerCount, batchSize, 未生成格数)` 个格子。批次内可能同时生成多个行动格，所以计时边界和完成顺序与同步版不同；区间传播仍在主线程按返回结果完成。worker 不兼容固定原生规则、使用自定义 adapter 或规则审计失败时回退同步 backend。

同步与异步都在转移和 backup 边界检查 deadline；原生模拟器调用本身不能被抢占，正在运行的调用可能使实际 elapsed 超过预算。转移返回 `complete: false` 时，该格保持未知区间，搜索不能把它当作已知效用。

该算法针对当前一只 active 对一只 active、有限 PP 和有限离散随机分支的 1v1 状态图。它不是完整单打换人、队伍选择、双打或完整 Simultaneous Move Alpha-Beta（SMAB）求解器；真正可再生的循环需要独立的不动点随机博弈算法。规则审计、双精度矩阵、状态序列化和随机等价优化依赖固定的 `@pkmn/sim` 版本，升级后必须重新验证。

本轮实测见[策略证书搜索记录](../optimization-records/strategy-certificates-2026-09-07.md)，不把单个 case 的成绩外推到其他局面。运行口径见[benchmark 指南](../benchmarking.md)；实现索引见 [bounded-solver.ts](../../src/bounded-solver.ts) 的 `_cellBounds`、`_refresh`、`_backupFrom`、`_selectFrontier`、`_findAnyFrontier`，以及 [async-bounded-solver.ts](../../src/async-bounded-solver.ts) 的批次展开。验证包括 [bounded-solver.test.ts](../../test/bounded-solver.test.ts)、[bounded-stochastic.test.ts](../../test/bounded-stochastic.test.ts)、[bounded-strategy-proof.test.ts](../../test/bounded-strategy-proof.test.ts) 和 [bounded-native-certificate.test.ts](../../test/bounded-native-certificate.test.ts)。


## 同步渐进式转移候选

同步原生 bounded 搜索以可续跑游标逐批生成随机转移；每批最多 32 次整回合重放，并使用 25 ms 合作式截止。游标按待处理随机前缀的概率选择下一次重放，仍从原始回合 snapshot 重放，不保存回合中间的模拟器状态。每次返回累计完成的 outcomes 与尚未完成的概率质量 `remainingProbability`，已完成的质量不会单独归一化：

```text
cell.lower = Σ completedProbability × child.lower − remainingProbability
cell.upper = Σ completedProbability × child.upper + remainingProbability
```

这些 partial 格可以参与上下界矩阵证明。只有 remainingProbability 为零、游标完成且所有后继 exact 时才允许 exactCertified。搜索可以在证书足够时结束，保留未枚举的概率质量；这不等同于省略概率分支。调度比较 `2 × remainingProbability` 与最大的 `child.probability × child.width`，选择继续枚举该格或沿已生成后继下降；其他行动格仍由现有矩阵证明调度选择。

游标在随机调用的合作式截止处中断时，会保存当前已选择的前缀及其当前质量；此前放入队列的兄弟前缀保持独立，恢复时不会重复其概率质量。每次 advance 的 simulatorRuns 计入累计 stats；expandedCells 只在第一次接受该格时增加。单次模拟器调用仍不能被任意抢占。

自定义 adapter 可以提供可选 createTurnCursor，未提供时保留完整 enumerateTurn 合同；普通 complete:false 返回仍表示转移不完整、不能被当作 partial 分布。exact 和 worker 路径继续使用完整 enumerateTurn。本候选的原生游标暂不使用 PP 转移模板，有重复 PP 局面的性能退化风险；大量近等概率叶仍需要大量重放，需以独立性能测量评估。

接受渐进转移时，概率验证的总质量包含已完成 outcomes 与 remainingProbability。总和在既有数值容差内但不恰为一时，两部分统一除以该总质量；不会只按已探索部分归一化。这保持完整概率划分，并避免允许的总和误差超过节点数值保护余量后产生过紧区间。
