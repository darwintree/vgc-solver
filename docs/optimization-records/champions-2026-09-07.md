# Champions 单打前十：2026-09-07 测量结果

输入与复现口径见 [Champions 筛查](../champions-benchmark.md)。原始结果见 [JSONL](champions-2026-09-07.jsonl)。

完成 405/405 项；可测 54 项，跳过 351 项。10 秒内达标 16 项，未达标 38 项。状态计数：`{"within-budget":16,"not-within-budget":29,"skipped":351,"watchdog":9}`。

## 环境

- 开始时间：2026-09-07T12:46:13.989Z；数据版本：20260903163627216（2026-09-03T16:36:27.216Z）。
- 仓库基线：`c871c41044e9ef9042362ba6ed779b7e2b7b3d8d`，加本次新增数据、fixture 和扫描脚本；求解器未修改。
- Node v24.20.0，@pkmn/sim 0.10.11；linux 5.15.167.4-microsoft-standard-WSL2；13th Gen Intel(R) Core(TM) i5-13600K。
- 命令：`node dist/src/champions-benchmark.js`。
- backend=sync，workers=0，预热=0，每 case 样本=1，串行、新进程；原生最大 PP。
- 容差 0.02，搜索预算 10000 ms，watchdog 30000 ms，lazyCells=false，selectionPolicy=auto。

prepare 为审计与准备；search 为实际搜索；total 从 fixture 创建开始。进程启动和模块加载不计入 total。未测得的时间及区间用 — 表示。安全区间是效用界，不是胜率；表内四舍五入，完整精度见 JSONL。单样本结果受环境影响，不能外推为常驻 worker 性能保证。

## 未在 10 秒内求解的 case

| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| garchomp-100-vs-primarina-50 | not-within-budget | false | -0.917 | -0.665 | 0.252 | 160.816 | 10012.240 | 10181.467 |
| garchomp-100-vs-primarina-100 | not-within-budget | false | -0.979 | 0.196 | 1.176 | 161.036 | 10004.597 | 10173.800 |
| garchomp-25-vs-archaludon-25 | watchdog | — | — | — | — | — | — | — |
| garchomp-25-vs-archaludon-50 | watchdog | — | — | — | — | — | — | — |
| garchomp-25-vs-archaludon-100 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-archaludon-25 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-archaludon-50 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-archaludon-100 | watchdog | — | — | — | — | — | — | — |
| garchomp-100-vs-archaludon-25 | watchdog | — | — | — | — | — | — | — |
| garchomp-100-vs-archaludon-50 | watchdog | — | — | — | — | — | — | — |
| garchomp-100-vs-archaludon-100 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 165.796 | 10236.621 | 10410.759 |
| garchomp-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.919 | 0.081 | 165.705 | 10219.949 | 10393.847 |
| garchomp-100-vs-mimikyu-50 | not-within-budget | false | -0.800 | -0.261 | 0.539 | 163.769 | 10454.795 | 10626.713 |
| garchomp-100-vs-mimikyu-100 | not-within-budget | false | -0.932 | -0.261 | 0.670 | 163.177 | 10885.878 | 11057.776 |
| primarina-50-vs-archaludon-50 | not-within-budget | false | 0.802 | 0.917 | 0.115 | 162.766 | 10226.108 | 10397.114 |
| primarina-50-vs-archaludon-100 | not-within-budget | false | -0.922 | 0.917 | 1.839 | 164.817 | 10875.577 | 11049.338 |
| primarina-100-vs-archaludon-25 | not-within-budget | false | 0.950 | 1.000 | 0.050 | 164.248 | 10310.877 | 10483.691 |
| primarina-100-vs-archaludon-50 | not-within-budget | false | 0.833 | 1.000 | 0.167 | 163.674 | 10022.064 | 10193.998 |
| primarina-100-vs-archaludon-100 | not-within-budget | false | -0.919 | 1.000 | 1.919 | 162.227 | 10200.065 | 10370.338 |
| primarina-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 163.879 | 10029.001 | 10202.040 |
| primarina-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.980 | 0.020 | 163.075 | 10038.773 | 10210.824 |
| primarina-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.926 | 0.074 | 168.053 | 10450.201 | 10626.995 |
| primarina-50-vs-mimikyu-25 | not-within-budget | false | -0.964 | 0.461 | 1.425 | 164.023 | 10004.776 | 10177.437 |
| primarina-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 167.402 | 10128.995 | 10304.745 |
| primarina-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 166.737 | 10474.468 | 10649.438 |
| primarina-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 166.663 | 10094.384 | 10269.394 |
| primarina-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 163.527 | 10420.136 | 10591.746 |
| primarina-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 165.563 | 10766.915 | 10940.600 |
| archaludon-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 165.386 | 10075.078 | 10248.640 |
| archaludon-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 168.163 | 10153.309 | 10329.833 |
| archaludon-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.340 | 1.340 | 170.139 | 10008.860 | 10187.247 |
| archaludon-50-vs-mimikyu-25 | not-within-budget | false | -0.903 | 0.830 | 1.733 | 166.242 | 10299.914 | 10474.359 |
| archaludon-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 163.978 | 10166.001 | 10339.457 |
| archaludon-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 166.509 | 10069.845 | 10245.175 |
| archaludon-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 161.225 | 10001.672 | 10171.658 |
| archaludon-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 163.863 | 10010.669 | 10182.723 |
| archaludon-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 165.310 | 10861.616 | 11035.210 |

