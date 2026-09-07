# Implementation Trace: 满 PP 并行求解

Date: 2026-09-06
Source: 用户要求当前满 PP 突袭 case 在 1 秒内求解，优化必须具有泛化性
Language: 中文

## Entries

### 1. 以可选异步接口提供并行转移枚举

Type: tradeoff

Context:
用户没有指定接口迁移方式。现有 demo 与测试使用同步 OneVsOneSolver；并行线程需要异步等待。

Decision:
保留同步接口，新增 AsyncTransitionSolver 和常驻 TransitionPool。线程只生成转移，主线程统一管理状态价值、依赖和矩阵求解。通过 benchmark 的 --workers 显式启用并行路径。

Reason:
保留现有消费者的调用方式，同时让多个独立转移并行执行。缓存路由只影响命中率，不参与状态等价或剪枝证明。每次 solve 重置 memo 和 PP 缓存。

Follow-up:
None.

### 2. 跨线程规则不一致时同步回退

Type: tradeoff

Context:
JSON 快照不能传输主线程中修改过的 Dex 回调或闭包；已知原生函数白名单也不能证明两线程的数值规则和缓存定义相同。

Decision:
由每个 worker 使用本地 pinned 模拟器建立精确规则 profile，主线程分别核对 raw data、实例化缓存、顺序相关数组和当前格式。未知或不一致时使用同线程同步求解，不传输自定义代码。移除与该检查重复的临时规则指纹实现。

Reason:
使用可验证的规则相等条件，避免对突袭局面做专用规则简化。准备成本与搜索成本单独计量；无法证明的扩展规则保守回退。

Follow-up:
当前自动行动生成的 6 选 3、完整换人及双打扩展仍属于后续功能，不由本轮性能优化隐式实现。
