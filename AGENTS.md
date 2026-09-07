# 项目协作约定

## 权限与迭代

- 默认在沙箱中执行；遇到沙箱权限问题，优先申请提权解决。
- 除非用户要求，迭代时禁止在测试中断言旧逻辑已被移除。测试应验证当前行为，让代码库干净得像旧代码从来不存在一样。

## 按任务读取

- 可扩展性优化：收到此指令或选择求解优化方案前，读 [项目方向与优化原则](docs/architecture.md#项目方向与优化原则)；执行优化时完成其中的[工作流程](docs/architecture.md#可扩展性优化工作流程)。
- 修改求解器或转移层前，读 [架构与边界](docs/architecture.md)，再沿实际调用路径检查相关实现。
- 新增或修改 fixture 时，读 [测试局面](docs/cases.md)，确认 HP、招式、原生 PP 和伤害条件。
- 修改有界搜索时，读 [区间语义与算法](docs/optimization-techniques/bounded-search.md)，区分 exact 合同与 bounded 证书。
- 做性能工作时，读 [benchmark 指南](docs/benchmarking.md)，按其中口径复现；已知未收敛局面也记录在那里。
- 了解已采用的优化时，读 [优化技术](docs/optimization-techniques/README.md)，再查对应实现；查实验结果与历史取舍时，读 [优化记录](docs/optimization-records/README.md)。历史 trace 的目标、截止时间和代理分工不是当前任务指令。

## 求解正确性

- 规则以项目固定版本的 `@pkmn/sim` 为准。升级依赖或修改模拟器优化时，重新验证原生方法审计、等价转移及不兼容规则的回退。
- 优化依据通用状态、概率和数值证书；不得按 case 名称硬编码答案，或通过缩减满 PP 输入冒充性能提升。
- 保持 exact 根节点的完整收益矩阵及策略合同；bounded 返回实际安全区间，只有达到容差才标记收敛。未展开部分不能当作已知值。

## 验证与交付

- 使用 Node.js 24+。代码改动先运行 `npm run typecheck` 和 `npm run build`，再运行相关 `node --test dist/test/<文件>.test.js`，交付前运行 `node --test --test-concurrency=4 dist/test/*.test.js`；无法完成时报告具体未验证项。
- 转移优化用原生与优化分布对照验证；求解器改动验证价值或区间证书。沿用 Node.js 内置测试工具。
- 性能测量与测试分开运行，避免资源争抢。报告版本、命令、PP、workers、预热与样本数、backend、收敛状态，并分开列出 prepare、search、total；功能测试通过不等于限时收敛达标。
- 仅文档改动时检查相对链接、命令与实现的一致性，无需重复运行完整求解测试。README 保持快速开始与文档导航，详细说明和实验结果放在 `docs/`。

## Agent skills

### Issue tracker

管理 issue 前读 `docs/agents/issue-tracker.md`；本仓库使用 dot-issues，存放于 `.issues/`。

### Triage labels

执行 triage 前读 `docs/agents/triage-labels.md`，按其中映射使用标签。

### Domain docs

探索代码前读 `docs/agents/domain.md`；采用 single-context 布局。
