// @ts-check
/**
 * In-memory bounded ring buffer, 10s pending `before`-value cache,
 * synchronous hook call stack, duplicate notification merging, unread tracking,
 * and schemaVersion=1 snapshot builder.
 */
import {
  DEFAULT_ACTION_WINDOW_MS,
  DEFAULT_MAX_EVENTS,
  MAX_ACTION_WINDOW_MS,
  MAX_MAX_EVENTS,
  MIN_ACTION_WINDOW_MS,
  MIN_MAX_EVENTS,
  MODULE_VERSION,
  PENDING_BEFORE_TTL_MS,
  SCHEMA_VERSION,
  clampNumber
} from "./constants.mjs";
import {
  filterEvents,
  groupEvents,
  normalizeFilter,
  notificationSignature,
  sanitizeConcealedRecord,
  shouldGroupByTimeWindow
} from "./trace.mjs";

const MAX_PRE_OP_QUEUE = 64;

export class TraceStore {
  /** @type {import('../../types/api.d.ts').TraceEventRecord[]} */
  #events = [];
  #maxEvents = DEFAULT_MAX_EVENTS;
  #actionWindowMs = DEFAULT_ACTION_WINDOW_MS;
  #pendingBeforeTtlMs = PENDING_BEFORE_TTL_MS;
  /** @type {() => number} */
  #now;
  /** @type {() => import('../../types/internal.d.ts').TraceStoreEnvironment} */
  #envProvider;

  #seq = 0;
  #actionSeq = 0;
  #frameSeq = 0;
  #unreadErrors = 0;
  #unreadInterceptions = 0;
  #windowOpen = false;

  /** @type {Map<string, import('../../types/internal.d.ts').PendingBeforeEntry>} */
  #pendingBefore = new Map();
  /** @type {import('../../types/internal.d.ts').PendingPreOpEntry[]} */
  #pendingPreOps = [];
  /** @type {import('../../types/internal.d.ts').SyncFrame[]} */
  #syncStack = [];

  /** @type {Map<string, import('../../types/api.d.ts').TraceEventRecord>} */
  #notificationBySig = new Map();
  /** @type {Map<string | number, import('../../types/api.d.ts').TraceEventRecord>} */
  #notificationById = new Map();
  /** @type {Set<() => void>} */
  #subscribers = new Set();

