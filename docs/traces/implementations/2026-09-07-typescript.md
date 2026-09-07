# Implementation Trace: TypeScript 迁移

Date: 2026-09-07
Source: 用户请求“把项目调整为ts吧”，随后提出升级 Node 24
Language: 中文

## Entries

### 1. 编译与测试入口

Type: unresolved-implementation-decision

Context:
用户指定迁移语言，未指定模块制式、执行器和测试语言。项目为 private CommonJS 包，已知消费者是 CLI 与仓库测试；没有证据表明源码路径是外部发布接口。

Decision:
源码整体迁移为 TypeScript，保留 CommonJS 运行方式，用 tsc 输出 dist；测试保留 JavaScript 并加载编译产物。npm 的测试、demo、benchmark 入口自动构建；直接引用源码的消费者迁移到 dist。按后续用户意见采用 Node 24+ 和 .nvmrc。

Reason:
主进程和 worker 使用同一编译结果，无需额外运行时加载器。迁移现有消费者，不保留旧源码路径的兼容壳。

Follow-up:
None.

### 2. 有界求解共享基类

Type: unresolved-implementation-decision

Context:
原异步类继承同步类并用 Promise 返回值覆盖同步 solve；TypeScript 拒绝该继承合同。

Decision:
共享实现放入 BoundedSearch，同步 BoundedSolver 与 AsyncBoundedSolver 分别暴露原有同步、异步 solve 入口。

Reason:
准确描述两种调用合同，避免用 any 或联合返回类型掩盖调用方式，保留原搜索和回退逻辑。

Follow-up:
None.

### 3. 渐进类型检查

Type: tradeoff

Context:
模拟器大量反射和动态替换内部方法，自定义 adapter 也允许原始值状态和动作。用户未要求 strict 迁移。

Decision:
本次为核心数据合同添加类型，所有 TypeScript 文件参加编译检查并禁止带错误输出；暂不启用 strict，测试仍验证模拟器动态边界。

Reason:
将语言迁移与模拟器内部类型重建分开，控制行为改动范围。限制在开发指南中明确记录。

Follow-up:
None.

### 4. 测试一并编译

Type: unresolved-implementation-decision

Context:
用户后续要求测试也迁移 TypeScript，测试需要与源码共享解析路径及类型检查。原 dist 根目录只存放源码输出。

Decision:
将编译根目录设为仓库根目录，src 与 test 分别输出至 dist/src 和 dist/test；npm CLI 入口同步调整，测试仅运行 dist/test/*.test.js。此项取代条目 1 中保留 JavaScript 测试的选择。保留规则注入测试的动态 require，在故意修改只读规则和部分 mock 的位置使用局部类型断言。

Reason:
单个 tsconfig 即可检查全部代码，不引入加载器或第二套测试构建。现有测试还证明转移只消费 command，以及自定义有界 adapter 支持字符串状态，类型声明据此修正，运行逻辑保持不变。

Follow-up:
None.
