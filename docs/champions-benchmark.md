# Champions 单打前十：10 秒筛查

数据源：[Champions Battle Data API](https://championsbattledata.com/api_guide)。
离线快照见 [`singles-top10.json`](../fixtures/champions/singles-top10.json)，由 [`fetch-champions.mjs`](../scripts/fetch-champions.mjs) 下载。
保存了源数据版本、生成时间、抓取时间、每只宝可梦的 URL 和完整 API 行。当前版本为 `20260903163627216`（2026-09-03）。

## 输入

使用单打 `Current` 的 `column_position` 排名前十。每个类别按原始 `rank` 取第一名：道具、特性、性格、能力点分配；招式取第 1–4 名。类别百分比是边际使用率，不代表这些配置共同出现的联合使用率；数据没有提供宝可梦整体使用率百分比，以源排名为准。

| 排名 | 宝可梦 | 首选道具 | 处理 |
| --- | --- | --- | --- |
| 1 | Garchomp／烈咬陆鲨 | Focus Sash | 测量 |
| 2 | Primarina／西狮海壬 | Sitrus Berry | 测量 |
| 3 | Meowscarada／魔幻假面喵 | Choice Scarf | 跳过：源招式排名 1–5 缺失 |
| 4 | Archaludon／铝钢桥龙 | Sitrus Berry | 测量 |
| 5 | Mimikyu／谜拟丘 | Life Orb | 测量 |
| 6 | Hippowdon／河马兽 | Sitrus Berry | 跳过：源招式排名 1–5 缺失 |
| 7 | Gyarados／暴鲤龙 | Gyaradosite | 跳过：求解器尚无 Mega 行动 |
| 8 | Delphox／妖火红狐 | Delphoxite | 跳过：求解器尚无 Mega 行动 |
| 9 | Dragonite／快龙 | Dragoninite | 跳过：求解器尚无 Mega 行动 |
| 10 | Metagross／巨金怪 | Metagrossite | 跳过：求解器尚无 Mega 行动 |

Mega 石存在于固定版模拟器的数据中，但当前 `legalActions` 不生成 Mega 命令，因此不能把这些配置当作完整支持。缺失招式不以第 6–9 名替代，也不引入第十一名宝可梦补位。

使用 `@pkmn/sim@0.10.11` 的 `gen9customgame`，50 级、全 31 IV。网站能力点 p 换成 `p === 0 ? 0 : 8*p - 4` EV，使性格修正前的 50 级能力值准确增加 p。部分分配因此超过传统 510 EV 总上限；这是 custom game 数值移植，**不是合法 Gen 9 排位队伍，也不宣称复刻 Champions 全部规则**。

双方各一只宝可梦；按排名固定 P1/P2，不重复反向配对，不含同种镜像。双方独立取 25%、50%、100%，总计 `C(10,2) × 9 = 405` 个 case，其中 54 可测、351 跳过。

初始入场完成后、首次行动前，HP 设为 `max(1, floor(maxhp * percent / 100))`；保留原生入场状态和所有招式最大 PP（含 PP Ups），不根据低血量推测此前触发过道具或特性。没有人为约束伤害为 OHKO/2HKO；伤害由这些配置和固定模拟器规则决定。能力变化、命中、暴击、连击等均保留原生分支。

## 可测配置的 HP 与满 PP

| 宝可梦 | 性格／特性 | 25% / 50% / 100% HP | 前四招式（最大 PP） |
| --- | --- | --- | --- |
| Garchomp | Jolly / Rough Skin | 46 / 92 / 185 | Earthquake 16；Stealth Rock 32；Scale Shot 32；Swords Dance 32 |
| Primarina | Modest / Torrent | 46 / 93 / 187 | Moonblast 24；Sparkling Aria 16；Aqua Jet 32；Encore 8 |
| Archaludon | Modest / Stamina | 41 / 83 / 167 | Flash Cannon 16；Draco Meteor 8；Thunderbolt 24；Stealth Rock 32 |
| Mimikyu | Adamant / Disguise | 32 / 65 / 131 | Play Rough 16；Shadow Sneak 48；Swords Dance 32；Shadow Claw 24 |

## 复现

在仓库根目录、Node.js 24+ 环境运行：

```bash
npm ci
npm run typecheck
npm run build
node --test dist/test/champions-cases.test.js
node --test --test-concurrency=4 dist/test/*.test.js
# 等功能测试结束后再测性能
node dist/src/champions-benchmark.js
# 单独复测
node dist/src/champions-benchmark.js garchomp-25-vs-primarina-25
```

全量结果写入仓库根目录 `champions-results.jsonl`；单例写入 `champions-single.jsonl`。每行即时落盘，首行为环境元数据。默认覆盖相应结果文件，保存旧测量后再运行。

重新抓取当前数据（需要 curl 和网络；会覆盖输入快照，不用于复现本次历史结果）：

```bash
node scripts/fetch-champions.mjs
```

测量使用同步 backend、workers=0、预热 0 次、每 case 1 个新进程和 1 个样本、全新 solver/memo/PP cache，串行运行。`lazyCells=false`、`selectionPolicy=auto`、容差 0.02、搜索预算 10000 ms。

- `within-budget`：`converged=true` 且实际 `searchMs≤10000`。
- `not-within-budget`：未收敛，或实际搜索超过 10 秒；保留安全区间及完整结果。
- `error`：运行错误，不能当作已完成求解或正常预算耗尽。
- `watchdog`：子进程超过 30 秒被终止，没有返回区间或精确分项耗时。
- `skipped`：输入不完整或配置不支持，不计入实测成败率。

`fixtureMs` 是构造输入时间；`prepareMs` 是规则审计和初始搜索准备；`searchMs` 是实际搜索时间；`totalMs` 从构造输入开始，到得到结果为止。进程启动、模块加载、JSON 写盘不计入 total。watchdog 从子进程创建计时。当前原生转移支持在随机分支边界合作式截止，未完成的行动格保留未知区间；正在执行的模拟器调用不能被抢占，实际搜索仍可能超时，所以分别记录收敛与时间达标。初次筛查时只有转移之间的预算检查，其结果保留为历史基线。

本次是冷进程单样本筛查，不是常驻多 worker 的性能验收。1v1 行动生成与状态空间限制仍见[架构边界](architecture.md#当前边界)。

## 本次结果

[2026-09-07 完整报告](optimization-records/champions-2026-09-07.md)包含全部可测 case 的 prepare/search/total 和未达标列表；[原始 JSONL](optimization-records/champions-2026-09-07.jsonl)保留全部 405 项及完整区间、搜索统计与跳过原因。

54 项可测中，16 项达标、29 项返回未收敛区间、9 项触发 watchdog；另 351 项跳过。报告可重新生成：

```bash
node scripts/report-champions.mjs docs/optimization-records/champions-2026-09-07.jsonl > docs/optimization-records/champions-2026-09-07.md
```

## 本次验证

`npm run typecheck`、`npm run build`、新增 fixture 测试及完整 `node --test --test-concurrency=4 dist/test/*.test.js` 均通过（151/151）。全套测试与性能扫描分开运行。类型测试需要启动 Node 子进程，沙箱内遇到 EPERM 后在沙箱外重跑并通过。

还核对了 405 个结果 ID 与配对清单完全一致、返回区间顺序与效用范围、收敛容差和时间分类、原生满 PP、分项计时，以及文档相对链接和脚本语法。功能测试通过不表示性能达标；本次性能结论仅适用于上述单样本测量口径。

## 后续 benchmark 选例

本轮定位是筛选优化用 test case。建议固定四个优化目标与两个已达标对照，并区分“未收敛”和“无法返回”的验收目标；详见[实验结论与 benchmark 选例](champions-benchmark-selection.md)。该文也记录了区间紧贴 0.02 的数值边界项，避免把它与主要性能难例混在一起。
