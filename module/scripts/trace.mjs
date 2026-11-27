// @ts-check
/**
 * Pure domain helpers for visibility gating, filter/TargetRef normalization,
 * notification signatures, action grouping, timeline sectioning, and multi-facet filtering.
 */
import {
  EVENT_KINDS,
  RESTRICTED_SETTING_KEYS,
  SECTION_GAP_MS
} from "./constants.mjs";

const CONCEALED_CHAT_PATHS = new Set(["content", "flavor", "rolls"]);

/**
 * Determine whether a diff path reveals protected ChatMessage content or rolls.
 * @param {string} path
 * @returns {boolean}
 */
function isConcealedChatPath(path) {
  if (CONCEALED_CHAT_PATHS.has(path)) return true;
  return path.startsWith("content.") || path.startsWith("flavor.") || path.startsWith("rolls.");
}

/**
 * Resolve token visibility for non-GM users, covering both `hidden` and `isSecret`.
 * @param {import('../../types/internal.d.ts').FoundryDocumentLike | null | undefined} tokenDoc
 * @param {boolean} isGM
 * @returns {boolean}
 */
function isTokenVisibleToUser(tokenDoc, isGM) {
  if (!tokenDoc) return true;
  if (tokenDoc.visible === false) return false;
  if (isGM) return true;
  if (tokenDoc.hidden && !tokenDoc.isOwner) return false;
  if (tokenDoc.isSecret) return false;
  return true;
}

/**
 * Enforce Foundry V13 document visibility rules for the active user before recording or exporting.
 * @param {import('../../types/internal.d.ts').FoundryDocumentLike | null | undefined} doc
 * @param {{
 *   isGM?: boolean,
 *   userId?: string | null,
 *   documentName?: string | null,
 *   settingConfig?: { scope?: string, config?: boolean, restricted?: boolean } | null
 * }} [options]
 * @returns {import('../../types/internal.d.ts').VisibilityCheckResult}
 */
export function checkDocumentVisibility(doc, options = {}) {
  if (!doc) return {visible: false, concealContent: false, reason: "missing"};
  const isGM = Boolean(options.isGM);
  const userId = options.userId ?? null;
  const docName = options.documentName ?? doc.documentName ?? doc.constructor?.name ?? "";

  if (docName === "ChatMessage") {
    if (doc.visible === false) {
      return {visible: false, concealContent: false, reason: "messageHidden"};
    }
    if (doc.isContentVisible === false) {
      return {visible: true, concealContent: true, reason: "contentConcealed"};
    }
    return {visible: true, concealContent: false};
  }

  if (docName === "Token" || docName === "TokenDocument") {
    if (!isTokenVisibleToUser(doc, isGM)) {
      return {
        visible: false,
        concealContent: false,
        reason: doc.isSecret ? "secretToken" : "hiddenToken"
      };
    }
    return {visible: true, concealContent: false};
  }

  if (docName === "Combatant") {
    if (!isGM) {
      if (doc.visible === false || (doc.hidden && !doc.isOwner)) {
        return {visible: false, concealContent: false, reason: "hiddenCombatant"};
      }
      if (doc.token && !isTokenVisibleToUser(doc.token, isGM)) {
        return {visible: false, concealContent: false, reason: "hiddenCombatantToken"};
      }
    }
    return {visible: true, concealContent: false};
  }

  if (docName === "Setting") {
    if (isGM) return {visible: true, concealContent: false};
    const key = String(doc.key ?? "");
    const settingUser = typeof doc.user === "string"
      ? doc.user
      : (doc.user?.id ?? (typeof doc._source?.user === "string" ? doc._source.user : null));
    if (settingUser && userId && settingUser !== userId) {
      return {visible: false, concealContent: false, reason: "otherUserSetting"};
    }
    if (RESTRICTED_SETTING_KEYS.has(key)) {
      return {visible: false, concealContent: false, reason: "restrictedSetting"};
    }
    const cfg = options.settingConfig ?? null;
    if (cfg?.restricted) {
      return {visible: false, concealContent: false, reason: "restrictedSetting"};
    }
    if (cfg?.scope === "user" && (!userId || settingUser !== userId)) {
      return {visible: false, concealContent: false, reason: "otherUserSetting"};
    }
    if (cfg?.scope === "world" && cfg?.config === false) {
      return {visible: false, concealContent: false, reason: "internalWorldSetting"};
    }
    return {visible: true, concealContent: false};
  }

  if (doc.visible === false) {
    return {visible: false, concealContent: false, reason: "documentHidden"};
  }

  if (!isGM) {
    // Walk ancestors (e.g. Item/ActiveEffect -> synthetic Actor -> TokenDocument) so hidden tokens never leak.
    let cursor = doc.parent ?? doc.actor ?? null;
    const visited = new Set([doc]);
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      if (cursor.visible === false) {
        return {visible: false, concealContent: false, reason: "hiddenAncestor"};
      }
      if (cursor.documentName === "Token" || cursor.documentName === "TokenDocument" || "isSecret" in cursor) {
        if (!isTokenVisibleToUser(cursor, isGM)) {
          return {visible: false, concealContent: false, reason: "hiddenTokenChild"};
        }
      }
      cursor = cursor.parent ?? cursor.actor ?? null;
    }
  }

  return {visible: true, concealContent: false};
}

