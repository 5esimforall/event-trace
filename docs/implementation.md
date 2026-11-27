# Event Trace 实现说明

本文规定实现结构、数据模型、归因与裁剪规则、视图机制、低耦合协作契约及验证要求；产品愿景见 [../DESIGN.md](../DESIGN.md)。
目标平台为 Foundry VTT V13，核心行为依据 13.351 源码核对：

- 钩子调度与错误转发：`client/helpers/hooks.mjs`、`client/hooks.mjs`
- 文档数据库流程与模型：`client/data/client-backend.mjs`、`common/abstract/document.mjs`、`common/abstract/_types.mjs`、`client/documents/abstract/client-document.mjs`
- 特定文档行为：`client/documents/actor-delta.mjs`、`client/documents/token.mjs`、`client/documents/combat.mjs`、`client/documents/collections/combat-encounters.mjs`、`client/documents/combatant.mjs`、`client/documents/chat-message.mjs`、`client/documents/setting.mjs`
- 通知、设置与界面：`client/applications/ui/notifications.mjs`、`client/helpers/client-settings.mjs`、`client/applications/sidebar/tabs/chat.mjs`、`client/applications/sidebar/tabs/combat-tracker.mjs`、`client/applications/sidebar/document-directory.mjs`、`client/applications/api/application.mjs`
- 运行环境、快捷键与工具：`client/game.mjs`、`client/config.mjs`、`client/helpers/interaction/client-keybindings.mjs`、`client/utils/helpers.mjs`、`common/utils/helpers.mjs`、`common/constants.mjs`、`node_modules/socket.io-client/build/esm/socket.js`

## 1. 原生 Foundry 13.351 约束

Event Trace 只做只读事件观测。以下 13.351 源码事实决定了“注册期一次抓栈 + 精准路径前值缓存 + 不写世界库”的实现策略：

