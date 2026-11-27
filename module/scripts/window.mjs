// @ts-check
/**
 * TraceWindow (`ApplicationV2`): direct DOM rendering without Handlebars,
 * `data-trace-*` event delegation, faceted filters with counts, collapsible `<details>`
 * action groups, detail inspection pane, conditional peer jumps, and throttled live updates.
 */
import {
  EVENT_KINDS,
  FILTER_KINDS,
  WINDOW_REFRESH_THROTTLE_MS
} from "./constants.mjs";
import {
  createClock,
  formatAttributionLabel,
  formatDiffEntry,
  formatGroupSummary,
  formatSectionLabel
} from "./format.mjs";
import {
  buildTimelineSections,
  countFilterKinds,
  groupEvents,
  normalizeFilter
} from "./trace.mjs";

/** @type {TraceWindow | null} */
let activeWindow = null;

/** @type {import('../../types/internal.d.ts').TraceWindowContext | null} */
let defaultWindowContext = null;

/**
 * Register the default `{ store, env }` context used when Foundry constructs `TraceWindow` via settings menu.
 * @param {import('../../types/internal.d.ts').TraceWindowContext} ctx
 */
export function setDefaultWindowContext(ctx) {
  defaultWindowContext = ctx;
}

/** @returns {TraceWindow | null} */
export function getActiveTraceWindow() {
  return activeWindow;
}

/**
 * Create a DOM element with optional class name and text content.
 * @param {string} tag
 * @param {string} [className]
 * @param {string | null} [text]
 * @returns {HTMLElement}
 */