## 所有可测 case

| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| garchomp-25-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 162.756 | 252.496 | 423.341 |
| garchomp-25-vs-primarina-50 | within-budget | true | -0.917 | -0.917 | 0.000 | 164.551 | 917.630 | 1090.470 |
| garchomp-25-vs-primarina-100 | within-budget | true | -0.979 | -0.979 | 0.000 | 162.643 | 1457.332 | 1628.076 |
| garchomp-50-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 164.890 | 256.217 | 429.770 |
| garchomp-50-vs-primarina-50 | within-budget | true | -0.917 | -0.917 | 0.000 | 176.175 | 949.329 | 1135.508 |
| garchomp-50-vs-primarina-100 | within-budget | true | -0.979 | -0.979 | 0.000 | 161.885 | 1441.906 | 1612.138 |
| garchomp-100-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 164.771 | 382.697 | 556.153 |
| garchomp-100-vs-primarina-50 | not-within-budget | false | -0.917 | -0.665 | 0.252 | 160.816 | 10012.240 | 10181.467 |
| garchomp-100-vs-primarina-100 | not-within-budget | false | -0.979 | 0.196 | 1.176 | 161.036 | 10004.597 | 10173.800 |
| garchomp-25-vs-archaludon-25 | watchdog | — | — | — | — | — | — | — |
| garchomp-25-vs-archaludon-50 | watchdog | — | — | — | — | — | — | — |
| garchomp-25-vs-archaludon-100 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-archaludon-25 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-archaludon-50 | watchdog | — | — | — | — | — | — | — |
| garchomp-50-vs-archaludon-100 | watchdog | — | — | — | — | — | — | — |
| garchomp-100-vs-archaludon-25 | watchdog | — | — | — | — | — | — | — |
| garchomp-100-vs-archaludon-50 | watchdog | — | — | — | — | — | — | — |
| garchomp-100-vs-archaludon-100 | watchdog | — | — | — | — | — | — | — |
| garchomp-25-vs-mimikyu-25 | within-budget | true | -1.000 | -1.000 | 0.000 | 162.422 | 1213.059 | 1383.622 |
| garchomp-25-vs-mimikyu-50 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.915 | 1291.429 | 1464.653 |
| garchomp-25-vs-mimikyu-100 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.185 | 1278.075 | 1451.195 |
| garchomp-50-vs-mimikyu-25 | within-budget | true | -0.800 | -0.800 | 0.000 | 162.777 | 1801.770 | 1974.327 |
| garchomp-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 165.796 | 10236.621 | 10410.759 |
| garchomp-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.919 | 0.081 | 165.705 | 10219.949 | 10393.847 |
| garchomp-100-vs-mimikyu-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 161.896 | 2175.473 | 2345.622 |
| garchomp-100-vs-mimikyu-50 | not-within-budget | false | -0.800 | -0.261 | 0.539 | 163.769 | 10454.795 | 10626.713 |
| garchomp-100-vs-mimikyu-100 | not-within-budget | false | -0.932 | -0.261 | 0.670 | 163.177 | 10885.878 | 11057.776 |
| primarina-25-vs-archaludon-25 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.834 | 1114.310 | 1287.422 |
| primarina-25-vs-archaludon-50 | within-budget | true | -1.000 | -1.000 | 0.000 | 165.686 | 1439.690 | 1614.878 |
| primarina-25-vs-archaludon-100 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.511 | 1972.490 | 2145.784 |
| primarina-50-vs-archaludon-25 | within-budget | true | 0.869 | 0.887 | 0.018 | 164.671 | 4619.893 | 4793.057 |
| primarina-50-vs-archaludon-50 | not-within-budget | false | 0.802 | 0.917 | 0.115 | 162.766 | 10226.108 | 10397.114 |
| primarina-50-vs-archaludon-100 | not-within-budget | false | -0.922 | 0.917 | 1.839 | 164.817 | 10875.577 | 11049.338 |
| primarina-100-vs-archaludon-25 | not-within-budget | false | 0.950 | 1.000 | 0.050 | 164.248 | 10310.877 | 10483.691 |
| primarina-100-vs-archaludon-50 | not-within-budget | false | 0.833 | 1.000 | 0.167 | 163.674 | 10022.064 | 10193.998 |
| primarina-100-vs-archaludon-100 | not-within-budget | false | -0.919 | 1.000 | 1.919 | 162.227 | 10200.065 | 10370.338 |
| primarina-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 163.879 | 10029.001 | 10202.040 |
| primarina-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.980 | 0.020 | 163.075 | 10038.773 | 10210.824 |
| primarina-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.926 | 0.074 | 168.053 | 10450.201 | 10626.995 |
| primarina-50-vs-mimikyu-25 | not-within-budget | false | -0.964 | 0.461 | 1.425 | 164.023 | 10004.776 | 10177.437 |
| primarina-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 167.402 | 10128.995 | 10304.745 |
| primarina-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 166.737 | 10474.468 | 10649.438 |
| primarina-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 166.663 | 10094.384 | 10269.394 |
| primarina-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 163.527 | 10420.136 | 10591.746 |
| primarina-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 165.563 | 10766.915 | 10940.600 |
| archaludon-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 165.386 | 10075.078 | 10248.640 |
| archaludon-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 168.163 | 10153.309 | 10329.833 |
| archaludon-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.340 | 1.340 | 170.139 | 10008.860 | 10187.247 |
| archaludon-50-vs-mimikyu-25 | not-within-budget | false | -0.903 | 0.830 | 1.733 | 166.242 | 10299.914 | 10474.359 |
| archaludon-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 163.978 | 10166.001 | 10339.457 |
| archaludon-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 166.509 | 10069.845 | 10245.175 |
| archaludon-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 161.225 | 10001.672 | 10171.658 |
| archaludon-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 163.863 | 10010.669 | 10182.723 |
| archaludon-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 165.310 | 10861.616 | 11035.210 |

## 各配对统计

| 配对 | 10 秒内达标 | 未达标 |
| --- | --- | --- |
| garchomp vs primarina | 7 | 2 |
| garchomp vs archaludon | 0 | 9 |
| garchomp vs mimikyu | 5 | 4 |
| primarina vs archaludon | 4 | 5 |
| primarina vs mimikyu | 0 | 9 |
| archaludon vs mimikyu | 0 | 9 |

## 跳过原因

- Meowscarada: Missing move ranks 1–4
- Hippowdon: Missing move ranks 1–4
- Gyarados: Mega evolution actions are not implemented: Gyaradosite
- Delphox: Mega evolution actions are not implemented: Delphoxite
- Dragonite: Mega evolution actions are not implemented: Dragoninite
- Metagross: Mega evolution actions are not implemented: Metagrossite

完整 405 个 case 的状态及逐项跳过原因保存在 JSONL；跳过项不计作求解超时。
