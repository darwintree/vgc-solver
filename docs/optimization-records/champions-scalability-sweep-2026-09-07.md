# Champions 单打前十：2026-09-07 测量结果

输入与复现口径见 [Champions 筛查](../champions-benchmark.md)。原始结果见 [JSONL](champions-scalability-sweep-2026-09-07.jsonl)。

完成 405/405 项；可测 54 项，跳过 351 项。10 秒内达标 24 项，未达标 30 项。状态计数：`{"within-budget":24,"not-within-budget":30,"skipped":351}`。

## 环境

- 开始时间：2026-09-07T15:09:44.076Z；数据版本：20260903163627216（2026-09-03T16:36:27.216Z）。
- 仓库基线：`71160d7ead735ca71ac2a2445dbcaf1145d2d1f8`，加本次新增数据、fixture 和扫描脚本；求解器未修改。
- Node v24.20.0，@pkmn/sim 0.10.11；linux 5.15.167.4-microsoft-standard-WSL2；13th Gen Intel(R) Core(TM) i5-13600K。
- 命令：`node dist/src/champions-benchmark.js`。
- backend=sync，workers=0，预热=0，每 case 样本=1，串行、新进程；原生最大 PP。
- 容差 0.02，搜索预算 10000 ms，watchdog 30000 ms，lazyCells=false，selectionPolicy=auto。

prepare 为审计与准备；search 为实际搜索；total 从 fixture 创建开始。进程启动和模块加载不计入 total。未测得的时间及区间用 — 表示。安全区间是效用界，不是胜率；表内四舍五入，完整精度见 JSONL。单样本结果受环境影响，不能外推为常驻 worker 性能保证。

## 未在 10 秒内求解的 case

| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| garchomp-100-vs-primarina-100 | not-within-budget | false | -0.979 | -0.342 | 0.638 | 160.846 | 10000.721 | 10170.409 |
| garchomp-25-vs-archaludon-100 | not-within-budget | false | -0.917 | 1.000 | 1.917 | 163.138 | 10000.575 | 10171.956 |
| garchomp-50-vs-archaludon-100 | not-within-budget | false | -0.917 | 1.000 | 1.917 | 160.469 | 10000.677 | 10171.013 |
| garchomp-100-vs-archaludon-100 | not-within-budget | false | -0.917 | 1.000 | 1.917 | 167.191 | 10000.752 | 10177.193 |
| garchomp-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 162.438 | 10000.545 | 10171.489 |
| garchomp-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.921 | 0.079 | 161.291 | 10000.750 | 10170.217 |
| garchomp-100-vs-mimikyu-50 | not-within-budget | false | -0.800 | -0.261 | 0.539 | 168.222 | 10000.765 | 10179.239 |
| garchomp-100-vs-mimikyu-100 | not-within-budget | false | -0.932 | -0.261 | 0.670 | 162.734 | 10000.584 | 10171.553 |
| primarina-50-vs-archaludon-100 | not-within-budget | false | -0.922 | 0.691 | 1.613 | 165.567 | 10000.946 | 10174.578 |
| primarina-100-vs-archaludon-25 | not-within-budget | false | 0.950 | 1.000 | 0.050 | 163.139 | 10000.671 | 10171.851 |
| primarina-100-vs-archaludon-50 | not-within-budget | false | 0.833 | 1.000 | 0.167 | 163.022 | 10000.699 | 10172.161 |
| primarina-100-vs-archaludon-100 | not-within-budget | false | -0.919 | 1.000 | 1.919 | 164.330 | 10000.723 | 10173.362 |
| primarina-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 162.518 | 10000.832 | 10171.572 |
| primarina-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.980 | 0.020 | 163.834 | 10000.566 | 10172.537 |
| primarina-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.926 | 0.074 | 162.255 | 10000.749 | 10171.372 |
| primarina-50-vs-mimikyu-25 | not-within-budget | false | -0.964 | 0.242 | 1.206 | 174.903 | 10000.524 | 10183.896 |
| primarina-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 165.353 | 10000.579 | 10174.345 |
| primarina-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 162.894 | 10000.698 | 10171.962 |
| primarina-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 163.676 | 10000.905 | 10172.994 |
| primarina-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 164.499 | 10000.802 | 10173.572 |
| primarina-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 163.212 | 10004.069 | 10176.204 |
| archaludon-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 168.914 | 10000.606 | 10178.926 |
| archaludon-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 166.454 | 10000.407 | 10175.241 |
| archaludon-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.340 | 1.340 | 167.421 | 10000.550 | 10177.027 |
| archaludon-50-vs-mimikyu-25 | not-within-budget | false | -0.903 | 0.830 | 1.733 | 164.899 | 10000.758 | 10173.991 |
| archaludon-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 165.715 | 10000.631 | 10175.797 |
| archaludon-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 162.842 | 10000.743 | 10172.355 |
| archaludon-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 161.757 | 10000.436 | 10170.423 |
| archaludon-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 163.843 | 10000.657 | 10173.422 |
| archaludon-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 161.570 | 10000.743 | 10170.757 |

