// @ts-check
/**
 * Runtime entry point for Event Trace:
 * - Installs `HookAttributionRegistry` at module evaluation time before other modules' `init` hooks.
 * - Registers client-only settings, settings menu, keybinding, context menus, and `Sidebar Layout` action.
 * - Observes `Notifications`, `Hooks.on("error")`, `window` errors/rejections, watched document hooks,
 *   client setting changes, and optional read-only `game.socket.prependAny` remote before-value caching.
 * - Exposes `EventTraceApi` on `game.modules.get("event-trace").api` at `ready`.
 */
import {
  DEFAULT_ACTION_WINDOW_MS,
  DEFAULT_MAX_EVENTS,
  MAX_ACTION_WINDOW_MS,
  MAX_MAX_EVENTS,
  MIN_ACTION_WINDOW_MS,
  MIN_MAX_EVENTS,
  MODULE_ID,
  MODULE_VERSION,
  SETTINGS,
  WATCHED_DOCUMENTS
} from "./constants.mjs";
import {collectBeforeValues, computeDiffs, sanitizeDiffValue} from "./diff.mjs";
import {HookAttributionRegistry, parseStackAttribution} from "./attribution.mjs";
import {TraceStore} from "./store.mjs";
import {checkDocumentVisibility, computeCombatSnapshot} from "./trace.mjs";
import {TraceWindow, getActiveTraceWindow, openTraceWindow, setDefaultWindowContext} from "./window.mjs";

const WRAPPED_SYMBOL = Symbol.for("event-trace.notifications-wrapped");
const SKIP_SELF_MODULES = ["event-trace", "runtime-monitor"];

/** @type {{ store: TraceStore, registry: HookAttributionRegistry, uninstall: () => void } | null} */
let activeInstallation = null;

/**
 * Resolve runtime objects with explicit overrides for isolated testing.
 * @param {Record<string, any>} [overrides]
 */
function resolveRuntime(overrides = {}) {
  return {
    Hooks: overrides.Hooks ?? globalThis.Hooks,
    game: overrides.game ?? globalThis.game,
    ui: overrides.ui ?? globalThis.ui,
    canvas: overrides.canvas ?? globalThis.canvas,
    CONFIG: overrides.CONFIG ?? globalThis.CONFIG,
    CONST: overrides.CONST ?? globalThis.CONST,
    windowObj: overrides.windowObj ?? globalThis.window,
    fromUuidSync: overrides.fromUuidSync ?? globalThis.fromUuidSync
  };
}

/**
 * Safely read an Event Trace client setting with fallback.
 * @template T
 * @param {any} gameObj
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
function readSetting(gameObj, key, fallback) {
  try {
    const val = gameObj?.settings?.get?.(MODULE_ID, key);
    return val === undefined ? fallback : /** @type {T} */ (val);
  } catch {
    return fallback;
  }
}

/**
 * Build user metadata for local or remote operations.
 * @param {any} gameObj
 * @param {string | null | undefined} userId
 * @returns {import('../../types/api.d.ts').TraceUserInfo}
 */
function resolveUserInfo(gameObj, userId) {
  const selfId = gameObj?.user?.id ?? "local";
  const resolvedId = userId ?? selfId;
  const isSelf = !userId || userId === selfId;
  const userDoc = isSelf ? gameObj?.user : gameObj?.users?.get?.(resolvedId);
  return {
    id: String(resolvedId),
    name: String(userDoc?.name ?? (isSelf ? "User" : resolvedId)),
    isSelf,
    remote: !isSelf
  };
}

/**
 * Build snapshot environment metadata from `game` and `CONST`.
 * @param {ReturnType<typeof resolveRuntime>} rt
 * @returns {import('../../types/internal.d.ts').TraceStoreEnvironment}
 */
function readSnapshotEnvironment(rt) {
  const g = rt.game;
  const roleNames = rt.CONST?.USER_ROLE_NAMES;
  const roleNum = g?.user?.role;
  const userRole = (roleNames && typeof roleNum === "number" && roleNames[roleNum])
    ? String(roleNames[roleNum])
    : (g?.user?.isGM ? "GAMEMASTER" : "PLAYER");

  /** @type {Array<{ id: string, title: string, version: string }>} */
  const modules = [];
  if (g?.modules) {
    const iter = typeof g.modules.values === "function" ? g.modules.values() : g.modules;
    try {
      for (const mod of iter) {
        if (!mod?.active) continue;
        modules.push({
          id: String(mod.id ?? ""),
          title: String(mod.title ?? mod.id ?? ""),
          version: String(mod.version ?? "")
        });
      }
      modules.sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      // Ignore non-iterable mock module collections.
    }
  }

  const selfMod = g?.modules?.get?.(MODULE_ID);
  return {
    moduleVersion: String(selfMod?.version ?? MODULE_VERSION),
    foundryVersion: String(g?.version ?? "13.351"),
    systemId: String(g?.system?.id ?? ""),
    worldId: String(g?.world?.id ?? ""),
    userRole,
    modules
  };
}

