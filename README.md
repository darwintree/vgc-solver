# Pokémon 1v1 残局求解 Demo

使用 `@pkmn/sim@0.10.11` 作为 Pokémon Showdown 模拟器黑箱，并在每个回合求解零和矩阵博弈：

\[
Q_s(a,b)=\sum_{s'}P(s'\mid s,a,b)V(s'),\qquad V(s)=\operatorname{val}(Q_s).
\]

## 运行

```bash
npm install
npm test
npm run demo
```

需要 Node.js 20 或更高版本。

## 随机分支

求解器不会枚举 PRNG 种子。对每个行动组合，它会：

1. 用 `battle.toJSON()` 保存当前状态；
2. 用 `Battle.fromJSON()` 从同一状态重放；
3. 拦截本回合实际发生的 `random(n)` / `randomChance(p, q)`；
4. 对该随机调用的有限结果精确分叉；
5. 将相同的后继状态合并，再递归求值。

因此开销取决于模拟中真正出现的随机决策与不同后继状态，而不是所有随机数历史或所有种子。

## 三个测试局面

### 1. Trivial

双方均为 1 HP：Scizor 使用 Quick Attack，Blissey 使用 Tackle。先制攻击保证 P1 获胜：

```text
V = +1
```

### 2. Leftovers + Protect + 3HKO

双方均为 50 级 Pikachu，携带 Leftovers，技能为 Seismic Toss 与 Protect。Pikachu 有 110 HP，Seismic Toss 固定造成 50 点伤害，因此是 3HKO。

Demo 将残局 PP 设为：

```text
Seismic Toss: 4 PP
Protect:      1 PP
```

双方完全对称，因此：

```text
V = 0
```

### 3. Sucker Punch 博弈

双方均为 1 HP：

```text
低速 Kingambit: Sucker Punch / Knock Off
高速 Electrode: Protect / Tackle
```

根节点收益矩阵应为：

```text
                    Protect   Tackle
Sucker Punch           -1       +1
Knock Off               +1       -1
```

因此双方的均衡策略均为 `50% / 50%`，博弈价值为 `0`。

## 文件结构

```text
src/showdown-adapter.js  Showdown 状态复制、合法行动、随机分支枚举
src/branching-prng.js    可回放且可分叉的 PRNG facade
src/matrix-game.js       小型零和矩阵博弈求解器
src/solver.js            状态递归与缓存
src/cases.js             三个测试局面
src/demo.js              命令行输出
```

## 当前边界

这是小状态空间的精确 Demo，不是完整生产求解器：

- 支持测试局面会触发的有限离散随机调用；无参数的连续 `random()` 暂不支持；
- 假设残局由 PP 保证有限；若存在真正可再生的循环，需要改为随机博弈不动点求解；
- 内置矩阵求解器采用顶点枚举，适用于单打中至多四个技能的小矩阵；
- 直接使用了 Showdown 的底层状态序列化接口，因此依赖版本已固定。