| 约束 | 源码依据 | 实现规则 |
| --- | --- | --- |
| `Hooks.call` 严格检查 `=== false` 并同步中断 | `Hooks.call`（`client/helpers/hooks.mjs#L138-L149`）遍历 `Array.from(this.#events[hook])`，首个返回 `false` 即中断后续监听器并返回 `false`；`Hooks.callAll` 忽略返回值；`client/hooks.mjs#L42-L44` 明确异步 `Promise` 不可拦截 | 只针对 `pre*` 及核心可取消钩子监听拦截结果；不对异步回调做返回等待，也不伪造拦截 |
| `Hooks.off` 支持按函数引用或 `id` 注销 | `Hooks.on`（`client/helpers/hooks.mjs#L49-L59`）返回自增 `id` 供 `once`（`L70-L72`）共用；`Hooks.off`（`L81-L103`）在传入函数时按 `h.fn === fn` 匹配移除 | 注册期抓栈元数据写入外部映射表；若对可取消钩子包装 `fn`，同步维护 `originalFn -> wrappedFn` 映射并包装 `Hooks.off`，确保按原函数注销不失效 |
| `update*` 钩子触发前 `_source` 已改写 | `ClientDatabaseBackend##handleUpdateDocuments`（`client/data/client-backend.mjs#L293-L300`）先执行 `doc.updateSource(change, options)` 并写回集合，随后才触发 `Hooks.callAll("update" + type, doc, change, options, userId)`；`socket.prependAny(listener)`（`node_modules/socket.io-client/build/esm/socket.js#L740`、`client/game.mjs#L514, L1827`）仅接收单参 `(event, ...args)` 回调 | 本机发起的更新在 `preUpdate*`（`L224`）时从 `doc._source` 读取受影响路径的前值；远端广播仅在启用时通过只读单参 `game.socket.prependAny((event, response) => ...)` 并在回调内判定 `event === "modifyDocument"`，于 `#onModifyDocument` 之前读取变更路径前值，否则 `before` 记为 `undefined` |
| 合成 Token Actor 经 `ActorDelta` 双路触发 | `#adjustActorDeltaRequest`（`client-backend.mjs#L591-L605`）将未链接 Token 的 Actor 更新改写为 `ActorDelta` 请求；`ActorDelta#_onUpdate`（`client/documents/actor-delta.mjs#L203-L208`）再仿真触发 `Hooks.callAll("updateActor", this.syntheticActor, ...)` | 订阅 `Actor`、`Item`、`ActiveEffect` 等钩子而跳过冗余的 `updateActorDelta`，前值缓存同时索引 `syntheticActor.uuid` 与关联 `delta.uuid` |
| `pre*` 仅在本机触发，内部异步钩子不可归因给模块回调 | `preCreate*`/`preUpdate*`/`preDelete*`（`client-backend.mjs#L99, L224, L361`）与 `preMoveToken`（`client/documents/token.mjs#L1434`）只在发起端调用；`_preCreate`/`_preUpdate`/`_pre*Operation` 为文档类异步覆盖方法 | 仅对 `Hooks.call` 返回 `false` 的拦截归因到注册回调；文档类内部校验或 `_pre*Operation` 阻止不强行覆写各文档类方法 |
| `TokenDocument#visible` 委托给场景、未覆盖 `hidden` | `ClientDocumentMixin#visible`（`client/documents/abstract/client-document.mjs#L193-L196`）返回 `this.parent.visible`；`TokenDocument#isOwner` 与 `#isSecret` 见 `client/documents/token.mjs#L165-L190`；`Combatant#visible` 为 `this.isOwner \|\| !this.hidden`（`client/documents/combatant.mjs#L74-L76`） | 玩家端对 `TokenDocument` 额外校验 `!(doc.hidden && !doc.isOwner)` 且过滤 `doc.isSecret`；对 `Combatant` 校验 `doc.visible` |
| `ChatMessage` 存在可见与内容可见两层门禁 | `ChatMessage#visible` 与 `#isContentVisible`（`client/documents/chat-message.mjs#L75-L108`）：他人暗骰与带 `whisper` 的掷骰 `visible` 为真但 `isContentVisible` 为假 | `!message.visible` 的消息直接跳过不入表；`visible && !isContentVisible` 仅记录事件存在与可见标签，脱敏正文、风味文字与掷骰数值 |
| `Notifications` 统一经 `notify` 且构造早于 `ready` | `Game#initializeUI`（`client/game.mjs#L977`）按 `CONFIG.ui.notifications`（`client/config.mjs#L2444`）构造 `ui.notifications`；构造函数即调用 `#initialize` 推入 `globalThis.MESSAGES`；`info`/`warn`/`error`/`success` 全部转发到 `notify`（`client/applications/ui/notifications.mjs#L134-L219`） | 在 `init` 阶段包装 `CONFIG.ui.notifications.prototype.notify` 与 `.update`，不改动队列、生命周期和原生渲染，连带捕获启动期提示与进度条更新 |
| `Hooks.onError` 与全局运行异常 | `Hooks.#call`（`client/helpers/hooks.mjs#L164-L167`）捕获回调异常后调用 `Hooks.onError("Hooks.#call", err, {msg, hook, fn, log: "error"})` 并派发 `Hooks.callAll("error", location, error, data)`（`L182-L188`） | 监听 `Hooks.on("error", ...)`、以及 `window` 的 `error`（只收含 `error`/`filename` 的脚本异常，排除静态资源加载元素失败）与 `unhandledrejection` |
| 设置变更同时存在文档与客户端事件 | 世界/用户级设置通过 `Setting` 文档经 `createSetting`/`updateSetting`/`deleteSetting` 广播（`common/documents/setting.mjs#L39-L48`）；客户端设置触发 `Hooks.callAll("clientSettingChanged", key, value, options)`（`client/helpers/client-settings.mjs#L321`） | 两路监听并以 `setting.key` + 短时窗口统一归一化；对非 GM 用户过滤其他用户私有或受限世界设置详情 |
| 战斗进度通过 `game.combat` 读取 | `game.combat` 返回 `this.combats?.viewed ?? null`（`client/game.mjs#L1611-L1613`）；`CombatEncounters#active` 见 `client/documents/collections/combat-encounters.mjs#L54-L56` | 事件记录附带 `game.combat` 或 `game.combats?.active` 的 `{ combatId, round, turn, combatantName }` 快照（仅在 `started` 或 `round > 0` 时） |
| `ApplicationV2` 根元素委托 `[data-action]` | `ApplicationV2`（`client/applications/api/application.mjs`）委托 `[data-action]` 点击；无 Handlebars 可通过 `_renderHTML` / `_replaceHTML` 直接返回并挂载 `HTMLElement` | `TraceWindow` 继承 `ApplicationV2`，自建 DOM、不使用 Handlebars，自身交互使用 `data-trace-*` 属性，便于 jsdom 测试 |

## 2. 目录结构

