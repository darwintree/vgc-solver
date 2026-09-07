# 有界搜索说明与满 PP 验收

有界求解器返回的是期望效用的安全区间 `[lowerBound, upperBound]`，而不是把未搜索部分当成某个猜测值。终局效用固定在 `[-1, 1]`；尚未展开的后继先使用 `[-1, 1]`，已知的随机后继按原生概率加权。每个行动矩阵分别求下界矩阵和上界矩阵，再用零和矩阵值更新状态区间。因此返回的 `value` 是区间中点，`valueErrorBound` 是区间宽度的一半。

一次 frontier 扩展只生成一个状态的一层原生行动转移。后继状态保留自己的区间，直到它成为下一次选中的 frontier；这让搜索可以在固定预算下随时返回证书。循环不会因为访问过就被宣称收敛；在 deadline 或节点上限到达时，结果会保留当前区间并将 `converged` 设为 `false`。预算检查发生在转移和 backup 操作之间，单个原生转移完成前不会被强行中断。只有区间宽度达到 `--tolerance`（或状态本身为终局）才算收敛。

默认的 `--selection-policy auto` 是按数值矩阵决定的通用策略。根矩阵仍能由某个纯行／列安全界证明时，搜索先选择 security frontier；检测到根的混合值严格超出纯策略安全界后，策略切换为 joint，并保持该选择直到本次求解结束。它不读取 case 名称、物种名称或招式名称。`security` 和 `joint` 仍可用来复现实验；它们只改变 frontier 选择，不改变转移或区间算术。

有界搜索沿用每个局面的原生满 PP 输入，不做按 horizon 或最大消耗的 PP 截断。受审计的私有 memo key 只合并已证明可以按相对 effect order 表示的原生 JSON 快照；无法通过审计时使用精确 key。worker 的 row-major 行动亲和只影响任务路由，不影响行动语义。`_refresh` 只在 cell 端点发生变化时重新求解下界／上界矩阵；端点不变时复用已有矩阵解，子节点界或 exactness 变化仍会向父节点传播。验收数据没有把 terminal transfer 或 JSON transport merge 当作性能来源。

## 命令与误差解释

benchmark 使用 `lazyCells: false`，常驻 9-worker pool；每个局面预热 3 次，然后记录 5 次新的求解器／memo／PP cache。直接调用 `BoundedSolver` 或 `AsyncBoundedSolver` 时，若要复现实验口径，需要显式传入 `lazyCells: false`；API 默认值仍为 `true`。

```bash
node src/benchmark.js --solver bounded --case sucker-punch-3 --workers 9 --warmup 3 --runs 5
node src/benchmark.js --solver bounded --case sucker-punch-4 --workers 9 --warmup 3 --runs 5
node src/benchmark.js --solver bounded --case sucker-punch-5 --workers 9 --warmup 3 --runs 5
```

默认 `--tolerance 0.02` 指效用区间宽度。它给区间中点最多 `0.01` 的效用误差；在 `V` 使用胜 `+1`、负 `-1`、平 `0` 时，分数为 `(V + 1) / 2`，所以对应最多 `0.005`（0.5 个百分点）的“胜利加半个平局”分数误差。这个分数不能直接称为纯胜率；只有没有平局的情形才可作这样的解释。

## 满 PP 结果

数据保存在 [bounded-fullpp.json](benchmarks/bounded-fullpp.json)。所有 15 次正式 run 都通过 `worker` backend 并收敛，输入 PP 为：case 3/4 的 P1 `[8, 32, 16]`、P2 `[16, 56, 8]`；case 5 的 P1 `[8, 32, 16, 16]`、P2 `[16, 56, 8]`。时间单位为毫秒；`total` 包含 prepare，`search` 是区间搜索本身。

| 局面 | 根区间 `[lower, upper]` | 中点 `value` | total min / median / max | search min / median / max | prepare min / median / max |
| --- | --- | --- | --- | --- | --- |
| `sucker-punch-3` | `[0.6277676317, 0.6477311925]` | `0.6377494121` | `2989.035 / 3028.871 / 3192.204` | `1785.217 / 1831.342 / 1933.907` | `1190.282 / 1203.332 / 1257.722` |
| `sucker-punch-4` | `[-0.8000000005, -0.7812500001]` | `-0.7906250003` | `1323.604 / 1368.457 / 1582.912` | `152.465 / 166.629 / 176.949` | `1170.375 / 1197.432 / 1415.332` |
| `sucker-punch-5` | `[-0.8000000005, -0.7812500000]` | `-0.7906250003` | `1707.421 / 1764.039 / 2012.746` | `538.785 / 565.184 / 591.166` | `1158.716 / 1215.578 / 1446.764` |

9 个 worker 只是 benchmark 配置，不是求解器规则。worker 数量不改变原生转移规则或区间有效性；预算内的展开范围可能不同，因此返回区间也可能不同。CLI 的 `npm run benchmark` 仍默认使用 exact；直接调用时需要显式实例化 `BoundedSolver` 或 `AsyncBoundedSolver` 才会选择有界求解。

## 当前适用范围

只要 adapter 提供状态和行动矩阵，区间搜索与 native transition enumeration 就能通用于这些输入，包括未来的单打局面以及双打测试使用的转移层。当前 `legalActions` 路径仍只为双方各一个 active Pokémon 生成选择，因此完整换人、队伍选择和双打完整行动空间仍需要更广的行动生成器，才能端到端覆盖。这是行动生成边界，不是有界搜索按 case 写死的规则。

验证命令为：

```bash
node --test --test-concurrency=4
```

验收时 29 个测试文件全部通过，失败数为 0。
