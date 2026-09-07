# Champions 单打前十：2026-09-07 测量结果

输入与复现口径见 [Champions 筛查](../champions-benchmark.md)。原始结果见 [JSONL](data/strategy-certificates-2026-09-07/final-sweep.jsonl)，算法与重复测量见[本轮验收记录](strategy-certificates-2026-09-07.md)。

完成 405/405 项；可测 54 项，跳过 351 项。10 秒内达标 29 项，未达标 25 项。状态计数：`{"within-budget":29,"not-within-budget":25,"skipped":351}`。

## 环境

- 开始时间：2026-09-07T18:01:19.910Z；数据版本：20260903163627216（2026-09-03T16:36:27.216Z）。
- 固定测量提交：`286c7f1372273f96828b88f077f8584e7d0b75ce`；已包含本轮求解器优化，fixture、原始快照和扫描参数保持不变。
- Node v24.20.0，@pkmn/sim 0.10.11；linux 5.15.167.4-microsoft-standard-WSL2；13th Gen Intel(R) Core(TM) i5-13600K。
- 命令：`node dist/src/champions-benchmark.js`。
- backend=sync，workers=0，预热=0，每 case 样本=1，串行、新进程；原生最大 PP。
- 容差 0.02，搜索预算 10000 ms，watchdog 30000 ms，lazyCells=false，selectionPolicy=auto。

prepare 为审计与准备；search 为实际搜索；total 从 fixture 创建开始。进程启动和模块加载不计入 total。未测得的时间及区间用 — 表示。安全区间是效用界，不是胜率；表内四舍五入，完整精度见 JSONL。单样本结果受环境影响，不能外推为常驻 worker 性能保证。

## 未在 10 秒内求解的 case

| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| garchomp-100-vs-primarina-100 | not-within-budget | false | -0.979 | -0.954 | 0.025 | 162.149 | 10000.729 | 10171.044 |
| garchomp-25-vs-archaludon-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 162.486 | 10000.583 | 10172.103 |
| garchomp-50-vs-archaludon-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 159.282 | 10000.530 | 10168.049 |
| garchomp-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 162.114 | 10000.700 | 10171.307 |
| garchomp-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.923 | 0.077 | 161.807 | 10000.621 | 10170.628 |
| garchomp-100-vs-mimikyu-50 | not-within-budget | false | -0.800 | -0.135 | 0.665 | 161.616 | 10000.678 | 10170.785 |
| garchomp-100-vs-mimikyu-100 | not-within-budget | false | -0.884 | -0.135 | 0.749 | 165.255 | 10000.689 | 10174.588 |
| primarina-50-vs-archaludon-100 | not-within-budget | false | -0.922 | -0.688 | 0.235 | 165.252 | 10000.766 | 10174.365 |
| primarina-100-vs-archaludon-25 | not-within-budget | false | 0.978 | 1.000 | 0.022 | 163.676 | 10000.465 | 10173.183 |
| primarina-100-vs-archaludon-50 | not-within-budget | false | 0.880 | 1.000 | 0.120 | 163.010 | 10000.428 | 10171.681 |
| primarina-100-vs-archaludon-100 | not-within-budget | false | -0.908 | 1.000 | 1.908 | 166.560 | 10000.566 | 10176.043 |
| primarina-50-vs-mimikyu-50 | not-within-budget | false | -0.998 | -0.389 | 0.610 | 164.008 | 10000.411 | 10172.612 |
| primarina-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.676 | 1.676 | 163.102 | 10000.661 | 10172.327 |
| primarina-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 168.708 | 10000.655 | 10177.699 |
| primarina-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 172.076 | 10000.664 | 10181.141 |
| primarina-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 165.227 | 10000.785 | 10174.518 |
| archaludon-25-vs-mimikyu-25 | not-within-budget | false | -0.930 | -0.800 | 0.130 | 165.529 | 10000.548 | 10174.352 |
| archaludon-25-vs-mimikyu-50 | not-within-budget | false | -0.965 | -0.800 | 0.165 | 164.639 | 10000.502 | 10173.955 |
| archaludon-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 163.012 | 10000.596 | 10172.219 |
| archaludon-50-vs-mimikyu-25 | not-within-budget | false | -0.803 | -0.620 | 0.183 | 162.015 | 10000.563 | 10170.745 |
| archaludon-50-vs-mimikyu-50 | not-within-budget | false | -0.820 | 0.830 | 1.650 | 162.814 | 10000.638 | 10171.672 |
| archaludon-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.830 | 1.830 | 165.156 | 10000.730 | 10174.156 |
| archaludon-100-vs-mimikyu-25 | not-within-budget | false | 0.603 | 1.000 | 0.397 | 162.490 | 10000.449 | 10171.565 |
| archaludon-100-vs-mimikyu-50 | not-within-budget | false | -0.570 | 1.000 | 1.570 | 163.657 | 10002.659 | 10174.730 |
| archaludon-100-vs-mimikyu-100 | not-within-budget | false | -0.570 | 1.000 | 1.570 | 163.858 | 10000.692 | 10172.948 |