/**
 * Strip protected content, flavor, and roll numeric values from a concealed ChatMessage event.
 * @param {import('../../types/api.d.ts').TraceEventRecord} record
 * @returns {import('../../types/api.d.ts').TraceEventRecord}
 */
export function sanitizeConcealedRecord(record) {
  if (!record.concealed) return record;
  const detail = {...record.detail};
  if (Array.isArray(detail.diffs)) {
    detail.diffs = detail.diffs.filter(diff => !isConcealedChatPath(String(diff?.path ?? "")));
  }
  if ("rollCount" in detail) detail.rollCount = 0;
  if ("text" in detail) detail.text = "";
  if ("content" in detail) delete detail.content;
  if ("flavor" in detail) delete detail.flavor;
  return {
    ...record,
    summary: `ChatMessage · [concealed]`,
    detail
  };
}

/**
 * Read a non-empty trimmed string or return `undefined`.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalize either a `TraceFilter` or a cross-module `TargetRef` into a clean `TraceFilter`.
 * @param {unknown} raw
 * @returns {import('../../types/api.d.ts').TraceFilter}
 */
export function normalizeFilter(raw) {
  if (!raw || typeof raw !== "object") return {};
  const input = /** @type {Record<string, unknown>} */ (raw);
  /** @type {import('../../types/api.d.ts').TraceFilter} */
  const filter = {};

  if (typeof input.type === "string") {
    switch (input.type) {
      case "document":
      case "visibility": {
        const uuid = nonEmptyString(input.uuid);
        if (uuid) filter.uuid = uuid;
        break;
      }
      case "message": {
        const messageId = nonEmptyString(input.messageId);
        if (messageId) filter.messageId = messageId;
        break;
      }
      case "module": {
        const moduleId = nonEmptyString(input.moduleId);
        if (moduleId) filter.moduleId = moduleId;
        break;
      }
      case "hook": {
        const hookName = nonEmptyString(input.hookName);
        if (hookName) filter.query = hookName;
        break;
      }
      case "actorField": {
        const uuid = nonEmptyString(input.uuid);
        const path = nonEmptyString(input.path);
        if (uuid) filter.uuid = uuid;
        if (path) filter.query = path;
        break;
      }
    }
    return filter;
  }

  if (typeof input.kind === "string" && EVENT_KINDS.includes(/** @type {any} */ (input.kind))) {
    filter.kind = /** @type {import('../../types/api.d.ts').EventKind} */ (input.kind);
  }
  const uuid = nonEmptyString(input.uuid);
  if (uuid) filter.uuid = uuid;
  const messageId = nonEmptyString(input.messageId);
  if (messageId) filter.messageId = messageId;
  const moduleId = nonEmptyString(input.moduleId);
  if (moduleId) filter.moduleId = moduleId;
  const query = nonEmptyString(input.query);
  if (query) filter.query = query;

  return filter;
}

/**
 * Build a stable deduplication signature for non-progress notifications.
 * @param {string} level
 * @param {string} text
 * @returns {string}
 */
export function notificationSignature(level, text) {
  const normalizedLevel = String(level || "info").toLowerCase();
  const normalizedText = String(text ?? "").replace(/\s+/g, " ").trim();
  return `${normalizedLevel}\n${normalizedText}`;
}

/**
 * Snapshot active combat state if combat has started (or round > 0) and is visible.
 * @param {{ combat?: any, combats?: { active?: any } } | null | undefined} gameLike
 * @param {{ isGM?: boolean }} [options]
 * @returns {import('../../types/api.d.ts').TraceCombatSnapshot | null}
 */