## 所有可测 case

| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| garchomp-25-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 165.690 | 34.352 | 208.593 |
| garchomp-25-vs-primarina-50 | within-budget | true | -0.917 | -0.917 | 0.000 | 169.059 | 945.477 | 1123.187 |
| garchomp-25-vs-primarina-100 | within-budget | true | -0.979 | -0.979 | 0.000 | 163.650 | 1438.362 | 1610.042 |
| garchomp-50-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 167.153 | 32.086 | 207.235 |
| garchomp-50-vs-primarina-50 | within-budget | true | -0.917 | -0.917 | 0.000 | 168.593 | 853.710 | 1031.918 |
| garchomp-50-vs-primarina-100 | within-budget | true | -0.979 | -0.979 | 0.000 | 168.619 | 1319.025 | 1496.625 |
| garchomp-100-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 162.748 | 32.248 | 203.431 |
| garchomp-100-vs-primarina-50 | within-budget | true | -0.917 | -0.897 | 0.019 | 162.793 | 8977.795 | 9149.778 |
| garchomp-100-vs-primarina-100 | not-within-budget | false | -0.979 | -0.342 | 0.638 | 160.846 | 10000.721 | 10170.409 |
| garchomp-25-vs-archaludon-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 162.080 | 66.828 | 238.419 |
| garchomp-25-vs-archaludon-50 | within-budget | true | 1.000 | 1.000 | 0.000 | 163.125 | 70.587 | 242.323 |
| garchomp-25-vs-archaludon-100 | not-within-budget | false | -0.917 | 1.000 | 1.917 | 163.138 | 10000.575 | 10171.956 |
| garchomp-50-vs-archaludon-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 163.927 | 67.878 | 240.478 |
| garchomp-50-vs-archaludon-50 | within-budget | true | 1.000 | 1.000 | 0.000 | 163.895 | 68.960 | 241.646 |
| garchomp-50-vs-archaludon-100 | not-within-budget | false | -0.917 | 1.000 | 1.917 | 160.469 | 10000.677 | 10171.013 |
| garchomp-100-vs-archaludon-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 173.089 | 68.093 | 250.060 |
| garchomp-100-vs-archaludon-50 | within-budget | true | 1.000 | 1.000 | 0.000 | 185.960 | 67.518 | 266.655 |
| garchomp-100-vs-archaludon-100 | not-within-budget | false | -0.917 | 1.000 | 1.917 | 167.191 | 10000.752 | 10177.193 |
| garchomp-25-vs-mimikyu-25 | within-budget | true | -1.000 | -1.000 | 0.000 | 162.624 | 1140.873 | 1312.097 |
| garchomp-25-vs-mimikyu-50 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.410 | 1190.328 | 1362.867 |
| garchomp-25-vs-mimikyu-100 | within-budget | true | -1.000 | -1.000 | 0.000 | 163.753 | 1202.575 | 1374.763 |
| garchomp-50-vs-mimikyu-25 | within-budget | true | -0.800 | -0.800 | 0.000 | 171.728 | 1383.212 | 1563.307 |
| garchomp-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 162.438 | 10000.545 | 10171.489 |
| garchomp-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.921 | 0.079 | 161.291 | 10000.750 | 10170.217 |
| garchomp-100-vs-mimikyu-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 165.379 | 1787.624 | 1961.291 |
| garchomp-100-vs-mimikyu-50 | not-within-budget | false | -0.800 | -0.261 | 0.539 | 168.222 | 10000.765 | 10179.239 |
| garchomp-100-vs-mimikyu-100 | not-within-budget | false | -0.932 | -0.261 | 0.670 | 162.734 | 10000.584 | 10171.553 |
| primarina-25-vs-archaludon-25 | within-budget | true | -1.000 | -1.000 | 0.000 | 169.051 | 1051.178 | 1228.354 |
| primarina-25-vs-archaludon-50 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.884 | 1280.757 | 1453.829 |
| primarina-25-vs-archaludon-100 | within-budget | true | -1.000 | -1.000 | 0.000 | 164.146 | 1810.205 | 1982.608 |
| primarina-50-vs-archaludon-25 | within-budget | true | 0.869 | 0.887 | 0.018 | 172.357 | 4102.744 | 4284.115 |
| primarina-50-vs-archaludon-50 | within-budget | true | 0.852 | 0.872 | 0.019 | 168.535 | 6933.617 | 7110.581 |
| primarina-50-vs-archaludon-100 | not-within-budget | false | -0.922 | 0.691 | 1.613 | 165.567 | 10000.946 | 10174.578 |
| primarina-100-vs-archaludon-25 | not-within-budget | false | 0.950 | 1.000 | 0.050 | 163.139 | 10000.671 | 10171.851 |
| primarina-100-vs-archaludon-50 | not-within-budget | false | 0.833 | 1.000 | 0.167 | 163.022 | 10000.699 | 10172.161 |
| primarina-100-vs-archaludon-100 | not-within-budget | false | -0.919 | 1.000 | 1.919 | 164.330 | 10000.723 | 10173.362 |
| primarina-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 162.518 | 10000.832 | 10171.572 |
| primarina-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.980 | 0.020 | 163.834 | 10000.566 | 10172.537 |
| primarina-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.926 | 0.074 | 162.255 | 10000.749 | 10171.372 |
| primarina-50-vs-mimikyu-25 | not-within-budget | false | -0.964 | 0.242 | 1.206 | 174.903 | 10000.524 | 10183.896 |
| primarina-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 165.353 | 10000.579 | 10174.345 |
| primarina-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.859 | 1.859 | 162.894 | 10000.698 | 10171.962 |
| primarina-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 163.676 | 10000.905 | 10172.994 |
| primarina-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 164.499 | 10000.802 | 10173.572 |
| primarina-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 163.212 | 10004.069 | 10176.204 |
| archaludon-25-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 168.914 | 10000.606 | 10178.926 |
| archaludon-25-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.310 | 1.310 | 166.454 | 10000.407 | 10175.241 |
| archaludon-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.340 | 1.340 | 167.421 | 10000.550 | 10177.027 |
| archaludon-50-vs-mimikyu-25 | not-within-budget | false | -0.903 | 0.830 | 1.733 | 164.899 | 10000.758 | 10173.991 |
| archaludon-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 165.715 | 10000.631 | 10175.797 |
| archaludon-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.995 | 1.995 | 162.842 | 10000.743 | 10172.355 |
| archaludon-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 161.757 | 10000.436 | 10170.423 |
| archaludon-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 163.843 | 10000.657 | 10173.422 |
| archaludon-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 161.570 | 10000.743 | 10170.757 |

## 各配对统计

| 配对 | 10 秒内达标 | 未达标 |
| --- | --- | --- |
| garchomp vs primarina | 8 | 1 |
| garchomp vs archaludon | 6 | 3 |
| garchomp vs mimikyu | 5 | 4 |
| primarina vs archaludon | 5 | 4 |
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
