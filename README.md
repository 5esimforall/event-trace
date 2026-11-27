# Event Trace · 事件追踪

面向 Foundry VTT V13（13.351）的只读运行时事件账本模组：记录关键文档的字段级差异、按同步调用栈与短时间窗归组动作、合并屏幕通知历史、捕获可取消钩子的静默拦截与本机运行异常，并支持导出结构化 JSON 快照。

产品愿景与成功标准见 [DESIGN.md](DESIGN.md)，实现架构与 V13 约束见 [docs/implementation.md](docs/implementation.md)，用户说明见 [module/README.md](module/README.md)。

## 目录结构

- `module/`：可发行的 Foundry 模组源码（`module.json`、`scripts/`、`styles/`、`lang/`、`README.md`）。
  - `constants.mjs`：模块常量、容量/时间窗上下限、可取消钩子与观察文档清单。
  - `diff.mjs`：纯逻辑点分路径展开、`-=`/`==` 解析、`_stats` 降噪、数组/长文本/Data URI 裁剪。
  - `attribution.mjs`：跨浏览器栈帧归因与 `HookAttributionRegistry`（`Hooks.on`/`once`/`off`/`call` 包装与早加载拦截兜底）。
  - `trace.mjs`：权限与保密门禁、`TraceFilter`/`TargetRef` 归一化、通知签名、动作归组、时间线分段与分面筛选。
  - `store.mjs`：`TraceStore` 内存环形缓冲、10 秒前值缓存、同步栈维护、重复通知合并与版本 1 快照构造。
  - `format.mjs`：本地化时间、耗时、差异行（含“前值未缓存”标记）与分段标题格式化。
  - `window.mjs`：`TraceWindow`（`ApplicationV2` 直接构建 DOM，含 `data-trace-*` 事件委托、节流刷新与条件对端跳转）。
  - `main.mjs`：顶层 Hooks 安装、客户端设置/菜单/快捷键、`Notifications` 与错误监听、文档/上下文菜单与公开 `api`。
- `types/`：TypeScript 公共契约（`api.d.ts`）与内部类型声明（不进入发行包）。
- `tests/`：`node:test` + `jsdom` 单元测试与集成夹具。
- `tools/`：本地化校验（`check-lang.mjs`）、语法检查（`check-syntax.mjs`）与打发行包脚本（`package.mjs`）。

## 开发与验证

在 `projects/event-trace` 目录运行：

```sh
npm ci
npm run check
npm test
```

- `npm test`：运行 `node --test tests/*.test.mjs` 全部纯逻辑与 jsdom 夹具测试。
- `npm run typecheck`：运行 `tsc --noEmit` 对 `types/` 与 `module/scripts/*.mjs` 执行严格类型检查。
- `npm run check`：依次执行 `tools/check-lang.mjs`（中英文键集一致且无未用/缺失键）、`tools/check-syntax.mjs` 与 `npm run typecheck`。

## 隔离实机调试

从工作区根目录使用隔离实例启动验证（将 `my-test-world` 替换为测试世界）：

```sh
node tools/fvtt-dev.mjs --link event-trace --world my-test-world
```

实机重点核对 GM 与玩家视角下的文档前值差异、未链接 Token（`ActorDelta`）无重复事件、可取消钩子返回 `false` 的归因、`ui.notifications` 与异常捕获、JSON 快照结构以及与 `chat-lens`、`rule-lens`、`runtime-monitor`、`sidebar-layout` 的无依赖协同。

## 打包

```sh
npm run package
```

脚本会在 `dist/event-trace-v0.1.0.zip` 生成发行包，顶层目录为 `event-trace/`，仅包含 `module/` 下的运行时文件（自动排除 `.DS_Store`、`.claude` 与开发/测试/类型目录）。