## 所有可测 case

| Case | 状态 | 收敛 | 下界 | 上界 | 宽度 | prepare ms | search ms | total ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| garchomp-25-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 171.943 | 32.060 | 212.912 |
| garchomp-25-vs-primarina-50 | within-budget | true | -0.917 | -0.917 | 0.000 | 166.412 | 650.293 | 825.045 |
| garchomp-25-vs-primarina-100 | within-budget | true | -0.979 | -0.979 | 0.000 | 163.316 | 998.710 | 1170.183 |
| garchomp-50-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 159.877 | 28.049 | 196.172 |
| garchomp-50-vs-primarina-50 | within-budget | true | -0.917 | -0.917 | 0.000 | 162.413 | 617.899 | 788.619 |
| garchomp-50-vs-primarina-100 | within-budget | true | -0.979 | -0.979 | 0.000 | 161.926 | 992.177 | 1162.502 |
| garchomp-100-vs-primarina-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 159.367 | 28.750 | 196.234 |
| garchomp-100-vs-primarina-50 | within-budget | true | -0.917 | -0.897 | 0.019 | 161.600 | 3711.787 | 3881.744 |
| garchomp-100-vs-primarina-100 | not-within-budget | false | -0.979 | -0.954 | 0.025 | 162.149 | 10000.729 | 10171.044 |
| garchomp-25-vs-archaludon-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 162.433 | 60.630 | 231.397 |
| garchomp-25-vs-archaludon-50 | within-budget | true | 1.000 | 1.000 | 0.000 | 160.931 | 58.252 | 227.248 |
| garchomp-25-vs-archaludon-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 162.486 | 10000.583 | 10172.103 |
| garchomp-50-vs-archaludon-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 161.771 | 59.402 | 229.424 |
| garchomp-50-vs-archaludon-50 | within-budget | true | 1.000 | 1.000 | 0.000 | 162.954 | 58.083 | 229.298 |
| garchomp-50-vs-archaludon-100 | not-within-budget | false | -1.000 | 1.000 | 2.000 | 159.282 | 10000.530 | 10168.049 |
| garchomp-100-vs-archaludon-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 161.555 | 58.063 | 228.197 |
| garchomp-100-vs-archaludon-50 | within-budget | true | 1.000 | 1.000 | 0.000 | 159.295 | 59.721 | 227.133 |
| garchomp-100-vs-archaludon-100 | within-budget | true | 0.980 | 1.000 | 0.020 | 165.291 | 7891.685 | 8065.148 |
| garchomp-25-vs-mimikyu-25 | within-budget | true | -1.000 | -1.000 | 0.000 | 163.900 | 1594.463 | 1767.471 |
| garchomp-25-vs-mimikyu-50 | within-budget | true | -1.000 | -1.000 | 0.000 | 168.216 | 1640.524 | 1817.868 |
| garchomp-25-vs-mimikyu-100 | within-budget | true | -1.000 | -1.000 | 0.000 | 161.900 | 1832.654 | 2003.078 |
| garchomp-50-vs-mimikyu-25 | within-budget | true | -0.800 | -0.800 | 0.000 | 165.173 | 1855.783 | 2029.573 |
| garchomp-50-vs-mimikyu-50 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 162.114 | 10000.700 | 10171.307 |
| garchomp-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.923 | 0.077 | 161.807 | 10000.621 | 10170.628 |
| garchomp-100-vs-mimikyu-25 | within-budget | true | 1.000 | 1.000 | 0.000 | 161.958 | 1209.155 | 1379.528 |
| garchomp-100-vs-mimikyu-50 | not-within-budget | false | -0.800 | -0.135 | 0.665 | 161.616 | 10000.678 | 10170.785 |
| garchomp-100-vs-mimikyu-100 | not-within-budget | false | -0.884 | -0.135 | 0.749 | 165.255 | 10000.689 | 10174.588 |
| primarina-25-vs-archaludon-25 | within-budget | true | -1.000 | -1.000 | 0.000 | 161.728 | 764.408 | 934.467 |
| primarina-25-vs-archaludon-50 | within-budget | true | -1.000 | -1.000 | 0.000 | 165.114 | 962.665 | 1136.513 |
| primarina-25-vs-archaludon-100 | within-budget | true | -1.000 | -1.000 | 0.000 | 161.365 | 1451.984 | 1621.391 |
| primarina-50-vs-archaludon-25 | within-budget | true | 0.869 | 0.887 | 0.018 | 162.266 | 2673.141 | 2843.635 |
| primarina-50-vs-archaludon-50 | within-budget | true | 0.852 | 0.872 | 0.019 | 166.426 | 3629.923 | 3804.500 |
| primarina-50-vs-archaludon-100 | not-within-budget | false | -0.922 | -0.688 | 0.235 | 165.252 | 10000.766 | 10174.365 |
| primarina-100-vs-archaludon-25 | not-within-budget | false | 0.978 | 1.000 | 0.022 | 163.676 | 10000.465 | 10173.183 |
| primarina-100-vs-archaludon-50 | not-within-budget | false | 0.880 | 1.000 | 0.120 | 163.010 | 10000.428 | 10171.681 |
| primarina-100-vs-archaludon-100 | not-within-budget | false | -0.908 | 1.000 | 1.908 | 166.560 | 10000.566 | 10176.043 |
| primarina-25-vs-mimikyu-25 | within-budget | true | -1.000 | -0.981 | 0.019 | 165.245 | 4362.265 | 4535.634 |
| primarina-25-vs-mimikyu-50 | within-budget | true | -1.000 | -0.984 | 0.016 | 166.412 | 8643.093 | 8817.644 |
| primarina-25-vs-mimikyu-100 | within-budget | true | -1.000 | -0.980 | 0.020 | 164.993 | 9298.976 | 9472.102 |
| primarina-50-vs-mimikyu-25 | within-budget | true | -0.961 | -0.945 | 0.016 | 163.350 | 9013.033 | 9184.873 |
| primarina-50-vs-mimikyu-50 | not-within-budget | false | -0.998 | -0.389 | 0.610 | 164.008 | 10000.411 | 10172.612 |
| primarina-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.676 | 1.676 | 163.102 | 10000.661 | 10172.327 |
| primarina-100-vs-mimikyu-25 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 168.708 | 10000.655 | 10177.699 |
| primarina-100-vs-mimikyu-50 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 172.076 | 10000.664 | 10181.141 |
| primarina-100-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.977 | 1.977 | 165.227 | 10000.785 | 10174.518 |
| archaludon-25-vs-mimikyu-25 | not-within-budget | false | -0.930 | -0.800 | 0.130 | 165.529 | 10000.548 | 10174.352 |
| archaludon-25-vs-mimikyu-50 | not-within-budget | false | -0.965 | -0.800 | 0.165 | 164.639 | 10000.502 | 10173.955 |
| archaludon-25-vs-mimikyu-100 | not-within-budget | false | -1.000 | -0.800 | 0.200 | 163.012 | 10000.596 | 10172.219 |
| archaludon-50-vs-mimikyu-25 | not-within-budget | false | -0.803 | -0.620 | 0.183 | 162.015 | 10000.563 | 10170.745 |
| archaludon-50-vs-mimikyu-50 | not-within-budget | false | -0.820 | 0.830 | 1.650 | 162.814 | 10000.638 | 10171.672 |
| archaludon-50-vs-mimikyu-100 | not-within-budget | false | -1.000 | 0.830 | 1.830 | 165.156 | 10000.730 | 10174.156 |
| archaludon-100-vs-mimikyu-25 | not-within-budget | false | 0.603 | 1.000 | 0.397 | 162.490 | 10000.449 | 10171.565 |
| archaludon-100-vs-mimikyu-50 | not-within-budget | false | -0.570 | 1.000 | 1.570 | 163.657 | 10002.659 | 10174.730 |
| archaludon-100-vs-mimikyu-100 | not-within-budget | false | -0.570 | 1.000 | 1.570 | 163.858 | 10000.692 | 10172.948 |

## 各配对统计

| 配对 | 10 秒内达标 | 未达标 |
| --- | --- | --- |
| garchomp vs primarina | 8 | 1 |
| garchomp vs archaludon | 7 | 2 |
| garchomp vs mimikyu | 5 | 4 |
| primarina vs archaludon | 5 | 4 |
| primarina vs mimikyu | 4 | 5 |
| archaludon vs mimikyu | 0 | 9 |

## 跳过原因

- Meowscarada: Missing move ranks 1–4
- Hippowdon: Missing move ranks 1–4
- Gyarados: Mega evolution actions are not implemented: Gyaradosite
- Delphox: Mega evolution actions are not implemented: Delphoxite
- Dragonite: Mega evolution actions are not implemented: Dragoninite
- Metagross: Mega evolution actions are not implemented: Metagrossite

完整 405 个 case 的状态及逐项跳过原因保存在 JSONL；跳过项不计作求解超时。