function el(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

/**
 * Create a FontAwesome icon element.
 * @param {string} iconClass
 * @returns {HTMLElement}
 */
function icon(iconClass) {
  const node = document.createElement("i");
  node.className = iconClass;
  node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * Default Foundry runtime adapter for `TraceWindow`.
 * @returns {import('../../types/internal.d.ts').TraceWindowEnvironment}
 */
export function createDefaultWindowEnvironment() {
  return {
    localize: (key, data) => {
      if (!globalThis.game?.i18n) return key;
      return data ? globalThis.game.i18n.format(key, data) : globalThis.game.i18n.localize(key);
    },
    lang: () => globalThis.game?.i18n?.lang ?? "en",
    isGM: () => Boolean(globalThis.game?.user?.isGM),
    getSelectedTarget: () => {
      const controlled = globalThis.canvas?.tokens?.controlled;
      if (Array.isArray(controlled) && controlled.length > 0) {
        const token = controlled[0];
        const uuid = token?.actor?.uuid ?? token?.document?.uuid ?? null;
        if (uuid) {
          return {uuid, label: token?.actor?.name ?? token?.document?.name ?? uuid};
        }
      }
      const char = globalThis.game?.user?.character;
      if (char?.uuid) return {uuid: char.uuid, label: char.name ?? char.uuid};
      return null;
    },
    fromUuidSync: uuid => {
      if (typeof globalThis.fromUuidSync !== "function" || !uuid) return null;
      try {
        return globalThis.fromUuidSync(uuid) ?? null;
      } catch {
        return null;
      }
    },
    locateToken: uuid => {
      if (!uuid) return false;
      try {
        const doc = typeof globalThis.fromUuidSync === "function" ? globalThis.fromUuidSync(uuid) : null;
        const tokenObj = doc?.object ?? (doc?.id ? globalThis.canvas?.tokens?.get?.(doc.id) : null);
        if (tokenObj?.center && typeof globalThis.canvas?.animatePan === "function") {
          void globalThis.canvas.animatePan({x: tokenObj.center.x, y: tokenObj.center.y});
          tokenObj.control?.({releaseOthers: true});
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    getPeer: id => globalThis.game?.modules?.get?.(id) ?? null,
    focusNativeMessage: messageId => {
      if (!messageId || typeof globalThis.document?.querySelector !== "function") return false;
      const escape = globalThis.CSS?.escape ?? (v => String(v));
      const node = globalThis.document.querySelector(`[data-message-id="${escape(messageId)}"]`);
      if (!node) return false;
      node.scrollIntoView?.({block: "center"});
      return true;
    },
    saveJsonFile: (data, filename) => {
      if (typeof globalThis.foundry?.utils?.saveDataToFile === "function") {
        globalThis.foundry.utils.saveDataToFile(data, "application/json", filename);
        return true;
      }
      return false;
    },
    worldId: () => globalThis.game?.world?.id ?? "world"
  };
}

/**
 * Resolve a Rule Lens TargetRef from a trace event if applicable.
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @returns {Record<string, unknown> | null}
 */
export function resolveRuleLensTarget(event) {
  if (event.kind !== "document") return null;
  const d = event.detail ?? {};
  const docName = String(d.documentName ?? "");
  const diffs = Array.isArray(d.diffs) ? d.diffs : [];
  const firstPath = diffs.find(item => typeof item?.path === "string" && !item.path.startsWith("_stats"))?.path;

  if (docName === "ActiveEffect") {
    const uuid = typeof d.actorUuid === "string" && d.actorUuid
      ? d.actorUuid
      : (typeof d.parentUuid === "string" && d.parentUuid ? d.parentUuid : (typeof d.uuid === "string" ? d.uuid : ""));
    if (!uuid) return null;
    return {type: "effects", uuid, ...(firstPath ? {path: firstPath} : {})};
  }

  if (docName === "Actor" && typeof d.uuid === "string" && d.uuid) {
    return {type: "actorField", uuid: d.uuid, ...(firstPath ? {path: firstPath} : {})};
  }

  if (docName === "ChatMessage" && d.isRoll === true && !event.concealed && typeof d.messageId === "string" && d.messageId) {
    return {type: "roll", messageId: d.messageId};
  }

  return null;
}

/**
 * Resolve a Runtime Monitor focus object from an event's attribution or hook detail.
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @returns {{ moduleId?: string, hookName?: string } | null}
 */
export function resolveRuntimeMonitorFocus(event) {
  const moduleId = event.attribution?.packageId
    || (event.target?.type === "module" ? event.target.moduleId : null)
    || null;
  const hookName = event.attribution?.hookName
    || (typeof event.detail?.hookName === "string" ? event.detail.hookName : null)
    || (typeof event.detail?.contextHook === "string" ? event.detail.contextHook : null)
    || null;
  if (!moduleId && !hookName) return null;
  return {
    ...(moduleId ? {moduleId} : {}),
    ...(hookName ? {hookName} : {})
  };
}

/**
 * Extract primary document UUID from an event when available.
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @returns {string | null}
 */
function eventDocumentUuid(event) {
  const d = event.detail ?? {};
  if (typeof d.uuid === "string" && d.uuid) return d.uuid;
  if (typeof d.targetUuid === "string" && d.targetUuid) return d.targetUuid;
  if (typeof d.contextUuid === "string" && d.contextUuid) return d.contextUuid;
  if (event.target && "uuid" in event.target && typeof event.target.uuid === "string") return event.target.uuid;
  return null;
}

/**
 * Extract primary ChatMessage ID from an event when available.
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @returns {string | null}
 */
function eventMessageId(event) {
  const d = event.detail ?? {};
  if (typeof d.messageId === "string" && d.messageId) return d.messageId;
  if (event.target?.type === "message" && event.target.messageId) return event.target.messageId;
  return null;
}

/** @type {typeof FoundryApplicationV2} */
const ApplicationV2Base = /** @type {any} */ (globalThis.foundry?.applications?.api?.ApplicationV2 ?? class {});

export class TraceWindow extends ApplicationV2Base {
  static DEFAULT_OPTIONS = {
    id: "event-trace-window",
    tag: "div",
    classes: ["event-trace-app"],
    window: {
      title: "EVENTTRACE.Window.Title",
      icon: "fa-solid fa-clock-rotate-left",
      resizable: true,
      minimizable: true,
      contentClasses: ["event-trace-content"]
    },
    position: {width: 760, height: 560}
  };

  /** @type {import('./store.mjs').TraceStore} */
  #store;
  /** @type {import('../../types/internal.d.ts').TraceWindowEnvironment} */
  #env;
  /** @type {import('../../types/api.d.ts').TraceFilter} */
  #filter = {};
  /** @type {string | null} */
  #selectedEventId = null;
  /** @type {Set<string>} */
  #expandedGroups = new Set();
  /** @type {(() => void) | null} */
  #unsubscribe = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #refreshTimer = null;
  /** @type {Record<string, any> | null} */
  #els = null;
  /** @type {import('../../types/internal.d.ts').TraceClock} */
  #clock;
  #renderCount = 0;

  /**
   * @param {Record<string, unknown> & {
   *   store?: import('./store.mjs').TraceStore,
   *   env?: Partial<import('../../types/internal.d.ts').TraceWindowEnvironment>,
   *   filter?: import('../../types/api.d.ts').TraceFilter
   * }} [options]
   */
  constructor(options = {}) {
    super(options);
    const resolvedStore = options.store ?? defaultWindowContext?.store;
    if (!resolvedStore) {
      throw new Error("TraceWindow requires a TraceStore instance.");
    }
    this.#store = resolvedStore;
    this.#env = {
      ...createDefaultWindowEnvironment(),
      ...(defaultWindowContext?.env ?? {}),
      ...(options.env ?? {})
    };
    this.#filter = normalizeFilter(options.filter);
    this.#clock = createClock(this.#env.lang());
  }

  /** @returns {import('../../types/api.d.ts').TraceFilter} */
  get filter() {
    return {...this.#filter};
  }

  /** @returns {string | null} */
  get selectedEventId() {
    return this.#selectedEventId;
  }

  /** @returns {number} */
  get refreshCount() {
    return this.#renderCount;
  }

  /**
   * Apply a new `TraceFilter` or `TargetRef` and immediately re-render if open.
   * @param {unknown} rawFilter
   */
  applyFilter(rawFilter) {
    this.#filter = normalizeFilter(rawFilter);
    this.#syncFilterInputs();
    if (this.rendered && this.#els) {
      this.#refreshAll();
    }
  }

  /**
   * Build the root shell DOM directly (no Handlebars templates).
   * @override
   * @param {Record<string, unknown>} _context
   * @param {Record<string, unknown>} _options
   * @returns {HTMLElement}
   */
  _renderHTML(_context, _options) {
    const shell = this.#buildShell();
    this.#els = this.#collectElements(shell);
    return shell;
  }

  /**
   * Mount the built DOM element into Foundry's window content container.
   * @override
   * @param {HTMLElement} result
   * @param {HTMLElement} content
   * @param {Record<string, unknown>} _options
   */
  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  /**
   * Wire event listeners, mark unread events read, and subscribe to live store updates while open.
   * @override
   * @param {Record<string, unknown>} context
   * @param {Record<string, unknown>} options
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if (activeWindow && activeWindow !== this) {
      activeWindow.close({animate: false}).catch(() => {});
    }
    activeWindow = this;

    if (this.element && !this.#els) {
      this.#els = this.#collectElements(this.element);
    }
    this.#attachEvents();
    this.#store.setWindowOpen(true);
    this.#unsubscribe?.();
    this.#unsubscribe = this.#store.subscribe(() => this.#scheduleRefresh());
    this.#syncFilterInputs();
    this.#refreshAll();
  }

  /**
   * Detach store subscription and timers immediately on close so closed windows incur zero DOM work.
   * @override
   * @param {Record<string, unknown>} [options]
   */
  _onClose(options) {
    super._onClose?.(options);
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#store.setWindowOpen(false);
    this.#els = null;
    if (activeWindow === this) activeWindow = null;
  }

  /**
   * @param {string} key
   * @param {Record<string, unknown>} [data]
   * @returns {string}
   */
  #t(key, data) {
    return this.#env.localize(key, data);
  }

  /** @returns {HTMLElement} */
  #buildShell() {
    const shell = el("div", "et-shell");

    const toolbar = el("header", "et-toolbar");
    const kindGroup = el("div", "et-filters");
    kindGroup.setAttribute("role", "toolbar");
    kindGroup.setAttribute("aria-label", this.#t("EVENTTRACE.Filter.Label"));
    for (const kind of FILTER_KINDS) {
      const btn = /** @type {HTMLButtonElement} */ (el("button", "et-filter"));
      btn.type = "button";
      btn.dataset.traceKind = kind;
      btn.setAttribute("aria-pressed", "false");
      btn.append(
        el("span", "et-filter__label", this.#t(`EVENTTRACE.Filter.${kind}`)),
        el("span", "et-filter__count", "0")
      );
      kindGroup.append(btn);
    }

    const controls = el("div", "et-toolbar__controls");

    const focusBtn = /** @type {HTMLButtonElement} */ (el("button", "et-btn et-btn--quiet"));
    focusBtn.type = "button";
    focusBtn.dataset.traceAction = "focus-selected";
    focusBtn.title = this.#t("EVENTTRACE.Toolbar.FocusSelectedHint");
    focusBtn.append(
      icon("fa-solid fa-crosshairs"),
      el("span", "", this.#t("EVENTTRACE.Toolbar.FocusSelected"))
    );

    const moduleSelect = /** @type {HTMLSelectElement} */ (el("select", "et-select"));
    moduleSelect.dataset.traceFilter = "module";
    moduleSelect.setAttribute("aria-label", this.#t("EVENTTRACE.Toolbar.ModuleLabel"));

    const searchWrap = el("label", "et-search");
    searchWrap.append(icon("fa-solid fa-magnifying-glass"));
    const searchInput = /** @type {HTMLInputElement} */ (el("input", "et-search__input"));
    searchInput.type = "search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchInput.dataset.traceFilter = "query";
    searchInput.placeholder = this.#t("EVENTTRACE.Toolbar.SearchPlaceholder");
    searchInput.setAttribute("aria-label", this.#t("EVENTTRACE.Toolbar.SearchLabel"));
    const clearSearchBtn = /** @type {HTMLButtonElement} */ (el("button", "et-search__clear"));
    clearSearchBtn.type = "button";
    clearSearchBtn.dataset.traceAction = "clear-query";
    clearSearchBtn.hidden = true;
    clearSearchBtn.setAttribute("aria-label", this.#t("EVENTTRACE.Toolbar.ClearSearch"));
    clearSearchBtn.append(icon("fa-solid fa-xmark"));
    searchWrap.append(searchInput, clearSearchBtn);

    const clearStoreBtn = /** @type {HTMLButtonElement} */ (el("button", "et-btn et-btn--quiet"));
    clearStoreBtn.type = "button";
    clearStoreBtn.dataset.traceAction = "clear-store";
    clearStoreBtn.append(
      icon("fa-solid fa-trash-can"),
      el("span", "", this.#t("EVENTTRACE.Toolbar.Clear"))
    );

    const exportBtn = /** @type {HTMLButtonElement} */ (el("button", "et-btn et-btn--primary"));
    exportBtn.type = "button";
    exportBtn.dataset.traceAction = "export-snapshot";
    exportBtn.append(
      icon("fa-solid fa-file-export"),
      el("span", "", this.#t("EVENTTRACE.Toolbar.Export"))
    );

    controls.append(focusBtn, moduleSelect, searchWrap, clearStoreBtn, exportBtn);
    toolbar.append(kindGroup, controls);

    const statusBar = el("div", "et-status-bar");
    const statusText = el("span", "et-status-text");
    statusText.setAttribute("aria-live", "polite");
    const chips = el("div", "et-chips");
    statusBar.append(statusText, chips);

    const workspace = el("div", "et-workspace");
    const timeline = el("main", "et-timeline");
    timeline.setAttribute("aria-label", this.#t("EVENTTRACE.Timeline.Label"));
    const detail = el("aside", "et-detail");
    detail.hidden = true;
    detail.setAttribute("aria-label", this.#t("EVENTTRACE.Detail.Label"));
    workspace.append(timeline, detail);

    shell.append(toolbar, statusBar, workspace);
    return shell;
  }

  /**
   * @param {HTMLElement} root
   * @returns {Record<string, any>}
   */
  #collectElements(root) {
    const shell = root.classList.contains("et-shell") ? root : (root.querySelector(".et-shell") ?? root);
    return {
      shell,
      filters: shell.querySelector(".et-filters"),
      moduleSelect: shell.querySelector('[data-trace-filter="module"]'),
      search: shell.querySelector('[data-trace-filter="query"]'),
      clearQuery: shell.querySelector('[data-trace-action="clear-query"]'),
      statusText: shell.querySelector(".et-status-text"),
      chips: shell.querySelector(".et-chips"),
      workspace: shell.querySelector(".et-workspace"),
      timeline: shell.querySelector(".et-timeline"),
      detail: shell.querySelector(".et-detail")
    };
  }

  #attachEvents() {
    const els = this.#els;
    if (!els || els.shell.dataset.traceBound === "true") return;
    els.shell.dataset.traceBound = "true";

    els.search.addEventListener("input", () => {
      const nextQuery = els.search.value.trim();
      if (nextQuery) this.#filter.query = nextQuery;
      else delete this.#filter.query;
      els.clearQuery.hidden = !els.search.value;
      this.#refreshAll();
    });

    els.search.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
      if (event.key === "Escape" && (els.search.value || this.#filter.query)) {
        event.preventDefault();
        event.stopPropagation();
        els.search.value = "";
        delete this.#filter.query;
        els.clearQuery.hidden = true;
        this.#refreshAll();
      }
    });

    els.moduleSelect.addEventListener("change", () => {
      const val = els.moduleSelect.value;
      if (val) this.#filter.moduleId = val;
      else delete this.#filter.moduleId;
      this.#refreshAll();
    });

    els.shell.addEventListener("toggle", (/** @type {Event} */ event) => {
      const details = /** @type {HTMLDetailsElement | null} */ (
        /** @type {HTMLElement} */ (event.target)?.closest?.("[data-trace-group]")
      );
      if (!details) return;
      const groupId = details.dataset.traceGroup;
      if (!groupId) return;
      if (details.open) this.#expandedGroups.add(groupId);
      else this.#expandedGroups.delete(groupId);
    }, true);

    els.shell.addEventListener("click", (/** @type {MouseEvent} */ event) => {
      const target = /** @type {HTMLElement | null} */ (event.target);
      if (!target) return;

      const kindBtn = /** @type {HTMLElement | null} */ (target.closest("[data-trace-kind]"));
      if (kindBtn) {
        const kind = kindBtn.dataset.traceKind;
        if (kind === "all") delete this.#filter.kind;
        else if (EVENT_KINDS.includes(/** @type {any} */ (kind))) {
          this.#filter.kind = /** @type {import('../../types/api.d.ts').EventKind} */ (kind);
        }
        this.#refreshAll();
        return;
      }

      const clearFilterBtn = /** @type {HTMLElement | null} */ (target.closest("[data-trace-clear-filter]"));
      if (clearFilterBtn) {
        const key = /** @type {keyof import('../../types/api.d.ts').TraceFilter} */ (
          clearFilterBtn.dataset.traceClearFilter
        );
        if (key) delete this.#filter[key];
        this.#syncFilterInputs();
        this.#refreshAll();
        return;
      }

      const actionEl = /** @type {HTMLElement | null} */ (target.closest("[data-trace-action]"));
      if (actionEl) {
        this.#handleAction(actionEl.dataset.traceAction ?? "", actionEl);
        return;
      }

      const eventRow = /** @type {HTMLElement | null} */ (target.closest("[data-trace-event-id]"));
      if (eventRow && !target.closest("summary")) {
        const id = eventRow.dataset.traceEventId ?? null;
        this.#selectedEventId = this.#selectedEventId === id ? null : id;
        this.#refreshAll();
      }
    });

    els.shell.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = /** @type {HTMLElement | null} */ (event.target);
      if (!target || target.closest("button, input, select, summary")) return;
      const eventRow = /** @type {HTMLElement | null} */ (target.closest("[data-trace-event-id]"));
      if (!eventRow) return;
      event.preventDefault();
      const id = eventRow.dataset.traceEventId ?? null;
      this.#selectedEventId = this.#selectedEventId === id ? null : id;
      this.#refreshAll();
    });
  }

  /**
   * @param {string} action
   * @param {HTMLElement} actionEl
   */
  #handleAction(action, actionEl) {
    switch (action) {
      case "focus-selected": {
        const selected = this.#env.getSelectedTarget();
        if (selected?.uuid) {
          this.#filter.uuid = selected.uuid;
          this.#refreshAll();
        }
        break;
      }
      case "clear-query": {
        delete this.#filter.query;
        if (this.#els?.search) this.#els.search.value = "";
        if (this.#els?.clearQuery) this.#els.clearQuery.hidden = true;
        this.#refreshAll();
        break;
      }
      case "reset-filters": {
        this.#filter = {};
        this.#syncFilterInputs();
        this.#refreshAll();
        break;
      }
      case "clear-store": {
        this.#selectedEventId = null;
        this.#expandedGroups.clear();
        this.#store.clear();
        this.#refreshAll();
        break;
      }
      case "export-snapshot": {
        this.#exportSnapshot();
        break;
      }
      case "close-detail": {
        this.#selectedEventId = null;
        this.#refreshAll();
        break;
      }
      case "open-sheet": {
        const uuid = actionEl.dataset.traceUuid;
        if (uuid) {
          const doc = this.#env.fromUuidSync(uuid);
          doc?.sheet?.render?.(true);
        }
        break;
      }
      case "locate-token": {
        const uuid = actionEl.dataset.traceUuid;
        if (uuid) this.#env.locateToken(uuid);
        break;
      }
      case "jump-chat-lens-focus": {
        const messageId = actionEl.dataset.traceMessageId;
        const peer = this.#env.getPeer("chat-lens");
        if (messageId && peer?.active && typeof peer.api?.focusMessage === "function") {
          void peer.api.focusMessage(messageId);
        }
        break;
      }
      case "jump-chat-lens-details": {
        const messageId = actionEl.dataset.traceMessageId;
        const peer = this.#env.getPeer("chat-lens");
        if (messageId && peer?.active && typeof peer.api?.openDetails === "function") {
          void peer.api.openDetails(messageId);
        }
        break;
      }
      case "locate-native-message": {
        const messageId = actionEl.dataset.traceMessageId;
        if (messageId) this.#env.focusNativeMessage(messageId);
        break;
      }
      case "jump-rule-lens": {
        const selected = this.#findSelectedEvent();
        const target = selected ? resolveRuleLensTarget(selected) : null;
        const peer = this.#env.getPeer("rule-lens");
        if (target && peer?.active && typeof peer.api?.open === "function") {
          void peer.api.open(target);
        }
        break;
      }
      case "jump-runtime-monitor": {
        const selected = this.#findSelectedEvent();
        const focus = selected ? resolveRuntimeMonitorFocus(selected) : null;
        const peer = this.#env.getPeer("runtime-monitor");
        if (focus && peer?.active && typeof peer.api?.open === "function") {
          void peer.api.open(focus);
        }
        break;
      }
      case "filter-target": {
        const uuid = actionEl.dataset.traceUuid;
        const messageId = actionEl.dataset.traceMessageId;
        if (uuid) this.#filter.uuid = uuid;
        else if (messageId) this.#filter.messageId = messageId;
        this.#refreshAll();
        break;
      }
      case "filter-module": {
        const moduleId = actionEl.dataset.traceModuleId;
        if (moduleId) {
          this.#filter.moduleId = moduleId;
          this.#syncFilterInputs();
          this.#refreshAll();
        }
        break;
      }
    }
  }

  #exportSnapshot() {
    const snapshot = this.#store.buildSnapshot({filter: this.#filter});
    const worldSlug = String(this.#env.worldId() || "world").replace(/[^a-zA-Z0-9_-]+/g, "-");
    const stamp = snapshot.exportedAt.replace(/[:.]/g, "-");
    const filename = `event-trace-${worldSlug}-${stamp}.json`;
    const json = JSON.stringify(snapshot, null, 2);
    this.#env.saveJsonFile(json, filename);
  }

  #scheduleRefresh() {
    if (!this.rendered || !this.#els) return;
    if (this.#refreshTimer !== null) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      if (!this.rendered || !this.#els) return;
      this.#refreshAll();
    }, WINDOW_REFRESH_THROTTLE_MS);
  }

  #syncFilterInputs() {
    const els = this.#els;
    if (!els) return;
    const query = this.#filter.query ?? "";
    if (els.search.value !== query && globalThis.document?.activeElement !== els.search) {
      els.search.value = query;
    }
    els.clearQuery.hidden = !els.search.value;
  }

  /** @returns {import('../../types/api.d.ts').TraceEventRecord | null} */
  #findSelectedEvent() {
    if (!this.#selectedEventId) return null;
    const all = this.#store.getEvents();
    return all.find(ev => ev.id === this.#selectedEventId) ?? null;
  }

  #refreshAll() {
    const els = this.#els;
    if (!els) return;
    this.#renderCount += 1;

    const allEvents = this.#store.getEvents();
    const filteredEvents = this.#store.getEvents(this.#filter);
    const groups = groupEvents(filteredEvents);
    const sections = buildTimelineSections(groups);
    const facetCounts = countFilterKinds(allEvents, this.#filter);

    this.#refreshKindBar(facetCounts);
    this.#refreshModuleOptions();
    this.#refreshStatusBar(filteredEvents.length, allEvents.length, groups.length);
    this.#refreshTimeline(sections, allEvents.length);
    this.#refreshDetail(filteredEvents);
  }

  /**
   * @param {{ all: number } & Record<import('../../types/api.d.ts').EventKind, number>} counts
   */
  #refreshKindBar(counts) {
    const els = this.#els;
    if (!els) return;
    const activeKind = this.#filter.kind ?? "all";
    for (const btn of els.filters.querySelectorAll("[data-trace-kind]")) {
      const kind = btn.dataset.traceKind;
      const isActive = kind === activeKind;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
      const countEl = btn.querySelector(".et-filter__count");
      if (countEl) countEl.textContent = String(counts[/** @type {keyof typeof counts} */ (kind)] ?? 0);
    }
  }

  #refreshModuleOptions() {
    const els = this.#els;
    if (!els) return;
    const select = /** @type {HTMLSelectElement} */ (els.moduleSelect);
    const modules = new Set(this.#store.distinctModules());
    if (this.#filter.moduleId) modules.add(this.#filter.moduleId);
    const sorted = [...modules].sort((a, b) => a.localeCompare(b));

    const opts = [new Option(this.#t("EVENTTRACE.Toolbar.AllModules"), "")];
    for (const modId of sorted) {
      opts.push(new Option(modId, modId));
    }
    select.replaceChildren(...opts);
    select.value = this.#filter.moduleId ?? "";
  }

  /**
   * @param {number} shown
   * @param {number} total
   * @param {number} groupCount
   */
  #refreshStatusBar(shown, total, groupCount) {
    const els = this.#els;
    if (!els) return;
    els.statusText.textContent = this.#t("EVENTTRACE.Status.Shown", {
      shown,
      total,
      groups: groupCount
    });

    /** @type {HTMLElement[]} */
    const chips = [];
    /**
     * @param {keyof import('../../types/api.d.ts').TraceFilter} key
     * @param {string} label
     */
    const addChip = (key, label) => {
      const chip = el("button", "et-chip");
      /** @type {HTMLButtonElement} */ (chip).type = "button";
      chip.dataset.traceClearFilter = key;
      chip.append(el("span", "", label), icon("fa-solid fa-xmark"));
      chips.push(chip);
    };

    if (this.#filter.uuid) addChip("uuid", this.#t("EVENTTRACE.Chip.Uuid", {value: this.#filter.uuid}));
    if (this.#filter.messageId) addChip("messageId", this.#t("EVENTTRACE.Chip.Message", {value: this.#filter.messageId}));
    if (this.#filter.moduleId) addChip("moduleId", this.#t("EVENTTRACE.Chip.Module", {value: this.#filter.moduleId}));
    if (this.#filter.query) addChip("query", this.#t("EVENTTRACE.Chip.Query", {value: this.#filter.query}));

    if (chips.length > 0 || this.#filter.kind) {
      const reset = /** @type {HTMLButtonElement} */ (el("button", "et-chip et-chip--reset", this.#t("EVENTTRACE.Status.Reset")));
      reset.type = "button";
      reset.dataset.traceAction = "reset-filters";
      chips.push(reset);
    }

    els.chips.replaceChildren(...chips);
  }

  /**
   * @param {import('../../types/internal.d.ts').TraceTimelineSection[]} sections
   * @param {number} totalInStore
   */
  #refreshTimeline(sections, totalInStore) {
    const els = this.#els;
    if (!els) return;

    if (!sections.length) {
      const empty = el("div", "et-empty");
      empty.append(
        icon("fa-solid fa-wave-square"),
        el("p", "", totalInStore === 0
          ? this.#t("EVENTTRACE.Timeline.Empty")
          : this.#t("EVENTTRACE.Timeline.NoMatches"))
      );
      if (totalInStore > 0) {
        const reset = /** @type {HTMLButtonElement} */ (el("button", "et-btn", this.#t("EVENTTRACE.Status.Reset")));
        reset.type = "button";
        reset.dataset.traceAction = "reset-filters";
        empty.append(reset);
      }
      els.timeline.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const section of sections) {
      const sectionEl = el("section", "et-section");
      sectionEl.dataset.traceSection = section.id;

      const header = el("header", "et-section__head");
      header.append(
        icon(section.kind === "combat" ? "fa-solid fa-swords" : "fa-regular fa-clock"),
        el("span", "et-section__title", formatSectionLabel(section, this.#clock, (k, d) => this.#t(k, d)))
      );
      sectionEl.append(header);

      const list = el("div", "et-section__groups");
      for (const group of section.groups) {
        if (group.events.length >= 2) {
          list.append(this.#renderActionGroup(group));
        } else if (group.events[0]) {
          list.append(this.#renderEventRow(group.events[0], false));
        }
      }
      sectionEl.append(list);
      fragment.append(sectionEl);
    }

    els.timeline.replaceChildren(fragment);
  }

  /**
   * @param {import('../../types/api.d.ts').TraceActionGroup} group
   * @returns {HTMLElement}
   */
  #renderActionGroup(group) {
    const details = /** @type {HTMLDetailsElement} */ (el("details", "et-group"));
    details.dataset.traceGroup = group.id;
    const hasSelectedChild = group.events.some(ev => ev.id === this.#selectedEventId);
    details.open = this.#expandedGroups.has(group.id) || hasSelectedChild;

    const first = group.events[0];
    const summary = el("summary", "et-group__summary");
    summary.append(
      el("span", "et-time", this.#clock.clockSeconds(first.timestamp)),
      el("span", "et-group__count", this.#t("EVENTTRACE.Group.Count", {count: group.events.length})),
      el("span", "et-group__title", formatGroupSummary(group, (k, d) => this.#t(k, d))),
      el("span", "et-source-pill", formatAttributionLabel(group.attribution, (k, d) => this.#t(k, d)))
    );

    const children = el("div", "et-group__events");
    for (const ev of group.events) {
      children.append(this.#renderEventRow(ev, true));
    }

    details.append(summary, children);
    return details;
  }

  /**
   * @param {import('../../types/api.d.ts').TraceEventRecord} ev
   * @param {boolean} nested
   * @returns {HTMLElement}
   */
  #renderEventRow(ev, nested) {
    const row = el(
      "div",
      `et-event et-event--${ev.kind}${nested ? " et-event--nested" : ""}${ev.id === this.#selectedEventId ? " is-selected" : ""}`
    );
    row.dataset.traceEventId = ev.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", String(ev.id === this.#selectedEventId));

    const time = el("span", "et-time", this.#clock.clockSeconds(ev.timestamp));
    time.title = this.#clock.full(ev.timestamp);

    const kindBadge = el("span", `et-badge et-badge--${ev.kind}`, this.#t(`EVENTTRACE.Kind.${ev.kind}`));
    const main = el("span", "et-event__summary", ev.summary);
    const meta = el("span", "et-event__meta");

    if (ev.repeat && ev.repeat.count > 1) {
      const rep = el("span", "et-repeat", `×${ev.repeat.count}`);
      rep.title = this.#t("EVENTTRACE.Repeat.Tooltip", {
        count: ev.repeat.count,
        first: this.#clock.full(ev.repeat.firstAt),
        last: this.#clock.full(ev.repeat.lastAt)
      });
      meta.append(rep);
    }

    if (ev.concealed) {
      meta.append(el("span", "et-badge et-badge--concealed", this.#t("EVENTTRACE.Badge.Concealed")));
    }

    if (ev.user?.remote) {
      meta.append(el("span", "et-badge et-badge--remote", ev.user.name));
    }

    const source = el("span", "et-source-pill", formatAttributionLabel(ev.attribution, (k, d) => this.#t(k, d)));
    meta.append(source);

    row.append(time, kindBadge, main, meta);
    return row;
  }

  /**
   * @param {import('../../types/api.d.ts').TraceEventRecord[]} filteredEvents
   */
  #refreshDetail(filteredEvents) {
    const els = this.#els;
    if (!els) return;

    const ev = filteredEvents.find(item => item.id === this.#selectedEventId) ?? null;
    if (!ev) {
      els.workspace.classList.remove("has-selection");
      els.detail.hidden = true;
      els.detail.replaceChildren();
      return;
    }

    els.workspace.classList.add("has-selection");
    els.detail.hidden = false;

    /** @type {(key: string, data?: Record<string, unknown>) => string} */
    const t = (k, d) => this.#t(k, d);
    const header = el("header", "et-detail__head");
    header.append(
      el("span", `et-badge et-badge--${ev.kind}`, t(`EVENTTRACE.Kind.${ev.kind}`)),
      el("h4", "et-detail__title", ev.summary)
    );
    const closeBtn = /** @type {HTMLButtonElement} */ (el("button", "et-icon-btn"));
    closeBtn.type = "button";
    closeBtn.dataset.traceAction = "close-detail";
    closeBtn.setAttribute("aria-label", t("EVENTTRACE.Detail.Close"));
    closeBtn.append(icon("fa-solid fa-xmark"));
    header.append(closeBtn);

    const metaList = el("dl", "et-meta");
    const addMeta = (/** @type {string} */ label, /** @type {string} */ value) => {
      metaList.append(el("dt", "", label), el("dd", "", value));
    };
    addMeta(t("EVENTTRACE.Detail.Time"), this.#clock.full(ev.timestamp));
    addMeta(
      t("EVENTTRACE.Detail.User"),
      ev.user?.remote
        ? t("EVENTTRACE.Detail.RemoteUser", {name: ev.user.name})
        : (ev.user?.name || t("EVENTTRACE.Diff.None"))
    );
    addMeta(
      t("EVENTTRACE.Detail.Source"),
      [
        formatAttributionLabel(ev.attribution, t),
        ev.attribution?.hookName ? `hook: ${ev.attribution.hookName}` : "",
        ev.attribution?.fnName ? `fn: ${ev.attribution.fnName}` : ""
      ].filter(Boolean).join(" · ")
    );
    if (ev.combat) {
      addMeta(t("EVENTTRACE.Detail.Combat"), t("EVENTTRACE.Section.Combat", {
        round: ev.combat.round,
        turn: ev.combat.turn + 1,
        name: ev.combat.combatantName ?? t("EVENTTRACE.Diff.None")
      }));
    }
    if (ev.repeat) {
      addMeta(t("EVENTTRACE.Detail.Repeat"), t("EVENTTRACE.Repeat.Tooltip", {
        count: ev.repeat.count,
        first: this.#clock.full(ev.repeat.firstAt),
        last: this.#clock.full(ev.repeat.lastAt)
      }));
    }

    const body = el("div", "et-detail__body");
    this.#renderDetailBody(ev, body, t);

    const actions = el("div", "et-detail__actions");
    this.#renderDetailActions(ev, actions, t);

    els.detail.replaceChildren(header, metaList, body, actions);
  }

  /**
   * @param {import('../../types/api.d.ts').TraceEventRecord} ev
   * @param {HTMLElement} container
   * @param {(key: string, data?: Record<string, unknown>) => string} t
   */
  #renderDetailBody(ev, container, t) {
    const d = ev.detail ?? {};
    if (ev.kind === "document") {
      const action = String(d.action ?? "update");
      const docMetaParts = [
        t(`EVENTTRACE.DocumentAction.${action}`),
        d.documentName ? String(d.documentName) : "",
        d.uuid ? String(d.uuid) : ""
      ].filter(Boolean);
      if (docMetaParts.length) {
        container.append(el("p", "et-detail__kv", docMetaParts.join(" · ")));
      }
      if (ev.concealed) {
        container.append(el("p", "et-note et-note--warn", t("EVENTTRACE.Detail.ConcealedNotice")));
      }
      const diffs = Array.isArray(d.diffs) ? d.diffs : [];
      if (diffs.length) {
        const table = el("div", "et-diffs");
        const beforeCached = d.beforeCached !== false;
        for (const diff of diffs) {
          const formatted = formatDiffEntry(diff, t, {beforeCached});
          const item = el("div", "et-diff-row");
          item.append(
            el("span", "et-diff-row__path", formatted.path),
            el("span", "et-diff-row__values", `${formatted.beforeText} → ${formatted.afterText}`)
          );
          table.append(item);
        }
        container.append(table);
      } else {
        container.append(el("p", "et-note", t("EVENTTRACE.Detail.NoDiffs")));
      }
      if (typeof d.omittedDiffCount === "number" && d.omittedDiffCount > 0) {
        container.append(el("p", "et-note", t("EVENTTRACE.Detail.OmittedDiffs", {count: d.omittedDiffCount})));
      }
      if (d.optionsSummary && typeof d.optionsSummary === "object") {
        const flags = Object.entries(d.optionsSummary)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${String(value)}`);
        if (flags.length) {
          container.append(el("p", "et-note", t("EVENTTRACE.Detail.Options", {flags: flags.join(", ")})));
        }
      }
      return;
    }

    if (ev.kind === "notification") {
      const level = String(d.level ?? "info");
      container.append(
        el("p", "et-detail__kv", `${t(`EVENTTRACE.NotificationLevel.${level}`)}`),
        el("pre", "et-pre", String(d.text ?? ""))
      );
      if (d.progress) {
        container.append(el("p", "et-note", t("EVENTTRACE.Detail.Progress", {
          pct: Math.round(Number(d.pct ?? 0) * 100)
        })));
      }
      return;
    }

    if (ev.kind === "interception") {
      container.append(
        el("p", "et-detail__kv", t("EVENTTRACE.Detail.InterceptionInfo", {
          hook: String(d.hookName ?? ""),
          target: String(d.targetName || d.targetUuid || t("EVENTTRACE.Diff.None"))
        }))
      );
      if (d.callbackRegisteredEarly) {
        container.append(el("p", "et-note et-note--warn", t("EVENTTRACE.Detail.EarlyCallback")));
      }
      return;
    }

    if (ev.kind === "error") {
      const origin = String(d.origin ?? "hooks");
      const head = [
        t(`EVENTTRACE.ErrorOrigin.${origin}`),
        d.location ? String(d.location) : "",
        d.contextHook ? `hook: ${String(d.contextHook)}` : ""
      ].filter(Boolean).join(" · ");
      container.append(
        el("p", "et-detail__kv", head),
        el("pre", "et-pre", String(d.message ?? ""))
      );
      if (Array.isArray(d.stackLines) && d.stackLines.length > 0) {
        container.append(el("pre", "et-stack", d.stackLines.map(String).join("\n")));
      }
    }
  }

  /**
   * @param {import('../../types/api.d.ts').TraceEventRecord} ev
   * @param {HTMLElement} actions
   * @param {(key: string, data?: Record<string, unknown>) => string} t
   */
  #renderDetailActions(ev, actions, t) {
    /**
     * @param {string} action
     * @param {string} label
     * @param {string} iconClass
     * @param {Record<string, string>} [dataset]
     */
    const addBtn = (action, label, iconClass, dataset = {}) => {
      const btn = /** @type {HTMLButtonElement} */ (el("button", "et-btn et-btn--small"));
      btn.type = "button";
      btn.dataset.traceAction = action;
      for (const [k, v] of Object.entries(dataset)) btn.dataset[k] = v;
      btn.append(icon(iconClass), el("span", "", label));
      actions.append(btn);
    };

    const docUuid = eventDocumentUuid(ev);
    if (docUuid) {
      const doc = this.#env.fromUuidSync(docUuid);
      if (doc?.sheet) {
        addBtn("open-sheet", t("EVENTTRACE.Action.OpenSheet"), "fa-solid fa-up-right-from-square", {traceUuid: docUuid});
      }
      if (doc?.object || ev.detail?.documentName === "Token") {
        addBtn("locate-token", t("EVENTTRACE.Action.LocateToken"), "fa-solid fa-location-crosshairs", {traceUuid: docUuid});
      }
      addBtn("filter-target", t("EVENTTRACE.Action.FilterTarget"), "fa-solid fa-filter", {traceUuid: docUuid});
    }

    const messageId = eventMessageId(ev);
    if (messageId) {
      const chatLens = this.#env.getPeer("chat-lens");
      const hasFocus = Boolean(chatLens?.active && typeof chatLens.api?.focusMessage === "function");
      const hasDetails = Boolean(chatLens?.active && typeof chatLens.api?.openDetails === "function");
      if (hasFocus) {
        addBtn("jump-chat-lens-focus", t("EVENTTRACE.Action.ChatLensFocus"), "fa-solid fa-comment-dots", {traceMessageId: messageId});
      }
      if (hasDetails) {
        addBtn("jump-chat-lens-details", t("EVENTTRACE.Action.ChatLensDetails"), "fa-solid fa-circle-info", {traceMessageId: messageId});
      }
      if (!hasFocus && !hasDetails) {
        const escape = globalThis.CSS?.escape ?? (v => String(v));
        const hasNative = Boolean(globalThis.document?.querySelector?.(`[data-message-id="${escape(messageId)}"]`));
        if (hasNative) {
          addBtn("locate-native-message", t("EVENTTRACE.Action.LocateMessage"), "fa-solid fa-message", {traceMessageId: messageId});
        }
      }
    }

    const ruleTarget = resolveRuleLensTarget(ev);
    if (ruleTarget) {
      const ruleLens = this.#env.getPeer("rule-lens");
      if (ruleLens?.active && typeof ruleLens.api?.open === "function") {
        addBtn("jump-rule-lens", t("EVENTTRACE.Action.RuleLens"), "fa-solid fa-magnifying-glass-chart");
      }
    }

    const rmFocus = resolveRuntimeMonitorFocus(ev);
    if (rmFocus) {
      const rm = this.#env.getPeer("runtime-monitor");
      if (rm?.active && typeof rm.api?.open === "function") {
        addBtn("jump-runtime-monitor", t("EVENTTRACE.Action.RuntimeMonitor"), "fa-solid fa-gauge-high");
      }
    }

    if (ev.attribution?.packageId) {
      addBtn("filter-module", t("EVENTTRACE.Action.FilterModule"), "fa-solid fa-cube", {
        traceModuleId: ev.attribution.packageId
      });
    }
  }
}

/**
 * Open or focus the singleton `TraceWindow`, optionally applying a `TraceFilter` or `TargetRef`.
 * @param {unknown} [filter]
 * @param {import('../../types/internal.d.ts').TraceWindowContext} [ctx]
 * @returns {Promise<TraceWindow>}
 */
export async function openTraceWindow(filter, ctx) {
  if (activeWindow) {
    if (filter !== undefined) activeWindow.applyFilter(filter);
    if (activeWindow.rendered) {
      activeWindow.bringToFront?.();
      return activeWindow;
    }
    await activeWindow.render({force: true});
    return activeWindow;
  }

  const win = new TraceWindow({
    ...(ctx ?? {}),
    ...(filter !== undefined ? {filter: normalizeFilter(filter)} : {})
  });
  await win.render({force: true});
  return win;
}
