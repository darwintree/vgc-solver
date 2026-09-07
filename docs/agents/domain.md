# Domain docs

采用 single-context 布局：根目录 CONTEXT.md 与 docs/adr/。

## 探索代码前

- 阅读根目录 CONTEXT.md。
- 阅读 docs/adr/ 中与当前工作相关的 ADR。
- 文件或目录不存在时静默继续；术语或决策明确后，由 domain-modeling 按需创建。

## 使用领域术语

Issue 标题、方案、假设和测试名称中的领域概念，采用 CONTEXT.md 定义的术语。

缺少所需概念时，先检查是否已有对应术语；确有缺口则记录给 domain-modeling。

## ADR 冲突

方案与现有 ADR 冲突时，明确指出对应 ADR、冲突内容及重新讨论的理由。