/**
 * Summarize database operation flags without leaking large objects.
 * @param {any} options
 * @returns {Record<string, boolean>}
 */
function summarizeOptions(options) {
  /** @type {Record<string, boolean>} */
  const out = {};
  if (!options || typeof options !== "object") return out;
  for (const key of ["diff", "recursive", "render", "noHook"]) {
    if (typeof options[key] === "boolean") out[key] = options[key];
  }
  return out;
}

/**
 * Build a concise readable summary string for a document event.
 * @param {string} action
 * @param {string} docName
 * @param {string} name
 * @param {import('../../types/api.d.ts').EventDiffEntry[]} diffs
 * @param {boolean} concealed
 * @returns {string}
 */
function buildDocumentSummary(action, docName, name, diffs, concealed) {
  if (concealed) return `${docName} · [concealed]`;
  const subject = name ? `${docName} ${name}` : docName;
  if (action === "update" && diffs.length > 0) {
    const first = diffs[0];
    const extra = diffs.length > 1 ? ` (+${diffs.length - 1})` : "";
    const afterVal = first.op === "remove" ? "×" : String(first.after ?? "");
    return `${subject} · ${first.path}: ${afterVal}${extra}`;
  }
  return `${action} ${subject}`;
}

/**
 * Resolve UUID keys used to cache/consume `before` values across normal and synthetic Token Actors.
 * @param {any} doc
 * @returns {string[]}
 */
function documentCacheKeys(doc) {
  if (!doc) return [];
  const keys = [
    doc.uuid,
    doc.parent?.delta?.uuid,
    doc.token?.actor?.uuid,
    doc.delta?.syntheticActor?.uuid
  ];
  return keys.filter(k => typeof k === "string" && k.length > 0);
}

/**
 * Format an error or rejection reason into `{ message, stack }`.
 * @param {unknown} err
 * @returns {{ message: string, stack: string }}
 */
function extractErrorInfo(err) {
  if (err instanceof Error) {
    const causeStack = err.cause instanceof Error ? err.cause.stack : "";
    return {
      message: err.message || err.name || "Error",
      stack: [causeStack, err.stack].filter(Boolean).join("\n")
    };
  }
  if (err && typeof err === "object") {
    const obj = /** @type {Record<string, unknown>} */ (err);
    return {
      message: typeof obj.message === "string" ? obj.message : String(err),
      stack: typeof obj.stack === "string" ? obj.stack : ""
    };
  }
  return {message: String(err ?? "Unknown error"), stack: ""};
}

/**
 * Install Event Trace runtime hooks, wrappers, and public API.
 * Safe to call multiple times or with isolated test mocks.
 * @param {Record<string, any>} [runtimeOverrides]
 * @returns {{ store: TraceStore, registry: HookAttributionRegistry, uninstall: () => void }}
 */
