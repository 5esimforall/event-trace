// @ts-check
/**
 * Shared constants and bounded thresholds for Event Trace.
 */

export const MODULE_ID = "event-trace";
export const MODULE_VERSION = "0.1.0";
export const LOCALE_PREFIX = "EVENTTRACE.";
export const SCHEMA_VERSION = 1;

/** @type {readonly import('../../types/api.d.ts').EventKind[]} */
export const EVENT_KINDS = Object.freeze(["document", "notification", "interception", "error"]);

/** @type {readonly ("all" | import('../../types/api.d.ts').EventKind)[]} */
export const FILTER_KINDS = Object.freeze(["all", ...EVENT_KINDS]);

/** @type {readonly import('../../types/internal.d.ts').DocumentAction[]} */
export const DOCUMENT_ACTIONS = Object.freeze(["create", "update", "delete"]);

/** @type {readonly import('../../types/internal.d.ts').NotificationLevel[]} */
export const NOTIFICATION_LEVELS = Object.freeze(["info", "warning", "error", "success"]);

/** @type {readonly import('../../types/internal.d.ts').ErrorOrigin[]} */
export const ERROR_ORIGINS = Object.freeze(["hooks", "window-error", "unhandledrejection"]);

/** @type {readonly import('../../types/api.d.ts').EventAttributionSourceType[]} */
export const SOURCE_TYPES = Object.freeze(["module", "system", "core", "user", "unknown"]);

export const SETTINGS = Object.freeze({
  MAX_EVENTS: "maxEvents",
  ACTION_WINDOW_MS: "actionWindowMs",
  CAPTURE_SETTINGS: "captureSettings",
  NOTIFY_ON_INTERCEPTION: "notifyOnInterception"
});

export const DEFAULT_MAX_EVENTS = 500;
export const MIN_MAX_EVENTS = 200;
export const MAX_MAX_EVENTS = 2000;

export const DEFAULT_ACTION_WINDOW_MS = 250;
export const MIN_ACTION_WINDOW_MS = 0;
export const MAX_ACTION_WINDOW_MS = 1000;

export const SECTION_GAP_MS = 300_000;
export const MAX_DIFFS = 24;
export const MAX_STRING_LENGTH = 200;
export const MAX_ARRAY_ITEMS = 12;
export const PENDING_BEFORE_TTL_MS = 10_000;
export const WINDOW_REFRESH_THROTTLE_MS = 100;

/** Core hooks (besides `pre[A-Z]*` and `paste[A-Z]*`) where returning `false` cancels execution. */
export const CANCELABLE_HOOKS = new Set([
  "hotbarDrop",
  "chatInput",
  "chatMessage",
  "activateNote",
  "dropCanvasData",
  "dropActorSheetData",
  "dropRollTableSheetData",
  "modifyTokenAttribute",
  "hotReload",
  "configureCanvasEnvironment",
  "chatBubbleHTML",
  "dealCards",
  "passCards",
  "returnCards"
]);

/**
 * Determine whether a Foundry hook name is synchronously cancelable by returning `false`.
 * @param {string} hookName
 * @returns {boolean}
 */
export function isCancelableHook(hookName) {
  if (typeof hookName !== "string" || !hookName) return false;
  return /^pre[A-Z]/.test(hookName) || /^paste[A-Z]/.test(hookName) || CANCELABLE_HOOKS.has(hookName);
}

/** Key documents observed in the timeline; `ActorDelta` is excluded because synthetic Actor updates mirror it. */
export const WATCHED_DOCUMENTS = Object.freeze([
  "Actor",
  "Item",
  "ActiveEffect",
  "Token",
  "Scene",
  "Combat",
  "Combatant",
  "ChatMessage",
  "Setting"
]);

/** Technical or redundant diff paths suppressed unless nothing else changed. */
export const IGNORED_DIFF_PATHS = Object.freeze([
  "_id",
  "flags.core.viewPosition",
  "_stats.compendiumSource",
  "_stats.duplicateSource",
  "_stats.exportSource",
  "_stats.coreVersion",
  "_stats.systemId",
  "_stats.systemVersion",
  "_stats.createdTime",
  "_stats.modifiedTime",
  "_stats.lastModifiedBy"
]);

/** Known GM-restricted world setting keys hidden from non-GM users. */
export const RESTRICTED_SETTING_KEYS = new Set([
  "core.moduleConfiguration",
  "core.permissions",
  "core.userConfiguration",
  "core.compendiumConfiguration",
  "core.combatTrackerConfig"
]);

/**
 * Clamp a numeric setting within inclusive bounds, falling back on invalid inputs.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}