```
projects/event-trace/
  AGENTS.md  DESIGN.md  README.md  package.json  tsconfig.json
  docs/implementation.md
  types/api.d.ts         公开 API、Target Ref 与快照外框类型声明
  module/
    module.json  README.md
    scripts/
      constants.mjs    模块 id、本地化前缀、事件类别枚举、容量与时间窗阈值、裁剪规则常量
      diff.mjs         纯逻辑：点分路径展开、-= 与 == 特殊键处理、大字段与 data URI 裁剪
      attribution.mjs  纯逻辑与注册表：栈帧包名提取、Hooks.on 注册期归因、回调与错误归因
      trace.mjs        纯逻辑：事件归一化、通知合并、同步栈/短窗动作分组、分段、筛选与摘要
      store.mjs        TraceStore：有限环形缓冲、前值缓存、同步栈维护、节流通知、快照构造
      format.mjs       时间与时长格式化、BCP 47 语言映射、Diff 与分组摘要文本格式化
      window.mjs       TraceWindow（ApplicationV2）：筛选栏、分组时间线、详情区、快照导出与跳转
      main.mjs         包装 Hooks 与 Notifications、错误监听、文档/战斗钩子、入口注册与公开 api
    styles/event-trace.css
    lang/en.json  lang/cn.json
  tests/               diff、attribution、trace 纯逻辑与 window、main 夹具测试
  tools/               check-lang.mjs、check-syntax.mjs、package.mjs
```

`module.json`：id `event-trace`，标题 `Event Trace · 事件追踪`，版本 `0.1.0`，
兼容 `minimum 13 / verified 13.351 / maximum 13`，
不声明对 `chat-lens`、`runtime-monitor`、`rule-lens` 或 `sidebar-layout` 的 `requires` 依赖；
语言映射与 `chat-lens` 一致（`en`，以及 `cn`、`zh`、`zh-CN`、`zh-Hans` 指向 `lang/cn.json`），
本地化键前缀为 `EVENTTRACE.`。

## 3. 领域术语

| 术语 | 含义 |
| --- | --- |
| 事件（event） | 环形缓冲中的一条标准化只读事实，属于四类 `kind` 之一 |
| 类别（kind） | `document` 文档变更、`notification` 屏幕通知、`interception` 静默拦截、`error` 运行异常 |
| 字段差异（diff entry） | 单个叶子路径的变化 `{ path, op, before, after, truncated? }`，其中 `op` 为 `set`/`add`/`remove` |
| 归因（attribution） | 事件的来源推测：`{ sourceType, packageId, label, hookName?, fnName?, confidence }`，其中 `sourceType` 为 `module`/`system`/`core`/`user`/`unknown` |
| 动作组（action group） | 经同步调用嵌套或短时间窗聚合的一组关联事件，包含主标题、触发者与有序子事件 |
| 分段（section） | 时间线上的分段标题：战斗轮次/回合切换，或非战斗态跨日与 ≥ 5 分钟间隔 |
| 通知签名（notification signature） | 合并重复通知的键：`type` 与规范化后的纯文本（保留首次与最近时间及出现次数） |
| 环形缓冲（ring buffer） | 固定容量的内存历史队列，超出上限自动覆盖最旧事件，不写世界数据库 |
| 筛选条件（filter） | 公开与界面共用的只读视图过滤对象 `{ kind?, uuid?, messageId?, moduleId?, query? }` |
| 目标引用（target ref） | 跨模组协作使用的 Foundry 原生结构化标识，如 `{ type: "document", uuid }` |
| 快照（snapshot） | 带统一版本外框的可导出 JSON 对象，包含环境元信息、当前摘要、分组与事件列表 |

## 4. 核心数据模型与纯逻辑

### 事件记录模型

每条记录由纯函数归一化为稳定结构：

```js
{
  id: "ev-42",                 // 会话内单调递增序号标识
  seq: 42,
  timestamp: 1732700000000,
  kind: "document",            // "document" | "notification" | "interception" | "error"
  actionId: "act-18",          // 所属动作组 ID
  groupingBasis: "sync-stack", // "standalone" | "sync-stack" | "time-window"
  combat: {                    // 当前战斗进行中且可见时附带，否则 null
    combatId, round, turn, combatantName
  },
  user: {
    id, name, isSelf, remote   // remote 表示来自其他客户端的广播操作
  },
  attribution: {
    sourceType: "module",      // "module" | "system" | "core" | "user" | "unknown"
    packageId: "some-mod",     // 非包来源时为 null
    label: "some-mod",
    hookName: "updateActor",   // 若经特定钩子观测
    fnName: "onUpdate",
    confidence: "exact"        // "exact" | "inferred" | "unknown"
  },
  target: {                    // 供筛选与对端跳转的原生 Target Ref，可为 null
    type: "document",          // "document" | "message" | "module" | "hook" | "actorField"
    uuid, messageId, moduleId, hookName, path
  },
  summary: "Actor 哥布林 · system.attributes.hp.value: 12 → 5",
  detail: { ... },             // 随 kind 区分的结构化明细
  repeat: null,                // 通知合并时为 { count, firstAt, lastAt }
  concealed: false             // 私密掷骰等受限记录在脱敏保留摘要时标记为 true
}
```

