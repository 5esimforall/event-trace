# AGENTS

本文件指导自动化助手在 Event Trace 项目中工作。

开始任务前，必须先阅读并遵循工作区公共规则 [../../AGENTS.md](../../AGENTS.md)，再阅读本文件。以下仅列出项目专属要求。

## 项目入口

- `DESIGN.md`：产品愿景、目标体验、边界与成功标准。
- `docs/implementation.md`：Foundry V13 约束、数据模型、归因/裁剪规则、权限门禁与测试要求。
- `types/api.d.ts`：公开 `EventTraceApi`、`TargetRef`、`TraceFilter` 与 `TraceSnapshotEnvelope` 契约；保持公开类型兼容。
- `README.md`：项目结构、开发检查、打包与实机验证指南。
- `module/README.md`：用户向使用说明、界面操作与当前边界。
- `module/scripts/`：运行时 ESM 源码（含 `// @ts-check` 与 JSDoc）。
- `tests/`：纯逻辑单元测试与 jsdom 集成夹具。

## 领域术语

区分 `event`（四类：`document`、`notification`、`interception`、`error`）、`diff entry`（`set`/`add`/`remove`）、`attribution`（`module`/`system`/`core`/`user`/`unknown`）、`action group`（`standalone`/`sync-stack`/`time-window`）、`section`（战斗轮回合或时间间隔分段）、`TargetRef` 与 `snapshot`，定义见 `docs/implementation.md` 第 3 节。

## 实现原则

1. **只读观察**：绝不向世界数据库、Setting 历史或 `Document.flags` 写入追踪历史，不修改原生业务流程与返回值。
2. **Hooks 共存与重入保护**：`Hooks.on`/`once`/`off`/`call` 必须保留原生返回值与函数引用注销语义；栈解析须同时跳过 `/modules/event-trace/scripts/attribution.mjs` 与 `/modules/runtime-monitor/scripts/probes.mjs`，避免先加载方误归因；所有探针入口须防重入。
3. **严格权限门禁**：玩家视角必须过滤隐藏/秘密 Token、隐藏战斗参与者、不可见消息、他人用户或受限世界设置，并对不可读掷骰脱敏（`concealed: true`）。
4. **零硬依赖**：`module.json` 不声明 `relationships.requires`；对端跳转均经 `game.modules.get(id)` 运行时探测 `active` 与 `api` 方法后按需渲染。

## 验证与部署

完整检查与测试命令为：

```sh
npm run check
npm test
npm run package
```

`npm run check` 依次执行本地化键检查（`tools/check-lang.mjs`）、语法检查（`tools/check-syntax.mjs`）与 `tsc --noEmit`。打包输出位于 `dist/event-trace-v0.1.0.zip`，包内仅包含 `event-trace/` 下的运行时 `module/` 文件，不含 `types/`、`tsconfig.json`、`tests/` 或 `node_modules/`。实机变更应在工作区 `tools/fvtt-dev.mjs --link event-trace` 隔离实例中检查 GM 与玩家视角，结束后恢复临时状态。