  /**
   * @param {{
   *   maxEvents?: number,
   *   actionWindowMs?: number,
   *   pendingBeforeTtlMs?: number,
   *   now?: () => number,
   *   environment?: () => import('../../types/internal.d.ts').TraceStoreEnvironment
   * }} [options]
   */
  constructor(options = {}) {
    this.#maxEvents = clampNumber(options.maxEvents, MIN_MAX_EVENTS, MAX_MAX_EVENTS, DEFAULT_MAX_EVENTS);
    this.#actionWindowMs = clampNumber(
      options.actionWindowMs,
      MIN_ACTION_WINDOW_MS,
      MAX_ACTION_WINDOW_MS,
      DEFAULT_ACTION_WINDOW_MS
    );
    this.#pendingBeforeTtlMs = typeof options.pendingBeforeTtlMs === "number" && options.pendingBeforeTtlMs >= 0
      ? options.pendingBeforeTtlMs
      : PENDING_BEFORE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#envProvider = options.environment ?? (() => ({}));
  }

  /** @returns {number} */
  get capacity() {
    return this.#maxEvents;
  }

  /** @returns {number} */
  get actionWindowMs() {
    return this.#actionWindowMs;
  }

  /** @returns {number} */
  get syncDepth() {
    return this.#syncStack.length;
  }

  /** @returns {number} */
  get unreadErrors() {
    return this.#unreadErrors;
  }

  /** @returns {number} */
  get unreadInterceptions() {
    return this.#unreadInterceptions;
  }

  /**
   * Update ring buffer capacity and immediately evict oldest entries if over limit.
   * @param {number} value
   */
  setMaxEvents(value) {
    this.#maxEvents = clampNumber(value, MIN_MAX_EVENTS, MAX_MAX_EVENTS, DEFAULT_MAX_EVENTS);
    if (this.#trimToCapacity()) this.#notify();
  }

  /**
   * Update short time-window action grouping threshold in milliseconds.
   * @param {number} value
   */
  setActionWindowMs(value) {
    this.#actionWindowMs = clampNumber(
      value,
      MIN_ACTION_WINDOW_MS,
      MAX_ACTION_WINDOW_MS,
      DEFAULT_ACTION_WINDOW_MS
    );
  }

  /**
   * Track whether `TraceWindow` is open; opening clears unread counters.
   * @param {boolean} isOpen
   */
  setWindowOpen(isOpen) {
    this.#windowOpen = Boolean(isOpen);
    if (this.#windowOpen) this.markRead();
  }

  /** Reset unread error and interception counts to zero. */
  markRead() {
    if (this.#unreadErrors === 0 && this.#unreadInterceptions === 0) return;
    this.#unreadErrors = 0;
    this.#unreadInterceptions = 0;
    this.#notify();
  }

  /**
   * Subscribe to store changes; returns an unsubscribe callback.
   * @param {() => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  /**
   * Cache shallow `before` values and local attribution under one or more UUID keys (10s TTL).
   * @param {string | string[]} keys
   * @param {Map<string, unknown>} beforeMap
   * @param {import('../../types/api.d.ts').EventAttribution | null} [attribution]
   * @param {number} [ts]
   */
  cacheBefore(keys, beforeMap, attribution = null, ts = this.#now()) {
    const keyList = (Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === "string" && k.length > 0);
    if (!keyList.length) return;
    if (this.#pendingBefore.size > 64) this.#pruneExpiredBefore(ts);
    /** @type {import('../../types/internal.d.ts').PendingBeforeEntry} */
    const entry = {
      beforeMap,
      attribution,
      expiresAt: ts + this.#pendingBeforeTtlMs,
      keys: keyList
    };
    for (const key of keyList) {
      this.#pendingBefore.set(key, entry);
    }
  }

  /**
   * Consume cached `before` values and pre-op attribution for any matching UUID key.
   * Clears all sibling keys sharing the matched entry.
   * @param {string | string[]} keys
   * @param {number} [ts]
   * @returns {{ beforeMap: Map<string, unknown>, attribution: import('../../types/api.d.ts').EventAttribution | null } | null}
   */
  consumeBefore(keys, ts = this.#now()) {
    const keyList = (Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === "string" && k.length > 0);
    for (const key of keyList) {
      const entry = this.#pendingBefore.get(key);
      if (!entry) continue;
      for (const siblingKey of entry.keys) {
        if (this.#pendingBefore.get(siblingKey) === entry) {
          this.#pendingBefore.delete(siblingKey);
        }
      }
      if (entry.expiresAt >= ts) {
        return {beforeMap: entry.beforeMap, attribution: entry.attribution};
      }
    }
    return null;
  }

  /**
   * Cache attribution from a local `preCreate*` or `preDelete*` hook until server broadcast completes.
   * @param {{
   *   documentName: string,
   *   action: import('../../types/internal.d.ts').DocumentAction,
   *   userId: string,
   *   attribution: import('../../types/api.d.ts').EventAttribution | null,
   *   name?: string | null
   * }} entry
   * @param {number} [ts]
   */
  cachePendingPreOp(entry, ts = this.#now()) {
    this.#pruneExpiredPreOps(ts);
    this.#pendingPreOps.push({
      ...entry,
      expiresAt: ts + this.#pendingBeforeTtlMs
    });
    if (this.#pendingPreOps.length > MAX_PRE_OP_QUEUE) {
      this.#pendingPreOps.shift();
    }
  }

  /**
   * Consume the oldest matching `preCreate` / `preDelete` attribution within TTL.
   * @param {{ documentName: string, action: import('../../types/internal.d.ts').DocumentAction, userId: string, name?: string | null }} query
   * @param {number} [ts]
   * @returns {import('../../types/api.d.ts').EventAttribution | null}
   */
  consumePendingPreOp(query, ts = this.#now()) {
    this.#pruneExpiredPreOps(ts);
    const index = this.#pendingPreOps.findIndex(item => {
      if (item.documentName !== query.documentName || item.action !== query.action || item.userId !== query.userId) {
        return false;
      }
      if (query.name && item.name && query.name !== item.name) return false;
      return true;
    });
    if (index < 0) return null;
    const [matched] = this.#pendingPreOps.splice(index, 1);
    return matched.attribution;
  }

  /**
   * Push a synchronous execution frame for causal action grouping.
   * @param {{ hookName?: string | null, attribution?: import('../../types/api.d.ts').EventAttribution | null }} [meta]
   * @returns {number} Frame token used to safely pop even if nested callbacks throw.
   */
  pushSyncFrame(meta = {}) {
    const token = ++this.#frameSeq;
    this.#syncStack.push({
      token,
      actionId: null,
      hookName: meta.hookName ?? null,
      attribution: meta.attribution ?? null
    });
    return token;
  }

  /**
   * Pop synchronous frames back to `token` (or pop the top frame if omitted).
   * @param {number | null} [token]
   */
  popSyncFrame(token = null) {
    if (!this.#syncStack.length) return;
    if (typeof token !== "number") {
      this.#syncStack.pop();
      return;
    }
    const index = this.#syncStack.findLastIndex(frame => frame.token === token);
    if (index >= 0) {
      this.#syncStack.length = index;
    }
  }

  /**
   * Run `fn` within a guarded synchronous frame.
   * @template T
   * @param {{ hookName?: string | null, attribution?: import('../../types/api.d.ts').EventAttribution | null }} meta
   * @param {() => T} fn
   * @returns {T}
   */
  runInSyncFrame(meta, fn) {
    const token = this.pushSyncFrame(meta);
    try {
      return fn();
    } finally {
      this.popSyncFrame(token);
    }
  }

  /**
   * Record a screen notification, merging non-progress duplicates in place and never joining document groups.
   * @param {{
   *   notificationId?: string | number | null,
   *   level?: string,
   *   text?: string,
   *   permanent?: boolean,
   *   progress?: boolean,
   *   pct?: number,
   *   user?: import('../../types/api.d.ts').TraceUserInfo,
   *   attribution?: import('../../types/api.d.ts').EventAttribution,
   *   combat?: import('../../types/api.d.ts').TraceCombatSnapshot | null,
   *   timestamp?: number,
   *   summary?: string
   * }} input
   * @returns {import('../../types/api.d.ts').TraceEventRecord}
   */
  recordNotification(input) {
    const ts = input.timestamp ?? this.#now();
    const level = normalizeLevel(input.level ?? "info");
    const text = String(input.text ?? "");
    const progress = Boolean(input.progress);
    const permanent = Boolean(input.permanent);
    const pct = typeof input.pct === "number" && Number.isFinite(input.pct) ? input.pct : 0;
    const notificationId = input.notificationId ?? null;

    if (!progress) {
      const sig = notificationSignature(level, text);
      const existing = this.#notificationBySig.get(sig);
      if (existing && this.#events.includes(existing)) {
        const prevCount = existing.repeat?.count ?? 1;
        existing.repeat = {
          count: prevCount + 1,
          firstAt: existing.repeat?.firstAt ?? existing.timestamp,
          lastAt: ts
        };
        if (notificationId !== null) this.#notificationById.set(notificationId, existing);
        this.#notify();
        return existing;
      }
    }

    const summary = input.summary ?? `[${level}] ${truncateSummary(text)}`;
    const record = this.recordEvent({
      timestamp: ts,
      kind: "notification",
      combat: input.combat ?? null,
      user: input.user,
      attribution: input.attribution,
      target: input.attribution?.packageId
        ? {type: "module", moduleId: input.attribution.packageId}
        : null,
      summary,
      detail: {
        notificationId,
        level,
        text,
        permanent,
        progress,
        pct
      }
    }, {allowTimeWindow: false});

    if (!progress) {
      this.#notificationBySig.set(notificationSignature(level, text), record);
    }
    if (notificationId !== null) {
      this.#notificationById.set(notificationId, record);
    }
    return record;
  }

  /**
   * Update an existing progress notification in place by `notificationId`.
   * @param {{ notificationId: string | number, text?: string, pct?: number, timestamp?: number }} update
   * @returns {import('../../types/api.d.ts').TraceEventRecord | null}
   */
  updateNotificationProgress(update) {
    if (update.notificationId === null || update.notificationId === undefined) return null;
    const existing = this.#notificationById.get(update.notificationId);
    if (!existing || !this.#events.includes(existing)) return null;

    const detail = {...existing.detail};
    if (typeof update.text === "string" && update.text.length > 0) {
      detail.text = update.text;
    }
    if (typeof update.pct === "number" && Number.isFinite(update.pct)) {
      detail.pct = update.pct;
    }
    existing.detail = detail;
    const pctLabel = typeof detail.pct === "number" ? ` (${Math.round(detail.pct * 100)}%)` : "";
    existing.summary = `[${String(detail.level ?? "info")}] ${truncateSummary(String(detail.text ?? ""))}${pctLabel}`;
    this.#notify();
    return existing;
  }

  /**
   * Append a normalized trace event into the ring buffer, assigning action group and updating unread badges.
   * @param {import('../../types/internal.d.ts').TraceRecordInput} input
   * @param {{ allowTimeWindow?: boolean }} [options]
   * @returns {import('../../types/api.d.ts').TraceEventRecord}
   */
  recordEvent(input, options = {}) {
    const ts = input.timestamp ?? this.#now();
    const seq = ++this.#seq;
    const id = `ev-${seq}`;
    const allowTimeWindow = options.allowTimeWindow ?? (input.kind === "document");

    const defaultUser = {id: "local", name: "User", isSelf: true, remote: false};
    const defaultAttr = {
      sourceType: /** @type {const} */ ("unknown"),
      packageId: null,
      label: "unknown",
      confidence: /** @type {const} */ ("unknown")
    };

    /** @type {import('../../types/api.d.ts').TraceEventRecord} */
    const draft = {
      id,
      seq,
      timestamp: ts,
      kind: input.kind,
      actionId: "",
      groupingBasis: "standalone",
      combat: input.combat ?? null,
      user: input.user ?? defaultUser,
      attribution: input.attribution ?? defaultAttr,
      target: input.target ?? null,
      summary: String(input.summary ?? ""),
      detail: input.detail ?? {},
      repeat: null,
      concealed: Boolean(input.concealed)
    };

    const sanitized = draft.concealed ? sanitizeConcealedRecord(draft) : draft;
    const {actionId, groupingBasis} = this.#assignGrouping(sanitized, allowTimeWindow);
    sanitized.actionId = actionId;
    sanitized.groupingBasis = groupingBasis;

    this.#events.push(sanitized);
    this.#trimToCapacity();

    if (!this.#windowOpen) {
      if (sanitized.kind === "error") this.#unreadErrors += 1;
      else if (sanitized.kind === "interception") this.#unreadInterceptions += 1;
    }

    this.#notify();
    return sanitized;
  }

  /**
   * Return filtered events (oldest first).
   * @param {import('../../types/api.d.ts').TraceFilter} [filter]
   * @returns {import('../../types/api.d.ts').TraceEventRecord[]}
   */
  getEvents(filter) {
    return filterEvents(this.#events, filter);
  }

  /**
   * Return filtered action groups.
   * @param {import('../../types/api.d.ts').TraceFilter} [filter]
   * @returns {import('../../types/api.d.ts').TraceActionGroup[]}
   */
  getGroups(filter) {
    return groupEvents(this.getEvents(filter));
  }

  /**
   * Return whether at least one stored event matches `filter`.
   * @param {import('../../types/api.d.ts').TraceFilter} filter
   * @returns {boolean}
   */
  hasEventsFor(filter) {
    return this.getEvents(filter).length > 0;
  }

  /**
   * Return sorted distinct module IDs observed across buffered events.
   * @returns {string[]}
   */
  distinctModules() {
    const ids = new Set();
    for (const event of this.#events) {
      if (event.attribution?.packageId) ids.add(event.attribution.packageId);
      if (event.target?.type === "module" && event.target.moduleId) ids.add(event.target.moduleId);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Compute lightweight `TraceSummary`.
   * @returns {import('../../types/api.d.ts').TraceSummary}
   */
  summary() {
    /** @type {Record<import('../../types/api.d.ts').EventKind, number>} */
    const counts = {document: 0, notification: 0, interception: 0, error: 0};
    for (const event of this.#events) {
      counts[event.kind] += 1;
    }
    const last = this.#events.length ? this.#events[this.#events.length - 1] : null;
    return {
      total: this.#events.length,
      counts,
      unreadErrors: this.#unreadErrors,
      unreadInterceptions: this.#unreadInterceptions,
      lastEventAt: last?.timestamp ?? null,
      capacity: this.#maxEvents
    };
  }

  /**
   * Build a `schemaVersion: 1` JSON snapshot envelope for export and cross-module diagnostics.
   * @param {import('../../types/api.d.ts').TraceSnapshotOptions} [options]
   * @returns {import('../../types/api.d.ts').TraceSnapshotEnvelope}
   */
  buildSnapshot(options = {}) {
    const now = this.#now();
    const filter = normalizeFilter(options?.filter);
    let events = filterEvents(this.#events, filter);

    if (typeof options?.windowMs === "number" && Number.isFinite(options.windowMs) && options.windowMs >= 0) {
      const cutoff = now - options.windowMs;
      events = events.filter(event => event.timestamp >= cutoff);
    }
    if (typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit >= 0) {
      const count = Math.floor(options.limit);
      events = count === 0 ? [] : events.slice(-count);
    }

    const safeEvents = events.map(event => sanitizeConcealedRecord(event));
    const groups = groupEvents(safeEvents);
    const env = this.#envProvider() ?? {};

    return {
      schemaVersion: SCHEMA_VERSION,
      producer: "event-trace",
      moduleVersion: env.moduleVersion ?? MODULE_VERSION,
      exportedAt: new Date(now).toISOString(),
      foundryVersion: env.foundryVersion ?? "13.351",
      systemId: env.systemId ?? "",
      worldId: env.worldId ?? "",
      userRole: env.userRole ?? "PLAYER",
      data: {
        filter,
        summary: this.summary(),
        modules: Array.isArray(env.modules) ? env.modules : [],
        groups,
        events: safeEvents
      }
    };
  }

  /** Clear all buffered events and transient caches. */
  clear() {
    this.#events.length = 0;
    this.#notificationBySig.clear();
    this.#notificationById.clear();
    this.#unreadErrors = 0;
    this.#unreadInterceptions = 0;
    this.#notify();
  }

  /**
   * @param {import('../../types/api.d.ts').TraceEventRecord} event
   * @param {boolean} allowTimeWindow
   * @returns {{ actionId: string, groupingBasis: "standalone" | "sync-stack" | "time-window" }}
   */
  #assignGrouping(event, allowTimeWindow) {
    const topFrame = this.#syncStack.length ? this.#syncStack[this.#syncStack.length - 1] : null;
    if (topFrame?.actionId) {
      return {actionId: topFrame.actionId, groupingBasis: "sync-stack"};
    }

    const lastEvent = this.#events.length ? this.#events[this.#events.length - 1] : null;
    if (allowTimeWindow && shouldGroupByTimeWindow(lastEvent, event, this.#actionWindowMs)) {
      const actionId = lastEvent ? lastEvent.actionId : `act-${++this.#actionSeq}`;
      if (this.#syncStack.length) {
        for (const frame of this.#syncStack) {
          if (!frame.actionId) frame.actionId = actionId;
        }
      }
      return {actionId, groupingBasis: "time-window"};
    }

    const actionId = `act-${++this.#actionSeq}`;
    if (this.#syncStack.length) {
      for (const frame of this.#syncStack) {
        if (!frame.actionId) frame.actionId = actionId;
      }
    }
    return {actionId, groupingBasis: "standalone"};
  }

  /** @returns {boolean} */
  #trimToCapacity() {
    let trimmed = false;
    while (this.#events.length > this.#maxEvents) {
      const evicted = this.#events.shift();
      trimmed = true;
      if (!evicted) continue;
      if (evicted.kind === "notification") {
        const sig = notificationSignature(
          String(evicted.detail?.level ?? "info"),
          String(evicted.detail?.text ?? "")
        );
        if (this.#notificationBySig.get(sig) === evicted) {
          this.#notificationBySig.delete(sig);
        }
        const nid = evicted.detail?.notificationId;
        if ((typeof nid === "string" || typeof nid === "number") && this.#notificationById.get(nid) === evicted) {
          this.#notificationById.delete(nid);
        }
      }
    }
    return trimmed;
  }

  /** @param {number} ts */
  #pruneExpiredBefore(ts) {
    for (const [key, entry] of this.#pendingBefore.entries()) {
      if (entry.expiresAt < ts) this.#pendingBefore.delete(key);
    }
  }

  /** @param {number} ts */
  #pruneExpiredPreOps(ts) {
    while (this.#pendingPreOps.length && this.#pendingPreOps[0].expiresAt < ts) {
      this.#pendingPreOps.shift();
    }
  }

  #notify() {
    for (const listener of this.#subscribers) {
      try {
        listener();
      } catch {
        // Isolate listener failures from store mutations.
      }
    }
  }
}

/**
 * @param {string} value
 * @returns {import('../../types/internal.d.ts').NotificationLevel}
 */
function normalizeLevel(value) {
  const level = String(value || "info").toLowerCase();
  if (level === "warn") return "warning";
  if (level === "info" || level === "warning" || level === "error" || level === "success") {
    return level;
  }
  return "info";
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateSummary(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean;
}