四类事件的 `detail` 结构：

- `document`：`{ action: "create" | "update" | "delete", documentName, uuid, name, parentUuid?, diffs: DiffEntry[], omittedDiffCount, optionsSummary: { diff?, recursive?, render?, noHook? } }`；当 `documentName === "ChatMessage"` 时额外附带 `{ messageId, isRoll, rollCount }`；当 `documentName === "Setting"` 时附带 `{ key, scope }`。
- `notification`：`{ notificationId, level: "info" | "warning" | "error" | "success", text, permanent, progress, pct }`。
- `interception`：`{ hookName, targetUuid?, targetName?, reason: "returned-false", callbackRegisteredEarly? }`。
- `error`：`{ origin: "hooks" | "window-error" | "unhandledrejection", location?, message, stackLines: string[], contextUuid?, contextHook? }`。

### 字段级 Diff 与大字段裁剪（`diff.mjs`）

1. **变更展开**：使用 `foundry.utils.flattenObject`（逻辑上在纯模块中可独立实现以便单测）将 `changes` 展开为叶子路径。遇到 `-=key: null` 记为 `op: "remove"`，遇到 `==key` 去掉前缀 `==` 记为 `op: "set"`，其余按前值是否存在记为 `add` 或 `set`。
2. **前值配对**：
   - 本机发起：`preUpdate*` 触发时按变更路径集合从 `doc._source` 读取对应原始路径的浅克隆，写入短期挂起表（TTL 10 秒，防止请求被服务器拒绝后泄漏）。`update*` 落库后取出配对。
   - 远端广播：在通过 `game.socket.prependAny(listener)` 注册的单参监听回调中判定 `event === "modifyDocument"`（`response?.action === "update"` 且 `response.userId !== game.user.id`）时，按 `response.result` 涉及路径从当前内存集合读取一次旧值写入短期表；如遇到 `syntheticActorUpdate`（`ActorDelta`），按 `token.actor.uuid` 索引。未能取得前值时 `before` 保持 `undefined`，显示层明示“前值未缓存”。
3. **噪声过滤与大字段裁剪**：
   - 跳过纯技术性附带路径（如 `_stats.modifiedTime`、`_stats.lastModifiedBy`、`_stats.systemVersion` 等）以免每次编辑都产生噪音行；仅当变更对象除 `_stats` 外别无他字段时保留摘要。
   - `TokenDocument._movementHistory` 压缩为 `[waypoints: N]`；任意数组长度超过 12 项时只摘要元素数。
   - 字符串值超过 200 字符截断并附加 `…（共 N 字符）`；`data:...;base64,...` 类 Data URI 统一脱敏为 `[data-uri length=N]`。
   - 单条事件最多保留 24 条叶子 `DiffEntry`，超出部分记录 `omittedDiffCount`。
   - 为保持轻量化，对每次变更只读取受影响路径的旧值，不保存全量文档深拷贝；被排除的纯视口/高频冗余路径（如 `flags.core.sheetClass` 之外的纯渲染选项）可按常量表过滤。

### 权限与保密门禁

入库前与导出前均执行与当前 `game.user` 一致的可见性校验：

- 普通文档与嵌入文档：校验 `doc.visible`；若为 `TokenDocument`，额外要求 `game.user.isGM || !(doc.hidden && !doc.isOwner)` 且 `!doc.isSecret`；若为 `Combatant`，校验 `doc.visible`（`isOwner || !hidden`）。不满足时直接忽略，不进入环形缓冲。
- `ChatMessage`：`!message.visible` 跳过；`message.visible && !message.isContentVisible`（他人盲骰或私密掷骰）保留通知存在记录并将 `concealed: true`，清空正文、`content`/`flavor` 与 `rolls` 数值差异，防止玩家借事件流偷看暗骰结果。
- `Setting`：世界与用户级设置变更对非 GM 仅保留公开世界设置或 `setting.user === game.user.id` 的条目；已知仅 GM 可改 Key 或属于他人的用户设置跳过。