export function computeCombatSnapshot(gameLike, options = {}) {
  const combat = gameLike?.combat ?? gameLike?.combats?.active ?? null;
  if (!combat) return null;
  if (combat.visible === false) return null;
  const round = Number(combat.round ?? 0);
  if (!combat.started && !(round > 0)) return null;

  const turn = Number(combat.turn ?? 0);
  const activeCombatant = combat.combatant ?? combat.turns?.[turn] ?? null;
  let combatantName = null;
  if (activeCombatant && (options.isGM || activeCombatant.visible !== false)) {
    combatantName = activeCombatant.name ? String(activeCombatant.name) : null;
  }

  return {
    combatId: String(combat.id ?? ""),
    round,
    turn,
    combatantName
  };
}

/**
 * Extract primary document/message identifiers from an event for time-window affinity checks.
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @returns {string[]}
 */
function primaryTargets(event) {
  /** @type {string[]} */
  const ids = [];
  const d = event.detail ?? {};
  const t = event.target;
  if (t && "uuid" in t && typeof t.uuid === "string" && t.uuid) ids.push(t.uuid);
  if (t && "messageId" in t && typeof t.messageId === "string" && t.messageId) ids.push(`msg:${t.messageId}`);
  for (const key of ["uuid", "parentUuid", "actorUuid", "tokenUuid"]) {
    if (typeof d[key] === "string" && d[key]) ids.push(String(d[key]));
  }
  if (typeof d.messageId === "string" && d.messageId) ids.push(`msg:${d.messageId}`);
  return ids;
}

/**
 * Determine whether two document events outside a sync stack belong to the same time-window action group.
 * @param {import('../../types/api.d.ts').TraceEventRecord | null | undefined} prevEvent
 * @param {import('../../types/api.d.ts').TraceEventRecord} nextEvent
 * @param {number} windowMs
 * @returns {boolean}
 */
export function shouldGroupByTimeWindow(prevEvent, nextEvent, windowMs) {
  if (!prevEvent || windowMs <= 0) return false;
  if (prevEvent.kind !== "document" || nextEvent.kind !== "document") return false;
  const delta = nextEvent.timestamp - prevEvent.timestamp;
  if (delta < 0 || delta > windowMs) return false;

  if (!prevEvent.user?.id || prevEvent.user.id !== nextEvent.user?.id) return false;
  if (prevEvent.user.remote || nextEvent.user.remote) return false;

  const prevPkg = prevEvent.attribution?.packageId;
  const nextPkg = nextEvent.attribution?.packageId;
  if (prevPkg && nextPkg && prevPkg === nextPkg) return true;

  const prevSrc = prevEvent.attribution?.sourceType;
  const nextSrc = nextEvent.attribution?.sourceType;
  const prevIsLocalUser = prevSrc === "user" || prevSrc === "core";
  const nextIsLocalUser = nextSrc === "user" || nextSrc === "core";
  if (prevIsLocalUser || nextIsLocalUser) return true;

  const prevTargets = new Set(primaryTargets(prevEvent));
  return primaryTargets(nextEvent).some(id => prevTargets.has(id));
}

/**
 * Pick the representative attribution for an action group.
 * @param {import('../../types/api.d.ts').TraceEventRecord[]} events
 * @returns {import('../../types/api.d.ts').EventAttribution}
 */
function pickGroupAttribution(events) {
  for (const event of events) {
    if (event.attribution?.sourceType === "module" || event.attribution?.sourceType === "system") {
      return event.attribution;
    }
  }
  for (const event of events) {
    if (event.attribution?.sourceType !== "unknown") return event.attribution;
  }
  return events[0].attribution;
}

/**
 * Build a concise plain summary title for an action group.
 * @param {import('../../types/api.d.ts').TraceEventRecord[]} events
 * @returns {string}
 */
export function summarizeActionGroup(events) {
  if (!events.length) return "";
  if (events.length === 1) return events[0].summary;
  const first = events[0];
  const docNames = [];
  const seen = new Set();
  for (const event of events) {
    const label = typeof event.detail?.name === "string" && event.detail.name
      ? event.detail.name
      : (typeof event.detail?.documentName === "string" ? event.detail.documentName : event.kind);
    if (!seen.has(label)) {
      seen.add(label);
      docNames.push(label);
    }
    if (docNames.length >= 2) break;
  }
  const head = docNames.join(" · ") || first.summary;
  return `${head} (${events.length})`;
}

