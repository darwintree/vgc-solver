# 满 PP 优化独立验收记录

主 agent 负责设计与独立验算；实现由 gpt-5.6-luna/high 子 agent 完成。以下计时均来自本机实测，不能推断其他硬件或任意对局均在 1 秒内。

## 已完成的独立对照

- 满 PP：Sucker Punch 8、Knock Off 32、Protect 16、Tackle 56。
- 并行原型常驻 8 workers，batch size 8；5 次调用均新建 solver、memo 与 PP 转移缓存。首次 search 1204.423ms，随后 943.778、920.852、837.049、846.497ms，中位数 883.674ms。准备时间另列，未复用目标局面的已求解价值。
- 每次核对根矩阵四个元素与双方策略，误差阈值 1e-10。
- 合入 PP 私有 JSON key 后，再逐项核对全部 1273 个原始基线状态价值，全部通过；断言实际向 worker 派发任务，避免同步回退掩盖并行问题。
- 同步组合已对照全部 1273 个基线状态价值；17 个显式开启 event plan 的转移分布对照和双打分布对照通过。

这些数字描述中间候选，最终仓库性能以正式 benchmark 复测为准。

## 子 agent 反馈审查

表中 G/A/R/M/O 分别为 Grounded、Accurate、Reachable、Material、Owned；E/C/S/V 分别为 Effective、Complexity justified、Semantic fit、Verifiable。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| “search-only 达到 1s 内。” | 并行计时 | G/A/R/M/O=true | E/C/S/V=true | 接受候选成绩，继续最终验收 | 主 agent 独立 warm 四次均低于 1 秒，完整矩阵与策略通过；固定准备另计 |
| “属性顺序不同最多导致 cache miss，不会错误合并。” | PP 私有 JSON key | G/A/R/M/O=true | E/C/S/V=true | 接受优化 | 仅用于有限 JSON 快照的私有缓存，保留全部非 PP 状态；public stateKey 不变；1273 值对照通过 |
| “online wrapper 的单 slot lookup、amount || 1、饱和返回和 missing-slot fallback 与 native 语义一致。” | PP 区间追踪 | G/A/R/M/O=true | E/C/S/V=true | 接受优化 | 独立阅读 pinned pokemon.js getMoveData 与 deductPP；后者返回实际扣除量；实际 PP 机制分布测试通过 |
| “Species runtime cache 改为只检查 descriptor/callback 白名单，raw Pokedex 仍精确比对，避免派生缓存误判。” | worker 规则一致性 | G=true,A=false,R/M/O=true | E=false,C/S/V=true | 不接受该做法 | constructed Species 的 baseStats 等数值可以独立于 raw Pokedex 修改；callback 白名单不能证明跨线程规则等价。要求精确 stock profile 或同步回退 |
| “worker 启动失败、意外 exit、close 前启动竞态已处理。” | pool 生命周期首次修订 | G=true,A=false,R/M/O=true | E=false,C/S/V=true | 要求补正与实际回归测试 | 首次实现仅在 Promise.all 成功后记录 workers，部分启动失败会丢失句柄；run 等待 ready 后未重新检查 closed。逐条反馈并要求修复 |

规则不匹配的处理是同线程同步求解，不得仅关闭 PP cache 后继续使用 worker 的默认规则。

## 提交前 simplify 复核

保持现有 CommonJS 接口、收益计算和回退条件；仅整理本轮工作区改动。矩阵算法与随机分支协议未进一步改动。

| Comment | Target | Comment Claims | Response Claims | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| “删除 `installTracker` 中重复的 `allPokemon` 数组，复用 `identity`。” | PP 追踪 | G/A/R/M/O=true | E/C/S/V=true | 接受 | identity 按相同顺序保留全部 Pokemon；PP 实际机制测试覆盖原生扣除、恢复和槽位替换 |
| “删除 `native-memo-key.js` 中未导出、全仓无调用的 `stableStringifyMemo`。” | 私有状态键 | G/A/R/M/O=true | E/C/S/V=true | 接受 | 全仓引用检查仅发现自身递归；保留实际使用的私有 JSON 键与精确排序回退 |
| “抽取 value-only memo 写入逻辑，消除四处重复的缓存/计数代码。” | 同步求解器 | G/A/R/M/O=true | E/C/S/V=true | 接受 | 仍只在首次写入非终局价值时增加 solvedStates；原剪枝条件、写入结果和返回位置不变 |
| “抽出 `cacheEntries`，统一 `cacheSnapshot` 与 `compareCache` 的缓存枚举逻辑，未增加额外分配。” | 规则 profile | G/A/R/M/O=true | E/C/S/V=true | 接受 | 保留原 Map/object 两条分支、枚举顺序与数组分配；profile 格式和精确比较不变 |

最终验证：`npm test` 的 23 个测试文件全部通过。满 PP 使用 8 workers、1 次预热和 5 次独立求解，搜索耗时 655.382–744.898 ms，中位数 704.993 ms；五次均实际使用 worker，价值及根矩阵与基线一致，每次 simulatorRuns 为 2,235。该复测用于排查简化带来的回归，不据单轮差异宣称新增性能收益。