### 轻量动作分组与时间线分段（`trace.mjs`）

- **同步调用嵌套（`sync-stack`）**：在 `Hooks.call` 入口及本模组观察的钩子派发周期内压入栈帧（记录 `actionId`、根 `hookName`、根发起 `moduleId`）。栈深度 `> 0` 时产生的后续事件直接沿用栈顶 `actionId`，形成精确的同步因果归组；同步栈以 `try / finally` 弹出，确保异常不污染栈状态。
- **短时间窗合并（`time-window`）**：对本机同一 `user.id` 在同步栈外通过 `await` 连续落库（常见于异步数据库请求往返）的事件，若满足以下全部条件，则归入上一动作组：
  1. 与组内最近一条事件时间差 `<= ACTION_WINDOW_MS`（默认 `250ms`）；
  2. 同一发起用户且同一归因包（或其中一方为本地用户操作带出的后置 `document` 事件，或共享同一主 `Actor`/`Token`/`ChatMessage` 关联对象）。
- **通知合并**：仅对 `notification` 且 `progress === false` 的条目按签名 `level + "\n" + normalizeText(text)` 与前一条或近期同类通知合并；合并时原地更新 `repeat.count` 与 `repeat.lastAt`，不新增环形缓冲条目、不加入 `document` 动作组。进度通知按 `notificationId` 原地刷新 `text` 与 `pct`。
- **时间线分段**：对筛选后的顶层分组或事件流计算分段标题：
  - 当前条目的战斗 `(combatId, round, turn)` 与上一条不同且 `combat !== null` 时插入战斗分段头；
  - 否则若跨自然日，或相邻两条间隔 `>= 300_000` ms（5 分钟），插入日期/时刻分段头。

### 有限环形缓冲（`store.mjs`）

`TraceStore` 维护固定上限队列（默认 `500` 条，客户端设置可调 `200–2000`）。达到上限时从头部淘汰最旧事件并清理孤立分组索引；提供 `clear()` 清空当前会话内存。所有记录严格保存在运行内存中，不写入 `Setting`（历史数据）、`Document.flags` 或世界数据库。

## 5. 归因规则（`attribution.mjs`）

1. **注册期一次抓栈**：在入口脚本顶层求值阶段（早于各模块 `init` 回调执行）包装 `Hooks.on`（`Hooks.once` 内部委派给 `Hooks.on`，一次覆盖两者）与 `Hooks.off`。在 `Hooks.on(hook, fn, opts)` 被调用时捕获一次 `new Error().stack`，跳过 Foundry 核心文件帧与本模组自身帧，提取首个命中 `/modules/([^/]+)/` 或 `/systems/([^/]+)/` 的包 ID 与脚本位置，存入 `Map<hookId, Attribution>` 与 `WeakMap<fn, Attribution>`。正常事件触发期间不再执行栈捕获，保持零热路径抓栈开销。
2. **静默拦截识别与归因**：
   - 当 `Hooks.on` 注册的钩子名匹配 `/^pre[A-Z]/` 或核心可取消钩子集合（`hotbarDrop`、`chatInput`、`chatMessage`、`activateNote`、`dropCanvasData`、`dropActorSheetData`、`dropRollTableSheetData`、`modifyTokenAttribute`、`hotReload`、`configureCanvasEnvironment`、`chatBubbleHTML`、`dealCards`、`passCards`、`returnCards` 及 `paste*`）时，用轻包装器包裹回调并记录 `originalToWrapped` 映射；包装 `Hooks.off` 以在传入原函数引用时同步转为移除包装函数，保证注销行为与原生一致。
   - 若回调返回严格 `false`，同步压入一条 `interception` 事件，直接带上该回调在注册期记录的 `moduleId` / `fnName`。
   - 同时轻包装 `Hooks.call`：若原 `Hooks.call` 返回 `false` 但内层包装器尚未报告本次调用（例如某回调在 `event-trace` 加载前已注册），兜底补记一条 `interception` 事件，并注明 `callbackRegisteredEarly: true` 与当前可查候选监听器，避免漏报。