/**
 * Group an ordered list of events by `actionId` while preserving chronological order.
 * @param {import('../../types/api.d.ts').TraceEventRecord[]} events
 * @returns {import('../../types/api.d.ts').TraceActionGroup[]}
 */
export function groupEvents(events) {
  /** @type {import('../../types/api.d.ts').TraceActionGroup[]} */
  const groups = [];
  /** @type {Map<string, import('../../types/api.d.ts').TraceActionGroup>} */
  const byId = new Map();

  for (const event of events) {
    const actionId = event.actionId || event.id;
    let group = byId.get(actionId);
    if (!group) {
      group = {
        id: actionId,
        title: event.summary,
        attribution: event.attribution,
        events: []
      };
      byId.set(actionId, group);
      groups.push(group);
    }
    group.events.push(event);
  }

  for (const group of groups) {
    group.attribution = pickGroupAttribution(group.events);
    group.title = summarizeActionGroup(group.events);
  }
  return groups;
}

/**
 * Local calendar day key `YYYY-MM-DD` for section break detection.
 * @param {number} ts
 * @returns {string}
 */
function calendarDayKey(ts) {
  const date = new Date(ts);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Check whether two combat snapshots represent the same combat encounter, round, and turn.
 * @param {import('../../types/api.d.ts').TraceCombatSnapshot | null} a
 * @param {import('../../types/api.d.ts').TraceCombatSnapshot | null} b
 * @returns {boolean}
 */
function sameCombatTurn(a, b) {
  if (!a || !b) return false;
  return a.combatId === b.combatId && a.round === b.round && a.turn === b.turn;
}

/**
 * Partition action groups into combat turn/round and date/5-minute-gap timeline sections.
 * @param {import('../../types/api.d.ts').TraceActionGroup[]} groups
 * @param {number} [sectionGapMs]
 * @returns {import('../../types/internal.d.ts').TraceTimelineSection[]}
 */
export function buildTimelineSections(groups, sectionGapMs = SECTION_GAP_MS) {
  /** @type {import('../../types/internal.d.ts').TraceTimelineSection[]} */
  const sections = [];
  /** @type {import('../../types/internal.d.ts').TraceTimelineSection | null} */
  let current = null;
  /** @type {import('../../types/api.d.ts').TraceCombatSnapshot | null} */
  let prevCombat = null;
  /** @type {number | null} */
  let prevTimestamp = null;
  /** @type {string | null} */
  let prevDay = null;
  let seq = 0;

  for (const group of groups) {
    const first = group.events[0];
    if (!first) continue;
    const ts = first.timestamp;
    const combat = first.combat ?? null;
    const day = calendarDayKey(ts);
    const gapMs = prevTimestamp === null ? 0 : Math.max(0, ts - prevTimestamp);
    const dayChanged = prevDay !== null && day !== prevDay;

    let startCombatSection = false;
    let startTimeSection = false;

    if (combat !== null) {
      if (!sameCombatTurn(prevCombat, combat)) {
        startCombatSection = true;
      } else if (dayChanged || gapMs >= sectionGapMs) {
        startTimeSection = true;
      }
    } else if (!current || prevCombat !== null || dayChanged || gapMs >= sectionGapMs) {
      startTimeSection = true;
    }

    if (startCombatSection) {
      current = {
        id: `sec-${++seq}`,
        kind: "combat",
        timestamp: ts,
        combat,
        dayChanged,
        gapMs,
        groups: []
      };
      sections.push(current);
    } else if (startTimeSection) {
      current = {
        id: `sec-${++seq}`,
        kind: "time",
        timestamp: ts,
        combat: null,
        dayChanged,
        gapMs,
        groups: []
      };
      sections.push(current);
    }

    current?.groups.push(group);
    prevCombat = combat;
    prevTimestamp = ts;
    prevDay = day;
  }

  return sections;
}

/**
 * Build searchable lowercase text for keyword filtering without exposing concealed data.
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @returns {string}
 */
export function eventSearchHaystack(event) {
  const d = event.detail ?? {};
  const parts = [
    event.summary,
    event.kind,
    event.user?.name,
    event.attribution?.sourceType,
    event.attribution?.packageId,
    event.attribution?.label,
    event.attribution?.hookName,
    event.attribution?.fnName,
    typeof d.documentName === "string" ? d.documentName : "",
    typeof d.name === "string" ? d.name : "",
    typeof d.uuid === "string" ? d.uuid : "",
    typeof d.key === "string" ? d.key : "",
    typeof d.hookName === "string" ? d.hookName : "",
    typeof d.targetName === "string" ? d.targetName : "",
    typeof d.targetUuid === "string" ? d.targetUuid : "",
    typeof d.message === "string" ? d.message : "",
    typeof d.location === "string" ? d.location : "",
    typeof d.contextHook === "string" ? d.contextHook : "",
    event.concealed ? "" : (typeof d.text === "string" ? d.text : "")
  ];

  if (Array.isArray(d.diffs)) {
    for (const diff of d.diffs) {
      if (diff?.path) parts.push(String(diff.path));
      if (!event.concealed) {
        if (typeof diff?.before === "string") parts.push(diff.before);
        if (typeof diff?.after === "string") parts.push(diff.after);
      }
    }
  }
  if (Array.isArray(d.stackLines)) {
    for (const line of d.stackLines) parts.push(String(line));
  }

  return parts.filter(Boolean).join("\n").toLowerCase();
}

/**
 * Check whether an event matches a `TraceFilter` (or `TargetRef`).
 * @param {import('../../types/api.d.ts').TraceEventRecord} event
 * @param {import('../../types/api.d.ts').TraceFilter} [rawFilter]
 * @returns {boolean}
 */
export function matchesFilter(event, rawFilter) {
  const filter = normalizeFilter(rawFilter);
  if (filter.kind && event.kind !== filter.kind) return false;

  if (filter.uuid) {
    const u = filter.uuid;
    const d = event.detail ?? {};
    const t = event.target;
    const targetUuid = t && "uuid" in t ? t.uuid : undefined;
    const matchesUuid = targetUuid === u
      || d.uuid === u
      || d.parentUuid === u
      || d.actorUuid === u
      || d.tokenUuid === u
      || d.targetUuid === u
      || d.contextUuid === u;
    if (!matchesUuid) return false;
  }

  if (filter.messageId) {
    const id = filter.messageId;
    const d = event.detail ?? {};
    const t = event.target;
    const targetMsgId = t && "messageId" in t ? t.messageId : undefined;
    const matchesMsg = targetMsgId === id
      || d.messageId === id
      || (d.documentName === "ChatMessage" && d.documentId === id);
    if (!matchesMsg) return false;
  }

  if (filter.moduleId) {
    const mod = filter.moduleId;
    const t = event.target;
    const targetMod = t && "moduleId" in t ? t.moduleId : undefined;
    if (event.attribution?.packageId !== mod && targetMod !== mod) return false;
  }

  if (filter.query) {
    const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) {
      const haystack = eventSearchHaystack(event);
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
  }

  return true;
}

/**
 * Filter events using a normalized `TraceFilter` or `TargetRef`.
 * @param {import('../../types/api.d.ts').TraceEventRecord[]} events
 * @param {import('../../types/api.d.ts').TraceFilter} [filter]
 * @returns {import('../../types/api.d.ts').TraceEventRecord[]}
 */
export function filterEvents(events, filter) {
  const normalized = normalizeFilter(filter);
  if (!normalized.kind && !normalized.uuid && !normalized.messageId && !normalized.moduleId && !normalized.query) {
    return events.slice();
  }
  return events.filter(event => matchesFilter(event, normalized));
}

/**
 * Compute per-kind facet counts under all active filter constraints except `kind`.
 * @param {import('../../types/api.d.ts').TraceEventRecord[]} events
 * @param {import('../../types/api.d.ts').TraceFilter} [filter]
 * @returns {{ all: number } & Record<import('../../types/api.d.ts').EventKind, number>}
 */
export function countFilterKinds(events, filter) {
  const normalized = normalizeFilter(filter);
  const baseFilter = {...normalized};
  delete baseFilter.kind;
  const scoped = filterEvents(events, baseFilter);
  /** @type {{ all: number, document: number, notification: number, interception: number, error: number }} */
  const counts = {
    all: scoped.length,
    document: 0,
    notification: 0,
    interception: 0,
    error: 0
  };
  for (const event of scoped) {
    if (event.kind in counts) counts[event.kind] += 1;
  }
  return counts;
}
