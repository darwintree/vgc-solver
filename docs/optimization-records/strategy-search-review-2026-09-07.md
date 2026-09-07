# 策略搜索候选审查

按 `triage-comments` 检查子代理提交结论；候选在独立 worktree，以下判断不表示已合入。

前两行记录早期候选，最终处置见下表后的验收结论。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Added stochastic winning-path regression with unrelated root cells left unexpanded. | frontier `dd54be9` 的新测试 | Grounded=true；Accurate=false；Reachable=true；Material=true；Owned=true；Unencoded rebuttal=false | n/a | No change：不接受该验证结论；要求修正候选测试 | 测试声明两个 P2 行动，仅提供第一列转移，却断言根下界接近 +1。第二列仍为未知时不能构成必胜行，`toyAdapter` 对缺失转移会报错。尚未执行测试，不能称其已验证剪枝。 |
| Unknown cells remain `[-1, 1]`; root matrix dimensions and bounded certificates remain unchanged. | frontier `dd54be9` 的 `_expand` 调整 | Grounded=true；Accurate=true；Reachable=true；Material=true；Owned=true | Effective=true；Complexity justified=unknown；Semantic fit=unknown；Verifiable=true | Defer：需测试和接口审查 | `_initializeNode` 仍创建完整未知矩阵，`_cellBounds` 不修改未生成格；但默认 lazy=true 的 warmStartRoot 仍填满根，删除 eager 循环还遗留未使用的证书方法，尚不足以接受整个调度改动。 |

## 后续审查与处置

下表中“主项全 true”指 Grounded、Accurate、Reachable、Material、Owned；“响应全 true”指 Effective、Complexity justified、Semantic fit、Verifiable。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Solver and worker caches use second request admission. | `2a31cb4` 的 PP cache 调用点与枚举捕获 | 主项全 true | 响应全 true | Fix code：采纳 | 三个生产工厂调用点显式启用准入；第一请求没有 tracker，第二请求仍完整枚举，复用仍走既有审计与 PP 守卫；180 项最终测试包含原生分布、耗尽边界及 unsafe callback 验证。 |
| Native certificate run before this final breadth revision: case4 passed in 13.3s; case5 still timed out at 30s. | `433db5e` 及后续调度候选 | 主项全 true | 响应全 true | Fix code：拒绝直接合入该候选，继续修复 | root 独立复测确认 case 5 超时；后续排序试验还触及原 maxNodes=5000。最终 `286c7f1` 两项原生证书均通过，30 秒和 5000 节点限制未变。 |
| Removed the infeasible zero-support regression and documented the defensive post-fallback guard. | `a4396f6` 的选择器空 outcomes 守卫 | Grounded=true；Accurate=true；Reachable=false（所提旧反例）；Material=false（该反例）；Owned=true；Unencoded invariant=false | n/a | No change：不保留不能触发所述路径的回归测试 | 原测试给 (0,1) 的联合分数为 1，不是零支持；实际 chooseJoint 已按 gap 排序，所述二次替换路径未得到可达反例。保留位置清晰的 outcomes 防御判断，不宣称修复了已复现崩溃。 |
| 异步实现仍在 solve 中显式批量生成 !lazyCells 节点 | probe 对 eval 的只读审查 | Grounded=true；Accurate=false；Reachable=false；Material=true；Owned=true；Unencoded rebuttal=false | n/a | No change：不据此恢复 benchmark eager 行为 | eval 的 async warmStartRoot 只初始化维度，旧整层 eager 分支已移除；同步和异步都由继承的前沿选择器调度。按最终实现修正文档，不接受读取旧路径产生的结论。 |
| 明确同步/异步均不受 lazyCells 调度影响，async batch 上限为 min(workerCount, batchSize, 未生成格数) | audit `288a822` 文档 | 主项全 true | 响应全 true | Clarify code：采纳文档，补精确端点公式 | 核对 `AsyncBoundedSolver._cellBatch`、两个 solve 的初始化及 `_selectFrontier`；补充 [min L,min U] / [max L,max U]，防止将列的“下界”误解为 min L。 |

## 最终验收

固定提交 `286c7f1`：typecheck、build、36 项针对性与 180 项全量测试通过；主工作区 `src/`、`test/` 与该提交一致。地震目标三次达标，三项对照 9/9 达标；全量 29/54 达标，原 24 项无退化，error/watchdog 均为 0。

对目标结果独立检查了四招式完整矩阵维度、地震概率 1、其他 12 格仍为 [-1,1]、root width≤0.02 和实际 search≤10 秒。默认 API 另测一个目标样本也通过。原生 fixed-policy 诊断的 HP 投影一致性不作为完整状态分布等价证据；专门的原生分布测试承担该验证。

仍存在性能取舍：标准 case 5 单样本 search 1.315→1.769 秒，虽保持 5 秒收敛，但不能声称所有案例都加速。最终仍有 25 个 Champions 项未达标。完整证据见[实验记录](strategy-certificates-2026-09-07.md)。