3. **本机文档更新归因**：在 `preCreate*` / `preUpdate*` / `preDelete*` 触发的当前同步调用栈中，优先复用同步动作栈或已知钩子归因上下文；当无上游钩子上下文且处于本机低频预校验阶段时，通过一次轻量 `Error.stack` 跳过核心与本模组栈帧并查找首个 `/modules/<id>/` 帧作为兜底，以此区分“用户在表单点击直接修改（`sourceType: "user"`）”、“宏脚本（`Macro` 特征帧）”与“某模组后台调用”。远端广播更新不猜测发起客户端的本地栈，统一标为 `remote: true`，来源显示 Foundry 原生 `user.name`。
4. **运行异常归因**：
   - 监听 `Hooks.on("error", (location, error, data) => ...)`：若 `data?.fn` 命中注册期 `WeakMap` 归因表（例如 `Hooks.#call` 抛出的异常直接携带 `data.fn` 与 `data.hook`），优先使用精确包名；否则解析 `error.stack` 与 `error.cause?.stack`。
   - 监听 `window` 的 `error` 事件：忽略 `event.target !== window`（资源加载失败由 Runtime Monitor 负责），仅处理 JS 运行异常，按 `event.error?.stack` 与 `event.filename` 归因。
   - 监听 `window` 的 `unhandledrejection` 事件：提取 `event.reason` 的消息与堆栈归因。
   - 所有包装器与监听器入口均设置重入保护开关，本模组内部逻辑异常不会递归写入自身。

## 6. 视图机制与快捷入口（`window.mjs`、`main.mjs`）

### `TraceWindow`（`ApplicationV2`）

- 继承 `foundry.applications.api.ApplicationV2`，window id 固定为 `event-trace-window`，单例管理，默认宽约 `760px`、高 `560px`，支持缩放。
- 通过 `_renderHTML` / `_replaceHTML` 自建 DOM，不使用 Handlebars 模板；窗口未打开时零 DOM 更新开销。
- 窗口打开后订阅 `TraceStore` 变更通知，使用 `requestAnimationFrame`（或 100ms 节流调度）合并高频刷新；窗口内筛选切换立即重算视图列表，不修改底层环形缓冲。
- 界面结构：
  1. **顶部筛选栏**：类别切换按钮（全部、`document`、`notification`、`interception`、`error`，每项带当前基数）、“聚焦当前选中”（读取 `canvas.tokens.controlled` 或当前用户指派角色，筛选关联 `uuid`）、模组下拉/文本筛选、关键词搜索框、“清空视图/缓冲”按钮、“导出快照”按钮。
  2. **状态行**：“显示 X / 共 Y 条（已归并 N 组）”与当前活跃焦点芯片（可一键清除外部传入的 `uuid`/`messageId`/`moduleId` 筛选）。
  3. **时间线主表**：按战斗或时间分段渲染；包含 ≥ 2 条事件的动作组渲染为可折叠 `<details>` 或带展开按钮的分组行，默认折叠为摘要；单条事件直接呈现时刻、类别徽章、目标名、简要 Diff 与归因标签。
  4. **右侧/下方选中详情区**：展示完整字段 Diff（前值 → 后值）、动作上下文、堆栈摘要、选项标志，并按需渲染对端跳转按钮（仅在目标有效且对端激活并暴露对应 `api` 时显示）：
     - 打开原文档表单（`fromUuidSync(uuid)?.sheet?.render(true)`）或定位画布 Token；
     - 若 `chat-lens` 激活且事件关联 `messageId`：按钮“在 Chat Lens 中定位” / “查看消息详情”；
     - 若 `rule-lens` 激活且事件涉及 Actor/ActiveEffect 字段变更或带掷骰的 `ChatMessage`：按钮“用 Rule Lens 解释”；
     - 若 `runtime-monitor` 激活且事件归因到具体 `moduleId` 或 `hookName`：按钮“在 Runtime Monitor 中查看”。

### 多入口与右键菜单（`main.mjs`）

- **快捷键**：`init` 阶段通过 `game.keybindings.register("event-trace", "open", ...)` 注册（`editable: []` 默认不冲突绑定），呼出或聚焦 `TraceWindow`。
- **设置菜单**：`init` 阶段通过 `game.settings.registerMenu("event-trace", "openTrace", ...)` 注册菜单入口（`restricted: false`）。
- **Sidebar Layout 动作**：`ready` 阶段检测 `game.modules.get("sidebar-layout")?.active` 且 `typeof api?.registerAction === "function"`，注册 `"event-trace.open"`；缺失时静默跳过。
- **原生上下文菜单**：各自通过原生钩子注册，不侵入其他模组 DOM：
  - `getChatMessageContextOptions`：通过 `li.dataset.messageId` 匹配可见消息；当 `TraceStore` 存在关联事件（或支持直接按 `{ messageId }` 打开筛选）时追加“查看关联事件（Event Trace）”。
  - `getActorContextOptions`：从 `li.closest("[data-entry-id]")?.dataset.entryId` 解析 `game.actors.get(entryId)?.uuid`，追加“查看变更时间线（Event Trace）”并以 `{ uuid }` 调用 `open({ uuid })`。
  - `getCombatTrackerContextOptions`：`client/applications/sidebar/tabs/combat-tracker.mjs#L163-L164` 调用 `_createContextMenu` 时未显式指定 `hookName`，按 `client/applications/api/application.mjs#L1226-L1232, L1702` 实际派发 `getCombatTrackerContextOptions`（其源码 JSDoc `@fires getCombatantContextOptions` 与运行时不符）。回调中先校验 `li.dataset?.combatantId`，再从 `(app.viewed ?? ui.combat?.viewed)?.combatants.get(li.dataset.combatantId)` 解析角色/Token UUID（`combatant.actor?.uuid ?? combatant.uuid`），追加“查看变更时间线（Event Trace）”。