export function installEventTrace(runtimeOverrides = {}) {
  const hasOverrides = Object.keys(runtimeOverrides).length > 0;
  if (activeInstallation && !hasOverrides) {
    return activeInstallation;
  }
  if (activeInstallation) {
    activeInstallation.uninstall();
  }

  const rt = resolveRuntime(runtimeOverrides);
  const store = new TraceStore({
    maxEvents: readSetting(rt.game, SETTINGS.MAX_EVENTS, DEFAULT_MAX_EVENTS),
    actionWindowMs: readSetting(rt.game, SETTINGS.ACTION_WINDOW_MS, DEFAULT_ACTION_WINDOW_MS),
    environment: () => readSnapshotEnvironment(rt)
  });

  /** @type {Array<{ hook: string, id: number }>} */
  const hookIds = [];
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {Map<string, unknown>} */
  const clientSettingValues = new Map();

  let internalGuardDepth = 0;
  let inErrorCapture = false;
  /** @type {((event: string, ...args: unknown[]) => void) | null} */
  let socketListener = null;
  let lastInterceptionToastAt = 0;

  /**
   * Determine attribution for a synchronous local operation (document pre-hook, notification, setting).
   * Maps pure-core local UI operations without a module/system/macro frame to `user`.
   * @param {string} [hookName]
   * @returns {import('../../types/api.d.ts').EventAttribution}
   */
  const localCallerAttribution = hookName => {
    const activeHookAttr = registry.currentAttribution();
    if (activeHookAttr) return activeHookAttr;
    const parsed = parseStackAttribution(new Error().stack, {
      hookName,
      fallbackSourceType: "user",
      skipModules: SKIP_SELF_MODULES
    });
    if (parsed.sourceType === "core") {
      return {
        ...parsed,
        sourceType: "user",
        label: String(rt.game?.user?.name || "user")
      };
    }
    return parsed;
  };

  const registry = new HookAttributionRegistry({
    onSyncStart: (hookName, attr) => store.pushSyncFrame({hookName, attribution: attr}),
    onSyncEnd: token => store.popSyncFrame(/** @type {number} */ (token)),
    onInterception: payload => {
      internalGuardDepth += 1;
      try {
        const firstArg = /** @type {any} */ (payload.args?.[0]);
        const secondArg = /** @type {any} */ (payload.args?.[1]);
        const isGM = Boolean(rt.game?.user?.isGM);
        let targetUuid = typeof firstArg?.uuid === "string" ? firstArg.uuid : undefined;
        let targetName = typeof firstArg?.name === "string" ? firstArg.name : undefined;

        if (firstArg && typeof firstArg === "object" && ("visible" in firstArg || "hidden" in firstArg || "isSecret" in firstArg)) {
          const vis = checkDocumentVisibility(firstArg, {
            isGM,
            userId: rt.game?.user?.id ?? null
          });
          if (!vis.visible) {
            targetUuid = undefined;
            targetName = "[hidden]";
          }
        } else if (!targetUuid && secondArg?.uuid && typeof secondArg.uuid === "string") {
          targetUuid = secondArg.uuid;
        }

        const targetLabel = targetName || targetUuid || payload.hookName;
        const sourceLabel = payload.attribution?.packageId || payload.attribution?.label || "unknown";
        store.recordEvent({
          kind: "interception",
          combat: computeCombatSnapshot(rt.game, {isGM}),
          user: resolveUserInfo(rt.game, rt.game?.user?.id),
          attribution: payload.attribution,
          target: targetUuid
            ? {type: "document", uuid: targetUuid}
            : (payload.attribution?.packageId
              ? {type: "module", moduleId: payload.attribution.packageId}
              : {type: "hook", hookName: payload.hookName}),
          summary: `${payload.hookName} ✕ ${targetLabel} (${sourceLabel})`,
          detail: {
            hookName: payload.hookName,
            ...(targetUuid ? {targetUuid} : {}),
            ...(targetName ? {targetName} : {}),
            reason: "returned-false",
            callbackRegisteredEarly: payload.callbackRegisteredEarly
          }
        }, {allowTimeWindow: false});

        const notifyEnabled = readSetting(rt.game, SETTINGS.NOTIFY_ON_INTERCEPTION, false);
        const now = Date.now();
        if (
          notifyEnabled
          && !getActiveTraceWindow()?.rendered
          && now - lastInterceptionToastAt > 1500
          && typeof rt.ui?.notifications?.warn === "function"
        ) {
          lastInterceptionToastAt = now;
          const msg = rt.game?.i18n?.format
            ? rt.game.i18n.format("EVENTTRACE.Notify.Interception", {hook: payload.hookName, source: sourceLabel})
            : `${payload.hookName} intercepted by ${sourceLabel}`;
          rt.ui.notifications.warn(msg, {console: false});
        }
      } catch {
        // Keep hook interception passive on internal errors.
      } finally {
        internalGuardDepth -= 1;
      }
    }
  });

  if (rt.Hooks) registry.install(rt.Hooks);

  setDefaultWindowContext({store});

  /**
   * Register a hook and track its ID for clean uninstall.
   * @param {string} hook
   * @param {(...args: any[]) => any} fn
   * @param {{ once?: boolean }} [opts]
   */
  const registerHook = (hook, fn, opts) => {
    if (!rt.Hooks || typeof rt.Hooks.on !== "function") return;
    const id = opts?.once && typeof rt.Hooks.once === "function"
      ? rt.Hooks.once(hook, fn)
      : rt.Hooks.on(hook, fn, opts);
    if (typeof id === "number") hookIds.push({hook, id});
  };

  /**
   * Wrap `Notifications.prototype.notify` / `.update` (and instance methods if distinct) without altering return values.
   */
  const wrapNotifications = () => {
    /**
     * @param {any} target
     */
    const wrapTarget = target => {
      if (!target || typeof target.notify !== "function" || target.notify[WRAPPED_SYMBOL]) return;
      const origNotify = target.notify;
      const origUpdate = typeof target.update === "function" ? target.update : null;

      /** @type {any} @this {any} */
      const wrappedNotify = function(/** @type {any[]} */ ...args) {
        const callerAttr = internalGuardDepth === 0 ? localCallerAttribution("Notifications.notify") : null;
        const notification = origNotify.apply(this, args);
        if (internalGuardDepth > 0) return notification;

        internalGuardDepth += 1;
        try {
          const [rawMessage, rawType, rawOpts] = args;
          const text = notification?.message !== undefined
            ? String(notification.message)
            : String(rawMessage ?? "");
          const level = notification?.type ?? rawType ?? "info";
          store.recordNotification({
            notificationId: notification?.id ?? null,
            level: String(level),
            text,
            permanent: Boolean(notification?.permanent ?? rawOpts?.permanent),
            progress: Boolean(notification?.progress ?? rawOpts?.progress),
            pct: typeof notification?.pct === "number" ? notification.pct : 0,
            timestamp: typeof notification?.timestamp === "number" ? notification.timestamp : undefined,
            combat: computeCombatSnapshot(rt.game, {isGM: Boolean(rt.game?.user?.isGM)}),
            user: resolveUserInfo(rt.game, rt.game?.user?.id),
            attribution: callerAttr ?? undefined
          });
        } catch {
          // Never interrupt native notification rendering.
        } finally {
          internalGuardDepth -= 1;
        }
        return notification;
      };
      wrappedNotify[WRAPPED_SYMBOL] = true;
      target.notify = wrappedNotify;
      cleanups.push(() => {
        if (target.notify === wrappedNotify) target.notify = origNotify;
      });

      if (origUpdate && !origUpdate[WRAPPED_SYMBOL]) {
        /** @type {any} @this {any} */
        const wrappedUpdate = function(/** @type {any[]} */ ...args) {
          const res = origUpdate.apply(this, args);
          if (internalGuardDepth > 0) return res;

          internalGuardDepth += 1;
          try {
            const [notificationOrId, updateData] = args;
            const notificationId = typeof notificationOrId === "number" || typeof notificationOrId === "string"
              ? notificationOrId
              : notificationOrId?.id;
            const pct = typeof updateData?.pct === "number"
              ? updateData.pct
              : (typeof notificationOrId?.pct === "number" ? notificationOrId.pct : undefined);
            const text = typeof updateData?.message === "string"
              ? updateData.message
              : (typeof notificationOrId?.element?.textContent === "string"
                ? notificationOrId.element.textContent
                : undefined);
            if (notificationId !== undefined && notificationId !== null) {
              store.updateNotificationProgress({notificationId, text, pct});
            }
          } catch {
            // Never interrupt native progress updates.
          } finally {
            internalGuardDepth -= 1;
          }
          return res;
        };
        wrappedUpdate[WRAPPED_SYMBOL] = true;
        target.update = wrappedUpdate;
        cleanups.push(() => {
          if (target.update === wrappedUpdate) target.update = origUpdate;
        });
      }
    };

    wrapTarget(rt.CONFIG?.ui?.notifications?.prototype);
    wrapTarget(rt.ui?.notifications);
  };

  /**
   * Attach optional read-only single-argument `game.socket.prependAny` listener for remote `before` values.
   */
  const attachSocketBeforeCache = () => {
    if (socketListener || typeof rt.game?.socket?.prependAny !== "function") return;
    socketListener = (/** @type {string} */ event, /** @type {any} */ response) => {
      if (event !== "modifyDocument" || !response || response.action !== "update") return;
      if (response.userId && response.userId === rt.game?.user?.id) return;

      internalGuardDepth += 1;
      try {
        const type = String(response.type ?? "");
        const results = Array.isArray(response.result) ? response.result : [];
        if (!results.length) return;

        if (type === "ActorDelta" && response.operation?.syntheticActorUpdate && response.operation?.parentUuid) {
          const tokenDoc = typeof rt.fromUuidSync === "function"
            ? rt.fromUuidSync(response.operation.parentUuid)
            : null;
          const actorDoc = tokenDoc?.actor ?? tokenDoc?.delta?.syntheticActor ?? null;
          if (actorDoc) {
            for (const change of results) {
              const beforeMap = collectBeforeValues(actorDoc._source ?? actorDoc, change);
              store.cacheBefore(
                [actorDoc.uuid, tokenDoc?.delta?.uuid].filter(Boolean),
                beforeMap
              );
            }
          }
          return;
        }

        if (!WATCHED_DOCUMENTS.includes(/** @type {any} */ (type))) return;
        let collection = null;
        if (response.operation?.parentUuid && typeof rt.fromUuidSync === "function") {
          const parent = rt.fromUuidSync(response.operation.parentUuid);
          collection = parent?.getEmbeddedCollection?.(type) ?? null;
        } else {
          collection = rt.game?.collections?.get?.(type) ?? null;
        }
        if (!collection?.get) return;

        for (const change of results) {
          const doc = change?._id ? collection.get(change._id, {strict: false}) : null;
          if (!doc) continue;
          const beforeMap = collectBeforeValues(doc._source ?? doc, change);
          store.cacheBefore(documentCacheKeys(doc), beforeMap);
        }
      } catch {
        // Read-only passive observation must never disrupt socket dispatch.
      } finally {
        internalGuardDepth -= 1;
      }
    };

    rt.game.socket.prependAny(socketListener);
    cleanups.push(() => {
      if (socketListener && typeof rt.game?.socket?.offAny === "function") {
        rt.game.socket.offAny(socketListener);
      }
      socketListener = null;
    });
  };

  // `init`: register client settings, menu, keybinding, and wrap Notifications early.
  registerHook("init", () => {
    const g = rt.game;
    if (g?.settings?.register) {
      g.settings.register(MODULE_ID, SETTINGS.MAX_EVENTS, {
        name: "EVENTTRACE.Settings.MaxEvents.Name",
        hint: "EVENTTRACE.Settings.MaxEvents.Hint",
        scope: "client",
        config: true,
        type: Number,
        default: DEFAULT_MAX_EVENTS,
        range: {min: MIN_MAX_EVENTS, max: MAX_MAX_EVENTS, step: 50},
        onChange: (/** @type {number} */ value) => store.setMaxEvents(value)
      });
      g.settings.register(MODULE_ID, SETTINGS.ACTION_WINDOW_MS, {
        name: "EVENTTRACE.Settings.ActionWindowMs.Name",
        hint: "EVENTTRACE.Settings.ActionWindowMs.Hint",
        scope: "client",
        config: true,
        type: Number,
        default: DEFAULT_ACTION_WINDOW_MS,
        range: {min: MIN_ACTION_WINDOW_MS, max: MAX_ACTION_WINDOW_MS, step: 25},
        onChange: (/** @type {number} */ value) => store.setActionWindowMs(value)
      });
      g.settings.register(MODULE_ID, SETTINGS.CAPTURE_SETTINGS, {
        name: "EVENTTRACE.Settings.CaptureSettings.Name",
        hint: "EVENTTRACE.Settings.CaptureSettings.Hint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true
      });
      g.settings.register(MODULE_ID, SETTINGS.NOTIFY_ON_INTERCEPTION, {
        name: "EVENTTRACE.Settings.NotifyOnInterception.Name",
        hint: "EVENTTRACE.Settings.NotifyOnInterception.Hint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
      });
    }

    store.setMaxEvents(readSetting(g, SETTINGS.MAX_EVENTS, DEFAULT_MAX_EVENTS));
    store.setActionWindowMs(readSetting(g, SETTINGS.ACTION_WINDOW_MS, DEFAULT_ACTION_WINDOW_MS));

    g?.settings?.registerMenu?.(MODULE_ID, "openTrace", {
      name: "EVENTTRACE.Menu.Name",
      label: "EVENTTRACE.Menu.Label",
      hint: "EVENTTRACE.Menu.Hint",
      icon: "fa-solid fa-clock-rotate-left",
      type: TraceWindow,
      restricted: false
    });

    g?.keybindings?.register?.(MODULE_ID, "open", {
      name: "EVENTTRACE.Keybinding.Open.Name",
      hint: "EVENTTRACE.Keybinding.Open.Hint",
      editable: [],
      restricted: false,
      onDown: () => {
        void openTraceWindow(undefined, {store});
        return true;
      }
    });

    wrapNotifications();
  }, {once: true});

  // `ready`: attach socket pre-reader, expose public API, and register optional Sidebar Layout action.
  registerHook("ready", () => {
    wrapNotifications();
    attachSocketBeforeCache();

    const g = rt.game;
    /** @type {import('../../types/api.d.ts').EventTraceApi} */
    const api = {
      open: filter => openTraceWindow(filter, {store}),
      snapshot: options => store.buildSnapshot(options),
      summary: () => store.summary()
    };

    const selfModule = g?.modules?.get?.(MODULE_ID);
    if (selfModule) {
      selfModule.api = api;
    }

    const sidebarLayout = g?.modules?.get?.("sidebar-layout");
    if (sidebarLayout?.active && typeof sidebarLayout.api?.registerAction === "function") {
      sidebarLayout.api.registerAction({
        id: "event-trace.open",
        label: g?.i18n?.localize?.("EVENTTRACE.SidebarAction.Label") ?? "Event Trace",
        icon: "fa-solid fa-clock-rotate-left",
        onClick: () => {
          void openTraceWindow(undefined, {store});
        }
      });
    }
  }, {once: true});

  // Runtime errors: Foundry `Hooks.on("error")`, `window` JS errors, and unhandled rejections.
  registerHook("error", (/** @type {string} */ location, /** @type {unknown} */ error, /** @type {any} */ data) => {
    if (inErrorCapture) return;
    inErrorCapture = true;
    internalGuardDepth += 1;
    try {
      const {message, stack} = extractErrorInfo(error);
      const attr = (data?.fn ? registry.getAttribution(data.fn) : null)
        ?? registry.currentAttribution()
        ?? parseStackAttribution(stack, {hookName: data?.hook});
      const isGM = Boolean(rt.game?.user?.isGM);
      const contextUuid = typeof data?.uuid === "string"
        ? data.uuid
        : (typeof data?.id === "string" ? data.id : undefined);

      store.recordEvent({
        kind: "error",
        combat: computeCombatSnapshot(rt.game, {isGM}),
        user: resolveUserInfo(rt.game, rt.game?.user?.id),
        attribution: attr,
        target: contextUuid
          ? {type: "document", uuid: contextUuid}
          : (attr.packageId ? {type: "module", moduleId: attr.packageId} : null),
        summary: `${location || "Hooks"}: ${message}`,
        detail: {
          origin: "hooks",
          location: String(location ?? ""),
          message,
          stackLines: stack ? stack.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 8) : [],
          ...(contextUuid ? {contextUuid} : {}),
          ...(data?.hook ? {contextHook: String(data.hook)} : {})
        }
      }, {allowTimeWindow: false});
    } catch {
      // Protect against error-handler re-entrancy.
    } finally {
      internalGuardDepth -= 1;
      inErrorCapture = false;
    }
  });

  if (rt.windowObj && typeof rt.windowObj.addEventListener === "function") {
    const onWindowError = (/** @type {any} */ event) => {
      // Ignore static resource element failures (IMG/SCRIPT/LINK/AUDIO/VIDEO); Runtime Monitor handles those.
      if (event?.target && event.target !== rt.windowObj) return;
      if (!(event?.error instanceof Error) && !event?.filename) return;
      if (inErrorCapture) return;

      inErrorCapture = true;
      internalGuardDepth += 1;
      try {
        const info = event.error ? extractErrorInfo(event.error) : {
          message: String(event.message ?? "Script error"),
          stack: event.filename ? `at ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : ""
        };
        let attr = parseStackAttribution(info.stack);
        if (!attr.packageId && event.filename) {
          const byFile = parseStackAttribution(`at ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`);
          if (byFile.packageId || attr.sourceType === "unknown") {
            attr = byFile;
          }
        }

        store.recordEvent({
          kind: "error",
          combat: computeCombatSnapshot(rt.game, {isGM: Boolean(rt.game?.user?.isGM)}),
          user: resolveUserInfo(rt.game, rt.game?.user?.id),
          attribution: attr,
          target: attr.packageId ? {type: "module", moduleId: attr.packageId} : null,
          summary: info.message,
          detail: {
            origin: "window-error",
            location: event.filename ? `${event.filename}:${event.lineno ?? 0}` : "window",
            message: info.message,
            stackLines: info.stack ? info.stack.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 8) : []
          }
        }, {allowTimeWindow: false});
      } catch {
        // Protect against recursive errors.
      } finally {
        internalGuardDepth -= 1;
        inErrorCapture = false;
      }
    };

    const onUnhandledRejection = (/** @type {any} */ event) => {
      if (inErrorCapture) return;
      inErrorCapture = true;
      internalGuardDepth += 1;
      try {
        const info = extractErrorInfo(event?.reason);
        const attr = info.stack
          ? parseStackAttribution(info.stack)
          : (registry.currentAttribution() ?? parseStackAttribution(""));
        store.recordEvent({
          kind: "error",
          combat: computeCombatSnapshot(rt.game, {isGM: Boolean(rt.game?.user?.isGM)}),
          user: resolveUserInfo(rt.game, rt.game?.user?.id),
          attribution: attr,
          target: attr.packageId ? {type: "module", moduleId: attr.packageId} : null,
          summary: info.message,
          detail: {
            origin: "unhandledrejection",
            location: "Promise",
            message: info.message,
            stackLines: info.stack ? info.stack.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 8) : []
          }
        }, {allowTimeWindow: false});
      } catch {
        // Protect against recursive errors.
      } finally {
        internalGuardDepth -= 1;
        inErrorCapture = false;
      }
    };

    rt.windowObj.addEventListener("error", onWindowError);
    rt.windowObj.addEventListener("unhandledrejection", onUnhandledRejection);
    cleanups.push(() => {
      rt.windowObj?.removeEventListener?.("error", onWindowError);
      rt.windowObj?.removeEventListener?.("unhandledrejection", onUnhandledRejection);
    });
  }

  // Watched document lifecycle hooks (`pre*` before-caching + post-database events).
  for (const docName of WATCHED_DOCUMENTS) {
    registerHook(`preCreate${docName}`, (/** @type {any} */ doc, /** @type {any} */ _data, /** @type {any} */ _options, /** @type {string} */ userId) => {
      if (docName === "Setting" && !readSetting(rt.game, SETTINGS.CAPTURE_SETTINGS, true)) return;
      const selfId = rt.game?.user?.id ?? "local";
      if (userId && userId !== selfId) return;
      store.cachePendingPreOp({
        documentName: docName,
        action: "create",
        userId: String(userId ?? selfId),
        attribution: localCallerAttribution(`preCreate${docName}`),
        name: doc?.name ?? doc?.key ?? null
      });
    });

    registerHook(`preUpdate${docName}`, (/** @type {any} */ doc, /** @type {any} */ changes, /** @type {any} */ _options, /** @type {string} */ userId) => {
      if (docName === "Setting" && !readSetting(rt.game, SETTINGS.CAPTURE_SETTINGS, true)) return;
      const beforeMap = collectBeforeValues(doc?._source ?? doc, changes);
      const selfId = rt.game?.user?.id ?? "local";
      const attr = (!userId || userId === selfId)
        ? localCallerAttribution(`preUpdate${docName}`)
        : null;
      store.cacheBefore(documentCacheKeys(doc), beforeMap, attr);
    });

    registerHook(`preDelete${docName}`, (/** @type {any} */ doc, /** @type {any} */ _options, /** @type {string} */ userId) => {
      if (docName === "Setting" && !readSetting(rt.game, SETTINGS.CAPTURE_SETTINGS, true)) return;
      const selfId = rt.game?.user?.id ?? "local";
      if (userId && userId !== selfId) return;
      store.cachePendingPreOp({
        documentName: docName,
        action: "delete",
        userId: String(userId ?? selfId),
        attribution: localCallerAttribution(`preDelete${docName}`),
        name: doc?.name ?? doc?.key ?? null
      });
    });

    for (const action of /** @type {const} */ (["create", "update", "delete"])) {
      const hookName = `${action}${docName}`;
      registerHook(hookName, (/** @type {any} */ doc, /** @type {any} */ arg2, /** @type {any} */ arg3, /** @type {any} */ arg4) => {
        if (docName === "Setting" && !readSetting(rt.game, SETTINGS.CAPTURE_SETTINGS, true)) return;

        // Note Foundry's `delete*` signature omits `change`: `(doc, options, userId)`!
        const changeOrData = action === "delete" ? (doc?._source ?? {}) : arg2;
        const options = action === "delete" ? arg2 : arg3;
        const userId = action === "delete" ? arg3 : arg4;

        const g = rt.game;
        const isGM = Boolean(g?.user?.isGM);
        const settingConfig = docName === "Setting" && doc?.key
          ? (g?.settings?.settings?.get?.(doc.key) ?? null)
          : null;

        const vis = checkDocumentVisibility(doc, {
          isGM,
          userId: g?.user?.id ?? null,
          documentName: docName,
          settingConfig
        });
        if (!vis.visible) return;

        const user = resolveUserInfo(g, userId);
        let beforeMap = null;
        let preAttr = null;

        if (action === "update") {
          const cached = store.consumeBefore(documentCacheKeys(doc));
          if (cached) {
            beforeMap = cached.beforeMap;
            preAttr = cached.attribution;
          }
        } else if (!user.remote) {
          preAttr = store.consumePendingPreOp({
            documentName: docName,
            action,
            userId: user.id,
            name: doc?.name ?? doc?.key ?? null
          });
        }

        const attribution = user.remote
          ? {sourceType: /** @type {const} */ ("user"), packageId: null, label: user.name, hookName, confidence: /** @type {const} */ ("exact")}
          : (preAttr ?? registry.currentAttribution() ?? {
            sourceType: /** @type {const} */ ("user"),
            packageId: null,
            label: user.name,
            hookName,
            confidence: /** @type {const} */ ("inferred")
          });

        const diffResult = computeDiffs(changeOrData, beforeMap, {
          mode: action === "delete" ? "delete" : (action === "create" ? "create" : "update")
        });

        const uuid = typeof doc?.uuid === "string" ? doc.uuid : undefined;
        const parentUuid = typeof doc?.parent?.uuid === "string" ? doc.parent.uuid : undefined;
        const actorUuid = docName === "Actor"
          ? uuid
          : (typeof doc?.actor?.uuid === "string"
            ? doc.actor.uuid
            : (doc?.parent?.documentName === "Actor" ? parentUuid : undefined));
        const name = docName === "Setting"
          ? String(doc?.key ?? "")
          : String(doc?.name ?? doc?.alias ?? doc?.id ?? "");

        /** @type {Record<string, unknown>} */
        const detail = {
          action,
          documentName: docName,
          documentId: doc?.id ? String(doc.id) : undefined,
          uuid,
          name,
          ...(parentUuid ? {parentUuid} : {}),
          ...(actorUuid ? {actorUuid} : {}),
          diffs: diffResult.diffs,
          omittedDiffCount: diffResult.omittedDiffCount,
          beforeCached: action === "update" ? diffResult.beforeCached : true,
          optionsSummary: summarizeOptions(options)
        };

        if (docName === "ChatMessage") {
          detail.messageId = doc?.id ? String(doc.id) : undefined;
          detail.isRoll = Boolean(doc?.isRoll);
          detail.rollCount = vis.concealContent
            ? 0
            : (Array.isArray(doc?.rolls) ? doc.rolls.length : 0);
        } else if (docName === "Setting") {
          detail.key = String(doc?.key ?? "");
          detail.scope = settingConfig?.scope ?? (doc?.user ? "user" : "world");
          clientSettingValues.set(String(doc?.key ?? ""), doc?.value);
        }

        /** @type {import('../../types/api.d.ts').TargetRef | null} */
        let target = null;
        if (docName === "ChatMessage" && doc?.id) {
          target = {type: "message", messageId: String(doc.id)};
        } else if (uuid) {
          target = {type: "document", uuid};
        }

        store.recordEvent({
          kind: "document",
          combat: computeCombatSnapshot(g, {isGM}),
          user,
          attribution,
          target,
          summary: buildDocumentSummary(action, docName, name, diffResult.diffs, vis.concealContent),
          detail,
          concealed: vis.concealContent
        }, {allowTimeWindow: true});
      });
    }
  }

  // Client-scoped settings change hook.
  registerHook("clientSettingChanged", (/** @type {string} */ key, /** @type {unknown} */ value, /** @type {any} */ options) => {
    if (!readSetting(rt.game, SETTINGS.CAPTURE_SETTINGS, true)) return;
    const g = rt.game;
    const isGM = Boolean(g?.user?.isGM);
    const hasPrev = clientSettingValues.has(key);
    const prevValue = clientSettingValues.get(key);
    clientSettingValues.set(key, value);

    const beforeMap = hasPrev ? new Map([["value", prevValue]]) : null;
    const diffResult = computeDiffs({value}, beforeMap, {mode: "update"});
    const attr = localCallerAttribution("clientSettingChanged");
    const afterStr = String(sanitizeDiffValue(value, "value").value ?? "");

    store.recordEvent({
      kind: "document",
      combat: computeCombatSnapshot(g, {isGM}),
      user: resolveUserInfo(g, g?.user?.id),
      attribution: attr,
      target: attr.packageId ? {type: "module", moduleId: attr.packageId} : null,
      summary: `Setting ${key} · ${afterStr}`,
      detail: {
        action: "update",
        documentName: "Setting",
        name: key,
        key,
        scope: "client",
        diffs: diffResult.diffs,
        omittedDiffCount: diffResult.omittedDiffCount,
        beforeCached: diffResult.beforeCached,
        optionsSummary: summarizeOptions(options)
      }
    }, {allowTimeWindow: true});
  });

  // Native context menu integrations (ChatLog, ActorDirectory, CombatTracker).
  registerHook("getChatMessageContextOptions", (/** @type {any} */ _app, /** @type {any[]} */ options) => {
    options.push({
      name: "EVENTTRACE.Context.ViewMessageEvents",
      icon: '<i class="fa-solid fa-clock-rotate-left"></i>',
      condition: (/** @type {HTMLElement} */ li) => {
        const messageId = li?.dataset?.messageId;
        if (!messageId) return false;
        const msg = rt.game?.messages?.get?.(messageId);
        if (msg) return msg.visible !== false;
        return store.hasEventsFor({messageId});
      },
      callback: (/** @type {HTMLElement} */ li) => {
        const messageId = li?.dataset?.messageId;
        if (messageId) void openTraceWindow({messageId}, {store});
      }
    });
  });

  registerHook("getActorContextOptions", (/** @type {any} */ _app, /** @type {any[]} */ options) => {
    options.push({
      name: "EVENTTRACE.Context.ViewDocumentTimeline",
      icon: '<i class="fa-solid fa-clock-rotate-left"></i>',
      condition: (/** @type {HTMLElement} */ li) => {
        const entry = /** @type {HTMLElement | null} */ (li?.closest?.("[data-entry-id]"));
        const entryId = entry?.dataset?.entryId ?? li?.dataset?.entryId;
        const actor = entryId ? rt.game?.actors?.get?.(entryId) : null;
        return Boolean(actor && actor.visible !== false && actor.uuid);
      },
      callback: (/** @type {HTMLElement} */ li) => {
        const entry = /** @type {HTMLElement | null} */ (li?.closest?.("[data-entry-id]"));
        const entryId = entry?.dataset?.entryId ?? li?.dataset?.entryId;
        const uuid = entryId ? rt.game?.actors?.get?.(entryId)?.uuid : null;
        if (uuid) void openTraceWindow({uuid}, {store});
      }
    });
  });

  registerHook("getCombatTrackerContextOptions", (/** @type {any} */ app, /** @type {any[]} */ options) => {
    options.push({
      name: "EVENTTRACE.Context.ViewDocumentTimeline",
      icon: '<i class="fa-solid fa-clock-rotate-left"></i>',
      condition: (/** @type {HTMLElement} */ li) => {
        const combatantId = li?.dataset?.combatantId;
        if (!combatantId) return false;
        const combat = app?.viewed ?? rt.ui?.combat?.viewed ?? null;
        const combatant = combat?.combatants?.get?.(combatantId);
        return Boolean(combatant && combatant.visible !== false && (combatant.actor?.uuid || combatant.uuid));
      },
      callback: (/** @type {HTMLElement} */ li) => {
        const combatantId = li?.dataset?.combatantId;
        if (!combatantId) return;
        const combat = app?.viewed ?? rt.ui?.combat?.viewed ?? null;
        const combatant = combat?.combatants?.get?.(combatantId);
        const uuid = combatant?.actor?.uuid ?? combatant?.uuid ?? null;
        if (uuid) void openTraceWindow({uuid}, {store});
      }
    });
  });

  const uninstall = () => {
    for (const {hook, id} of hookIds) {
      try {
        rt.Hooks?.off?.(hook, id);
      } catch {
        // Ignore teardown failures on mock Hooks.
      }
    }
    hookIds.length = 0;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // Ignore teardown failures.
      }
    }
    registry.uninstall();
    if (activeInstallation?.uninstall === uninstall) activeInstallation = null;
  };

  activeInstallation = {store, registry, uninstall};
  return activeInstallation;
}

/** Uninstall the currently active Event Trace runtime instrumentation, if any. */
export function uninstallEventTrace() {
  activeInstallation?.uninstall();
}

// Install immediately at module top-level so `Hooks.on` attribution runs before other modules' `init`.
if (typeof globalThis.Hooks?.on === "function") {
  installEventTrace();
}
