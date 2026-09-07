# 开发与验证

使用 Node.js 24+；nvm 用户可运行 `nvm install && nvm use`。`npm ci` 按锁文件安装依赖，模拟器仍固定为 `@pkmn/sim@0.10.11`。

源码在 `src/*.ts`，测试与辅助模块在 `test/**/*.ts`，`npm run build` 使用 TypeScript 分别编译到 `dist/src/` 和 `dist/test/`，同时生成声明文件和 source map。运行时保持 CommonJS，worker 加载同一目录中的编译产物。`dist/` 不提交。

```bash
npm run typecheck
npm run build
node --test dist/test/solver.test.js
node --test --test-concurrency=4 dist/test/*.test.js
```

`npm test` 自动构建并运行完整测试。源码和测试一起参加类型检查与编译，测试从 `dist/test/` 加载 `dist/src/`，验证实际运行代码；直接运行单文件测试前须重新构建。使用上述显式测试路径，避免 Node 自动发现源码测试或将辅助模块计为测试。CLI 使用 `npm run demo` 和 `npm run benchmark -- <参数>`，二者也会自动构建。

本次采用渐进类型检查：求解器选项、收益矩阵、策略、转移、PP 缓存和线程池已有类型；模拟器反射、动态回调和自定义 adapter 仍存在宽类型与隐式 `any`，尚未启用 `strict`。类型检查不能替代原生分布等价、区间证书与回退测试。