## 7. 公开 API 与四模块低耦合协作

`game.modules.get("event-trace").api` 在 `ready` 阶段暴露以下只读/视图接口：

| 成员 | 签名与返回 | 用途 |
| --- | --- | --- |
| `open(filter?)` | `filter?: { kind?, uuid?, messageId?, moduleId?, query? }`，返回 `Promise<TraceWindow>` | 打开或前置 `TraceWindow` 并应用给定筛选；空参数保持当前或默认筛选 |
| `snapshot(options?)` | `options?: { filter?, limit?, windowMs? }`，返回快照对象 | 按统一快照外框返回最近或匹配筛选的结构化 JSON 对象（严格经过权限过滤与字段脱敏） |
| `summary()` | 无参，返回 `{ total, counts, unreadErrors, unreadInterceptions, lastEventAt, capacity }` | 供角标、状态栏或对端模组轻量读取当前事件流概况 |

### 统一 Target Ref 与对端调用契约

所有模块均通过原生标识传递上下文，互不声明 `module.json` 的 `requires`；每次交互运行时检查 `const peer = game.modules.get(id); if (peer?.active && peer?.api)`：

| 协作方向 | 目标或调用方式 | 缺席或无权限时的回退 |
| --- | --- | --- |
| 外部 → `event-trace` | `api.open({ kind?, uuid?, messageId?, moduleId?, query? })` | 调用方自身不渲染跳转入口 |
| `event-trace` → `chat-lens` | `chatLens.api.focusMessage(messageId)` 或 `openDetails(messageId)` | 隐藏“Chat Lens”跳转按钮；若原生侧栏存在对应 `[data-message-id]` 元素则仅提供滚动聚焦或不显示 |
| `event-trace` → `rule-lens` | 角色字段变更传 `ruleLens.api.open({ type: "actorField", uuid, path })`；ActiveEffect 传 `{ type: "effects", uuid: actorUuid, path? }`；掷骰消息传 `{ type: "roll", messageId }` | 隐藏“Rule Lens 解释”按钮；用户仍可直接打开原生角色卡或消息卡片 |
| `event-trace` → `runtime-monitor` | 传 `runtimeMonitor.api.open({ moduleId, hookName })`（或指定 `tab`） | 隐藏“Runtime Monitor”跳转按钮 |
| `event-trace` → `sidebar-layout` | `ready` 时 `sidebarLayout.api.registerAction({ id: "event-trace.open", label, icon, onClick })` | 不注册动作，通过快捷键与设置菜单使用 |

说明：统一 Target Ref 规范同时支持 `{ type: "document", uuid }`、`{ type: "message", messageId }`、`{ type: "module", moduleId }`、`{ type: "hook", hookName }`、`{ type: "actorField", uuid, path }`、`{ type: "visibility", uuid, userId? }`；`event-trace` 在解析外部跳转或未来扩展入口时直接将 `document`/`message`/`module`/`hook`/`actorField` 映射为对应 `filter` 字段（`uuid`、`messageId`、`moduleId`、`query`）。

### 统一快照外框

`snapshot(options?)` 与窗口“导出快照”按钮使用统一第 1 版外框（导出文件通过 `foundry.utils.saveDataToFile` 保存为 `event-trace-<worldId>-<timestamp>.json`）：

```js
{
  schemaVersion: 1,
  producer: "event-trace",
  moduleVersion: "0.1.0",
  exportedAt: "2026-11-27T09:30:00.000Z",
  foundryVersion: "13.351",
  systemId: "dnd5e",
  worldId: "my-world",
  userRole: "GAMEMASTER", // 来自 CONST.USER_ROLE_NAMES[game.user.role]
  data: {
    filter,
    summary,
    modules: [{ id, title, version }],
    groups: [...],
    events: [...]
  }
}
```

