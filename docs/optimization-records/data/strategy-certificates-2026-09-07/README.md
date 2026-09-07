# 策略证书实验原始证据

实验说明见[主记录](../../strategy-certificates-2026-09-07.md)。日期按实验开始时的 UTC 日期归档；metadata 保存各进程的实际开始时间。

- `baseline.jsonl`：基线 f0d3383 的四个 case，各三个冷进程。每个样本前保留一行 metadata。
- `final-repeats.jsonl`：固定提交 286c7f1 的同一组十二个样本；同样保留逐样本 metadata。
- `final-sweep.jsonl`：同一最终提交的全量筛查，首行为 metadata，其后为全部 405 个配对；54 可测、351 跳过。
- `default-api.json`：不传 lazyCells/warmStartRoot 的目标单样本。它只额外检查默认 API 路径，正式重复对照仍以上述 JSONL 为准。
- `candidates.jsonl`：历史候选样本，每个来源文件前增加 `type=artifact` 的文件名记录；不能将不同候选混为同一版本的重复分布。实际版本以紧随其后的 metadata 为准。
- `opaque-screen.jsonl`：完全未知格调度修复后、最终候选前的单次目标筛测。
- `case4-*.json`、`case5-*.json`：标准满 PP fixture 的独立 CLI 诊断。baseline 文件来自 f0d3383；case4 combined 文件来自 683c226，case5 combined 文件来自 5d4823d；`case5-final-security.json` 来自最终提交 286c7f1。
- `case5-frontier-trace.jsonl`：53b9943 的诊断前沿（继承 58301dc 的生产排序），前 80 个生成格及末尾统计，2.5 秒预算；它不是正式耗时对照或完整策略证明。
- `tests-focused.log`、`tests-full.log`：286c7f1 的 36 项针对性与 180 项全量验证结果。
- [policy-diagnostic](policy-diagnostic/README.md)：独立固定地震策略的原生 oracle 与优化枚举证据；生产求解器不会读取这些文件。

所有正式测量均使用原生最大 PP、同步 backend、workers=0、无预热，性能测量与功能测试分开。详细 prepare/search/total 与预算口径以主记录和 metadata 为准。
