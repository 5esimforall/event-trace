// @ts-check
/**
 * Stack frame attribution parser and Hooks registration/interception registry.
 * Captures module/system attribution once at `Hooks.on`/`once` registration time,
 * safely coexists with sibling observers (`runtime-monitor`), and detects synchronous `false` interceptions.
 */
import {isCancelableHook} from "./constants.mjs";

const STACK_SKIP_FILES = [
  "/modules/event-trace/scripts/attribution.mjs",
  "/event-trace/module/scripts/attribution.mjs",
  "/modules/runtime-monitor/scripts/probes.mjs",
  "/runtime-monitor/module/scripts/probes.mjs"
];

const CORE_PATH_HINTS = [
  "/scripts/foundry",
  "/client/",
  "/common/",
  "/foundry.mjs",
  "/foundry.js",
  "node:"
];

const MODULE_PATH_RE = /(?:^|\/)modules\/([^/?#]+)\//;
const SYSTEM_PATH_RE = /(?:^|\/)systems\/([^/?#]+)\//;
const CHROMIUM_FRAME_RE = /^\s*at\s+(?:(.+?)\s+\((.+)\)|(.+))$/;
const FIREFOX_FRAME_RE = /^([^@]*)@(.*)$/;
const MACRO_FRAME_RE = /(?:eval at #executeScript|eval at execute|> AsyncFunction:|> Function:|> eval:|Macro\.#?execute|<anonymous>:\d+:\d+)/;
const LINE_LIMIT = 8;

/**
 * Parse a single stack frame line across Chromium/V8/Node and Firefox/Safari formats.
 * @param {string} rawLine
 * @returns {{ fnName: string | undefined, location: string } | null}
 */
function parseStackFrame(rawLine) {
  const line = rawLine.trim();
  if (!line || line === "Error" || line.startsWith("Error:")) return null;

  const v8 = CHROMIUM_FRAME_RE.exec(line);
  if (v8) {
    const fnName = v8[1]?.trim() || undefined;
    const location = (v8[2] ?? v8[3] ?? "").trim();
    if (!location) return null;
    return {fnName, location};
  }

  const ff = FIREFOX_FRAME_RE.exec(line);
  if (ff) {
    const fnName = ff[1]?.trim() || undefined;
    const location = ff[2]?.trim() || "";
    if (!location) return null;
    return {fnName, location};
  }

  return null;
}

/**
 * Determine if a stack frame location belongs to an observer wrapper that must be skipped.
 * @param {string} location
 * @returns {boolean}
 */
function shouldSkipObserverFrame(location) {
  const normalized = location.replaceAll("\\", "/");
  return STACK_SKIP_FILES.some(pattern => normalized.includes(pattern));
}

/**
 * Determine if a stack frame belongs to Foundry core scripts rather than a package.
 * @param {string} location
 * @returns {boolean}
 */
function isCoreLocation(location) {
  const normalized = location.replaceAll("\\", "/");
  if (normalized.includes("node_modules/")) return true;
  if (MODULE_PATH_RE.test(normalized) || SYSTEM_PATH_RE.test(normalized)) return false;
  return CORE_PATH_HINTS.some(hint => normalized.includes(hint));
}

/**
 * Extract readable stack lines (skipping internal observer frames) for error inspection.
 * @param {string | undefined | null} stack
 * @param {number} [limit]
 * @returns {string[]}
 */
export function extractStackLines(stack, limit = LINE_LIMIT) {
  if (typeof stack !== "string" || !stack) return [];
  /** @type {string[]} */
  const lines = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const frame = parseStackFrame(rawLine);
    if (!frame) continue;
    if (shouldSkipObserverFrame(frame.location)) continue;
    lines.push(rawLine.trim());
    if (lines.length >= limit) break;
  }
  return lines;
}

/**
 * Parse a JS Error stack string into an `EventAttribution`.
 * Skips internal observer wrappers (`event-trace/scripts/attribution.mjs` and
 * `runtime-monitor/scripts/probes.mjs`) and Foundry core frames to locate the responsible package.
 * @param {string | undefined | null} stack
 * @param {{
 *   hookName?: string,
 *   fallbackSourceType?: import('../../types/api.d.ts').EventAttributionSourceType,
 *   skipModules?: string[]
 * }} [options]
 * @returns {import('../../types/api.d.ts').EventAttribution}
 */
export function parseStackAttribution(stack, options = {}) {
  const hookName = options.hookName;
  const skipModules = options.skipModules?.length ? new Set(options.skipModules) : null;
  if (typeof stack !== "string" || !stack.trim()) {
    return {
      sourceType: options.fallbackSourceType ?? "unknown",
      packageId: null,
      label: options.fallbackSourceType ?? "unknown",
      ...(hookName ? {hookName} : {}),
      confidence: "unknown"
    };
  }

  let sawCore = false;
  let sawMacro = false;
  /** @type {string | undefined} */
  let firstFnName;
  /** @type {string | undefined} */
  let macroFnName;
  /** @type {string | undefined} */
  let coreFnName;

  for (const rawLine of stack.split(/\r?\n/)) {
    const frame = parseStackFrame(rawLine);
    if (!frame) continue;
    const normalized = frame.location.replaceAll("\\", "/");
    if (shouldSkipObserverFrame(normalized)) continue;
    if (skipModules) {
      const candidateMod = MODULE_PATH_RE.exec(normalized);
      if (candidateMod && skipModules.has(decodeSafe(candidateMod[1]))) continue;
    }
    firstFnName ??= frame.fnName;

    if (!normalized.includes("node_modules/")) {
      const modMatch = MODULE_PATH_RE.exec(normalized);
      if (modMatch) {
        const packageId = decodeSafe(modMatch[1]);
        return {
          sourceType: "module",
          packageId,
          label: packageId,
          ...(hookName ? {hookName} : {}),
          ...(frame.fnName ? {fnName: frame.fnName} : {}),
          confidence: "exact"
        };
      }
      const sysMatch = SYSTEM_PATH_RE.exec(normalized);
      if (sysMatch) {
        const packageId = decodeSafe(sysMatch[1]);
        return {
          sourceType: "system",
          packageId,
          label: packageId,
          ...(hookName ? {hookName} : {}),
          ...(frame.fnName ? {fnName: frame.fnName} : {}),
          confidence: "exact"
        };
      }
    }

    if (MACRO_FRAME_RE.test(rawLine) || normalized.includes("/documents/macro.mjs")) {
      sawMacro = true;
      macroFnName ??= frame.fnName;
      continue;
    }

    if (isCoreLocation(normalized)) {
      sawCore = true;
      coreFnName ??= frame.fnName;
    }
  }

  if (sawMacro) {
    return {
      sourceType: "user",
      packageId: null,
      label: "Macro",
      ...(hookName ? {hookName} : {}),
      fnName: macroFnName ?? "Macro",
      confidence: "inferred"
    };
  }

  if (sawCore) {
    const type = options.fallbackSourceType === "user" ? "user" : "core";
    return {
      sourceType: type,
      packageId: null,
      label: type,
      ...(hookName ? {hookName} : {}),
      ...(coreFnName ? {fnName: coreFnName} : {}),
      confidence: "inferred"
    };
  }

  const fallback = options.fallbackSourceType ?? "unknown";
  return {
    sourceType: fallback,
    packageId: null,
    label: fallback,
    ...(hookName ? {hookName} : {}),
    ...(firstFnName ? {fnName: firstFnName} : {}),
    confidence: "unknown"
  };
}

/**
 * Decode URI-encoded package directory names without throwing on malformed sequences.
 * @param {string} value
 * @returns {string}
 */
function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Create a clean `EventAttribution` for a known user action.
 * @param {string} [label]
 * @param {string} [hookName]
 * @returns {import('../../types/api.d.ts').EventAttribution}
 */
export function userAttribution(label = "user", hookName) {
  return {
    sourceType: "user",
    packageId: null,
    label,
    ...(hookName ? {hookName} : {}),
    confidence: "exact"
  };
}

/**
 * Observes `Hooks.on`, `Hooks.once`, `Hooks.off`, and `Hooks.call` with zero hot-path stack capture.
 * Captures stack attribution once during hook registration and intercepts synchronous `false` returns
 * without altering native Foundry return values or `Hooks.off` function-reference removal.
 */
export class HookAttributionRegistry {
  /** @type {HooksStatic | null} */
  #hooks = null;
  /** @type {HooksStatic["on"] | null} */
  #origOn = null;
  /** @type {HooksStatic["once"] | null} */
  #origOnce = null;
  /** @type {HooksStatic["off"] | null} */
  #origOff = null;
  /** @type {HooksStatic["call"] | null} */
  #origCall = null;

  /** @type {Map<number, import('../../types/api.d.ts').EventAttribution>} */
  #idToMeta = new Map();
  /** @type {WeakMap<Function, import('../../types/api.d.ts').EventAttribution>} */
  #fnToMeta = new WeakMap();
  /** @type {WeakMap<Function, import('../../types/api.d.ts').EventAttribution>} */
  #wrappedToMeta = new WeakMap();
  /** @type {Map<string, Map<Function, Array<{ wrappedFn: (...args: unknown[]) => unknown, id: number | null }>>>} */
  #hookFnToWrappers = new Map();
  /** @type {Map<number, { hook: string, originalFn: Function, wrappedFn: (...args: unknown[]) => unknown }>} */
  #idToEntry = new Map();

  /** @type {Array<{ hookName: string, interceptedByWrapper: boolean }>} */
  #callStack = [];
  /** @type {Array<import('../../types/api.d.ts').EventAttribution>} */
  #callbackStack = [];
  /** @type {{ fn: Function, meta: import('../../types/api.d.ts').EventAttribution } | null} */
  #pendingOnce = null;
  #emitting = false;

  /** @type {((payload: import('../../types/internal.d.ts').InterceptionCallbackPayload) => void) | null} */
  #onInterception = null;
  /** @type {((hookName: string, attribution: import('../../types/api.d.ts').EventAttribution | null) => unknown) | null} */
  #onSyncStart = null;
  /** @type {((token: unknown) => void) | null} */
  #onSyncEnd = null;

  /**
   * @param {{
   *   onInterception?: (payload: import('../../types/internal.d.ts').InterceptionCallbackPayload) => void,
   *   onSyncStart?: (hookName: string, attribution: import('../../types/api.d.ts').EventAttribution | null) => unknown,
   *   onSyncEnd?: (token: unknown) => void
   * }} [callbacks]
   */
  constructor(callbacks = {}) {
    this.#onInterception = callbacks.onInterception ?? null;
    this.#onSyncStart = callbacks.onSyncStart ?? null;
    this.#onSyncEnd = callbacks.onSyncEnd ?? null;
  }

  /**
   * Update observation callbacks without reinstalling hook wrappers.
   * @param {{
   *   onInterception?: ((payload: import('../../types/internal.d.ts').InterceptionCallbackPayload) => void) | null,
   *   onSyncStart?: ((hookName: string, attribution: import('../../types/api.d.ts').EventAttribution | null) => unknown) | null,
   *   onSyncEnd?: ((token: unknown) => void) | null
   * }} callbacks
   */
  setCallbacks(callbacks) {
    if ("onInterception" in callbacks) this.#onInterception = callbacks.onInterception ?? null;
    if ("onSyncStart" in callbacks) this.#onSyncStart = callbacks.onSyncStart ?? null;
    if ("onSyncEnd" in callbacks) this.#onSyncEnd = callbacks.onSyncEnd ?? null;
  }

  /** @returns {boolean} */
  get installed() {
    return this.#hooks !== null;
  }

  /**
   * Install wrappers onto `Hooks` (idempotent for the same `Hooks` object).
   * @param {HooksStatic} [hooksObj]
   * @returns {this}
   */
  install(hooksObj = globalThis.Hooks) {
    if (!hooksObj || typeof hooksObj.on !== "function" || typeof hooksObj.off !== "function") {
      return this;
    }
    if (this.#hooks === hooksObj) return this;
    if (this.#hooks) this.uninstall();

    const registry = this;
    const origOn = hooksObj.on;
    const origOnce = typeof hooksObj.once === "function" ? hooksObj.once : null;
    const origOff = hooksObj.off;
    const origCall = typeof hooksObj.call === "function" ? hooksObj.call : null;

    this.#hooks = hooksObj;
    this.#origOn = origOn;
    this.#origOnce = origOnce;
    this.#origOff = origOff;
    this.#origCall = origCall;

    hooksObj.on = /** @type {HooksStatic["on"]} */ (/** @this {HooksStatic} */ function(hook, fn, options) {
      if (typeof fn !== "function") {
        return origOn.call(this, hook, fn, options);
      }

      // If `Hooks.once` already wrapped this function and delegated to `this.on`, pass straight through.
      const existingWrappedMeta = registry.#wrappedToMeta.get(fn);
      if (existingWrappedMeta) {
        const id = origOn.call(this, hook, fn, options);
        if (typeof id === "number") registry.#idToMeta.set(id, existingWrappedMeta);
        return id;
      }

      const hookName = String(hook);
      const meta = (registry.#pendingOnce && registry.#pendingOnce.fn === fn)
        ? registry.#pendingOnce.meta
        : registry.#captureAttribution(hookName, fn);

      registry.#fnToMeta.set(fn, meta);

      if (isCancelableHook(hookName)) {
        const entry = registry.#createWrappedEntry(hookName, fn, meta, Boolean(options?.once));
        const id = origOn.call(this, hook, entry.wrappedFn, options);
        if (typeof id === "number") {
          entry.id = id;
          registry.#idToMeta.set(id, meta);
          registry.#idToEntry.set(id, {hook: hookName, originalFn: fn, wrappedFn: entry.wrappedFn});
        }
        return id;
      }

      const id = origOn.call(this, hook, fn, options);
      if (typeof id === "number") registry.#idToMeta.set(id, meta);
      return id;
    });

    if (origOnce) {
      hooksObj.once = /** @type {HooksStatic["once"]} */ (/** @this {HooksStatic} */ function(hook, fn) {
        if (typeof fn !== "function") {
          return origOnce.call(this, hook, fn);
        }
        const hookName = String(hook);
        const meta = registry.#captureAttribution(hookName, fn);
        registry.#fnToMeta.set(fn, meta);

        if (isCancelableHook(hookName)) {
          const entry = registry.#createWrappedEntry(hookName, fn, meta, true);
          const id = origOnce.call(this, hook, entry.wrappedFn);
          if (typeof id === "number") {
            entry.id = id;
            registry.#idToMeta.set(id, meta);
            registry.#idToEntry.set(id, {hook: hookName, originalFn: fn, wrappedFn: entry.wrappedFn});
          }
          return id;
        }

        const prevPending = registry.#pendingOnce;
        registry.#pendingOnce = {fn, meta};
        try {
          const id = origOnce.call(this, hook, fn);
          if (typeof id === "number") registry.#idToMeta.set(id, meta);
          return id;
        } finally {
          registry.#pendingOnce = prevPending;
        }
      });
    }

    hooksObj.off = /** @type {HooksStatic["off"]} */ (/** @this {HooksStatic} */ function(hook, fnOrId) {
      if (typeof fnOrId === "number") {
        const tracked = registry.#idToEntry.get(fnOrId);
        if (tracked) {
          registry.#removeWrappedEntryById(tracked.hook, tracked.originalFn, fnOrId);
          registry.#idToEntry.delete(fnOrId);
        }
        registry.#idToMeta.delete(fnOrId);
        return origOff.call(this, hook, fnOrId);
      }

      if (typeof fnOrId === "function") {
        const hookName = String(hook);
        const swapped = registry.#shiftWrappedFn(hookName, fnOrId);
        if (swapped) {
          if (typeof swapped.id === "number") {
            registry.#idToEntry.delete(swapped.id);
            registry.#idToMeta.delete(swapped.id);
          }
          return origOff.call(this, hook, swapped.wrappedFn);
        }
      }

      return origOff.call(this, hook, fnOrId);
    });

    if (origCall) {
      hooksObj.call = /** @type {HooksStatic["call"]} */ (/** @this {HooksStatic} */ function(hook, ...args) {
        const hookName = String(hook);
        const callFrame = {hookName, interceptedByWrapper: false};
        registry.#callStack.push(callFrame);
        let syncToken = null;
        if (!registry.#emitting && registry.#onSyncStart) {
          try {
            syncToken = registry.#onSyncStart(hookName, registry.currentAttribution());
          } catch {
            syncToken = null;
          }
        }
        try {
          const result = origCall.call(this, hook, ...args);
          if (result === false && !callFrame.interceptedByWrapper) {
            registry.#emitEarlyInterception(hookName, args);
          }
          return result;
        } finally {
          registry.#callStack.pop();
          if (syncToken !== null && registry.#onSyncEnd) {
            try {
              registry.#onSyncEnd(syncToken);
            } catch {
              // Ignore cleanup observer failures.
            }
          }
        }
      });
    }

    return this;
  }

  /**
   * Restore original `Hooks` methods and clear transient call stacks.
   */
  uninstall() {
    if (!this.#hooks) return;
    if (this.#origOn) this.#hooks.on = this.#origOn;
    if (this.#origOnce) this.#hooks.once = this.#origOnce;
    if (this.#origOff) this.#hooks.off = this.#origOff;
    if (this.#origCall) this.#hooks.call = this.#origCall;
    this.#hooks = null;
    this.#origOn = null;
    this.#origOnce = null;
    this.#origOff = null;
    this.#origCall = null;
    this.#callStack.length = 0;
    this.#callbackStack.length = 0;
    this.#pendingOnce = null;
  }

  /**
   * Look up registration attribution by hook ID, function reference, or entry object.
   * @param {number | Function | { id?: number, fn?: Function } | null | undefined} target
   * @returns {import('../../types/api.d.ts').EventAttribution | null}
   */
  getAttribution(target) {
    if (typeof target === "number") return this.#idToMeta.get(target) ?? null;
    if (typeof target === "function") {
      return this.#fnToMeta.get(target) ?? this.#wrappedToMeta.get(target) ?? null;
    }
    if (target && typeof target === "object") {
      if (typeof target.id === "number" && this.#idToMeta.has(target.id)) {
        return this.#idToMeta.get(target.id) ?? null;
      }
      if (typeof target.fn === "function") {
        return this.#fnToMeta.get(target.fn) ?? this.#wrappedToMeta.get(target.fn) ?? null;
      }
    }
    return null;
  }

  /**
   * Return the attribution of the currently executing wrapped hook callback, if any.
   * @returns {import('../../types/api.d.ts').EventAttribution | null}
   */
  currentAttribution() {
    return this.#callbackStack.length ? this.#callbackStack[this.#callbackStack.length - 1] : null;
  }

  /**
   * @param {string} hookName
   * @param {Function} fn
   * @returns {import('../../types/api.d.ts').EventAttribution}
   */
  #captureAttribution(hookName, fn) {
    const parsed = parseStackAttribution(new Error().stack, {hookName});
    if (fn.name && !parsed.fnName) {
      return {...parsed, fnName: fn.name};
    }
    return parsed;
  }

  /**
   * @param {string} hookName
   * @param {Function} originalFn
   * @param {import('../../types/api.d.ts').EventAttribution} meta
   * @param {boolean} isOnce
   * @returns {{ wrappedFn: (...args: unknown[]) => unknown, id: number | null }}
   */
  #createWrappedEntry(hookName, originalFn, meta, isOnce) {
    const registry = this;
    /** @type {{ wrappedFn: (...args: unknown[]) => unknown, id: number | null }} */
    const entry = {wrappedFn: () => undefined, id: null};

    /** @this {unknown} */
    const wrappedFn = function(/** @type {unknown[]} */ ...args) {
      if (isOnce) {
        registry.#removeSpecificWrapper(hookName, originalFn, wrappedFn);
        if (typeof entry.id === "number") registry.#idToEntry.delete(entry.id);
      }
      registry.#callbackStack.push(meta);
      try {
        const result = originalFn.apply(this, args);
        if (result === false) {
          registry.#markCurrentCallIntercepted(hookName);
          registry.#emitInterception({
            hookName,
            attribution: meta,
            args,
            callbackRegisteredEarly: false
          });
        }
        return result;
      } finally {
        registry.#callbackStack.pop();
      }
    };

    try {
      Object.defineProperty(wrappedFn, "name", {value: originalFn.name || "wrappedHook", configurable: true});
    } catch {
      // Non-fatal if engine disallows redefining function name.
    }

    entry.wrappedFn = wrappedFn;
    this.#wrappedToMeta.set(wrappedFn, meta);
    this.#fnToMeta.set(wrappedFn, meta);

    let byFn = this.#hookFnToWrappers.get(hookName);
    if (!byFn) {
      byFn = new Map();
      this.#hookFnToWrappers.set(hookName, byFn);
    }
    let list = byFn.get(originalFn);
    if (!list) {
      list = [];
      byFn.set(originalFn, list);
    }
    list.push(entry);

    return entry;
  }

  /**
   * @param {string} hookName
   * @param {Function} originalFn
   * @returns {{ wrappedFn: (...args: unknown[]) => unknown, id: number | null } | null}
   */
  #shiftWrappedFn(hookName, originalFn) {
    const byFn = this.#hookFnToWrappers.get(hookName);
    if (!byFn) return null;
    const list = byFn.get(originalFn);
    if (!list?.length) return null;
    const shifted = list.shift() ?? null;
    if (!list.length) byFn.delete(originalFn);
    if (!byFn.size) this.#hookFnToWrappers.delete(hookName);
    return shifted;
  }

  /**
   * @param {string} hookName
   * @param {Function} originalFn
   * @param {number} id
   */
  #removeWrappedEntryById(hookName, originalFn, id) {
    const byFn = this.#hookFnToWrappers.get(hookName);
    const list = byFn?.get(originalFn);
    if (!list) return;
    const index = list.findIndex(item => item.id === id);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) byFn?.delete(originalFn);
    if (byFn && !byFn.size) this.#hookFnToWrappers.delete(hookName);
  }

  /**
   * @param {string} hookName
   * @param {Function} originalFn
   * @param {Function} wrappedFn
   */
  #removeSpecificWrapper(hookName, originalFn, wrappedFn) {
    const byFn = this.#hookFnToWrappers.get(hookName);
    const list = byFn?.get(originalFn);
    if (!list) return;
    const index = list.findIndex(item => item.wrappedFn === wrappedFn);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) byFn?.delete(originalFn);
    if (byFn && !byFn.size) this.#hookFnToWrappers.delete(hookName);
  }

  /**
   * @param {string} hookName
   */
  #markCurrentCallIntercepted(hookName) {
    for (let i = this.#callStack.length - 1; i >= 0; i--) {
      if (this.#callStack[i].hookName === hookName) {
        this.#callStack[i].interceptedByWrapper = true;
        return;
      }
    }
  }

  /**
   * @param {string} hookName
   * @param {unknown[]} args
   */
  #emitEarlyInterception(hookName, args) {
    const listeners = this.#hooks?.events?.[hookName];
    /** @type {import('../../types/api.d.ts').EventAttribution[]} */
    const candidates = [];
    if (Array.isArray(listeners)) {
      for (const entry of listeners) {
        const known = this.getAttribution(entry);
        if (known) {
          candidates.push(known);
        } else {
          candidates.push({
            sourceType: "unknown",
            packageId: null,
            label: entry?.fn?.name || "early-listener",
            hookName,
            ...(entry?.fn?.name ? {fnName: entry.fn.name} : {}),
            confidence: "inferred"
          });
        }
      }
    }

    // If only one unwrapped early candidate exists, surface its name; otherwise report unknown early listener.
    const unknownCandidates = candidates.filter(c => !this.#fnToMeta.has(/** @type {any} */ (c)));
    const singleEarly = listeners?.length === 1 && !this.getAttribution(listeners[0])
      ? candidates[0]
      : null;

    /** @type {import('../../types/api.d.ts').EventAttribution} */
    const attribution = singleEarly ?? {
      sourceType: "unknown",
      packageId: null,
      label: "early-listener",
      hookName,
      ...(unknownCandidates[0]?.fnName ? {fnName: unknownCandidates[0].fnName} : {}),
      confidence: "inferred"
    };

    this.#emitInterception({
      hookName,
      attribution,
      args,
      callbackRegisteredEarly: true,
      candidates
    });
  }

  /**
   * @param {import('../../types/internal.d.ts').InterceptionCallbackPayload} payload
   */
  #emitInterception(payload) {
    if (this.#emitting || !this.#onInterception) return;
    this.#emitting = true;
    try {
      this.#onInterception(payload);
    } catch {
      // Never allow observer errors to disrupt hook execution.
    } finally {
      this.#emitting = false;
    }
  }
}