## 8. 客户端设置（`main.mjs`）

所有设置均使用 `scope: "client"`，绝不在世界数据库中存储追踪历史：

| 键 | 类型 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `maxEvents` | `Number` | `500` | 环形缓冲容量上限（约束在 `200–2000`） |
| `actionWindowMs` | `Number` | `250` | 短时间窗合并阈值（毫秒，`0–1000`） |
| `captureSettings` | `Boolean` | `true` | 是否记录 `Setting` 与 `clientSettingChanged` 变更 |
| `notifyOnInterception` | `Boolean` | `false` | 静默拦截发生时是否更新轻角标提示 |

## 9. 测试要求

使用 `node --test` 与 `jsdom`，并沿用 `chat-lens` 的 `tools/check-lang.mjs` 与 `tools/check-syntax.mjs`，同时在 `npm run check` 中运行 `tsc --noEmit` 检查 `types/` 与核心 `.mjs` 模块：

- **纯逻辑测试（`diff.test.mjs`、`attribution.test.mjs`、`trace.test.mjs`）**：
  - `diff`：嵌套属性展平、`-=` 与 `==` 特殊键解析、`before`/`after` 缺失回退、`_stats` 过滤、`_movementHistory` 摘要、超长文本截断、Data URI 脱敏与最大字段数截断。
  - `attribution`：Chromium/Firefox/Node 栈格式提取 `/modules/<id>/` 与 `/systems/<id>/`、跳过核心与自身栈帧、`Hooks.on` / `Hooks.once` 与 `Hooks.off(hook, originalFn)` 注册注销一致性、`Hooks.call` 返回 `false` 与早加载兜底。
  - `trace`：同步嵌套栈与 `250ms` 短窗合并、跨用户/超时拆分、通知重复合并与进度更新原地刷新、战斗轮次/回合分段与 5 分钟间隔分段、多维筛选组合、环形缓冲淘汰与容量限制、玩家视角对隐藏 Token / 秘密战斗者 / 暗骰消息与受限设置的脱敏、统一快照外框校验。
- **jsdom 夹具测试（`window.test.mjs`、`main.test.mjs`）**：
  - `TraceWindow` 自建 DOM 渲染、类别/模组/关键词筛选、`Esc` 或关闭后停止响应、`data-trace-*` 交互、折叠动作组展开。
  - 模拟 `game.modules` 在有/无 `chat-lens`、`rule-lens`、`runtime-monitor`、`sidebar-layout` 时的按钮显隐、参数传递与零依赖回退。
  - 模拟 `Hooks` 与 `Notifications`：验证 `notify`/`warn`/`error` 原样放行且入库、`Hooks.call` 返回 `false` 归因后仍正确返回 `false`、出错时重入保护不死循环。
- **隔离实机验证**：
  - 使用工作区 `tools/fvtt-dev.mjs --link event-trace` 启动隔离 V13.351 实例，分别以 GM 与玩家身份检查：修改角色生命/物品/效果与拖动 Token 的字段 Diff、未链接 Token（`ActorDelta`）更新无重复、故意注册返回 `false` 的测试 `preUpdateActor` 回调并验证拦截归因、触发 `ui.notifications.warn` 与未捕获异常验证归因、导出 JSON 快照校验外框及四模块联动跳转。

## 10. 当前边界

- 只支持 Foundry VTT V13，依据 13.351 源码实现。
- 仅在当前浏览器会话的内存环形缓冲中保留近期事件，页面刷新后重置，不写入世界数据库。
- 仅监听本地浏览器上下文；不解包 `socketlib` 等第三方远端 RPC 协议，其他客户端发起并广播到本机的更新忠实标注执行用户 `userId`。
- 远端更新的前值捕获依赖可选只读 `game.socket.prependAny`（若运行时不可用或未命中内存基线），未能取得前值时明确标注未缓存，不逆向猜测旧值。
- 静默拦截精确归因针对通过 `Hooks.call` 注册的同步回调；文档子类的异步 `_preUpdate` / `_preCreateOperation` 拦截或早于本模组加载前已注册的回调，不强行劫持核心文档类方法。
- 只捕获本机 JS 运行错误（`Hooks.on("error")`、`window` `error`/`unhandledrejection`），静态资源加载失败不重复记录（由 Runtime Monitor 负责）。
