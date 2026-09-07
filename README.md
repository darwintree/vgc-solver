# Pokémon 对战求解器

基于 `@pkmn/sim` 的对战求解器。长期目标是不限于 1v1 的通用求解能力，扩展到完整单打的开局，乃至双打。

当前阶段专注于持续优化 1v1 残局求解，以小规模局面验证正确性与性能，为更大对战空间打基础。优化优先选择可推广的方案，而不是只让某个测试局面更快；详细原则见[项目方向与优化原则](docs/architecture.md#项目方向与优化原则)。

目前提供精确搜索和带误差区间的有界搜索，自动行动生成仅支持双方各一只 active 的招式选择，尚不具备完整单打或双打求解能力。

## 快速开始

需要 Node.js 20 或更高版本。在仓库根目录运行：

```bash
npm install
npm test
npm run demo
```

复杂局面可用有界搜索查看预算内的收敛情况：

```bash
npm run benchmark -- --solver bounded --case sucker-punch-6 --workers 9 --search-ms 5000
```

默认区间宽度目标为 0.02；预算耗尽不代表求解完成，需检查 `converged`。case 6 已复现默认 5 秒内不收敛，见 [benchmark 指南](docs/benchmarking.md)。省略 `--solver bounded` 时使用 exact，不受上述预算限制。

## 文档

- [架构与边界](docs/architecture.md)：求解原理、代码导航和支持范围。
- [测试局面](docs/cases.md)：HP、招式、PP 和参考结果。
- [Benchmark 指南](docs/benchmarking.md)：运行参数、计时口径、已知问题及历史性能记录。
- [优化技术](docs/optimization-techniques/README.md)：已采用的方法、详细例子、正确性边界与实现索引。
- [优化记录](docs/optimization-records/README.md)：各轮思路、实验结果、未采纳候选与原始数据。
- [开发协作约定](AGENTS.md)：修改与验证要求。

有界搜索的区间语义见[技术说明](docs/optimization-techniques/bounded-search.md)。历史记录不是当前任务的授权或性能承诺。
