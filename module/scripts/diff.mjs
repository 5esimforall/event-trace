// @ts-check
/**
 * Pure object flattening, Foundry `-=` / `==` change key parsing, before/after pairing,
 * `_stats` noise suppression, and bounded value redaction/truncation.
 */
import {
  IGNORED_DIFF_PATHS,
  MAX_ARRAY_ITEMS,
  MAX_DIFFS,
  MAX_STRING_LENGTH
} from "./constants.mjs";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALWAYS_IGNORED = new Set(["_id", "flags.core.viewPosition"]);
const IGNORED_SET = new Set(IGNORED_DIFF_PATHS);
const INLINE_DATA_URI_RE = /data:[^;,\s"'<>]*;base64,[A-Za-z0-9+/=\s]+/gi;
const FULL_DATA_URI_RE = /^data:[^;,\s"'<>]*;base64,/i;

/**
 * Return whether a value is a plain key/value object (not Array, Date, null, or class instance).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Flatten nested plain objects into dot-separated leaf paths, matching Foundry `flattenObject` semantics.
 * @param {unknown} obj
 * @returns {Record<string, unknown>}
 */
export function flattenObject(obj) {
  /** @type {Record<string, unknown>} */
  const flat = {};
  if (!isPlainObject(obj)) return flat;

  /** @type {WeakSet<object>} */
  const seen = new WeakSet();

  /**
   * @param {Record<string, unknown>} current
   * @param {string} prefix
   */
  function walk(current, prefix) {
    if (seen.has(current)) return;
    seen.add(current);
    const keys = Object.keys(current);
    if (!keys.length) {
      if (prefix) flat[prefix] = {};
      return;
    }
    for (const key of keys) {
      if (UNSAFE_KEYS.has(key)) continue;
      const nextPath = prefix ? `${prefix}.${key}` : key;
      const val = current[key];
      if (isPlainObject(val)) {
        if (Object.keys(val).length === 0) flat[nextPath] = {};
        else walk(val, nextPath);
      } else {
        flat[nextPath] = val;
      }
    }
  }

  walk(obj, "");
  return flat;
}

/**
 * Read a dot-separated path safely from a plain source object.
 * @param {unknown} source
 * @param {string} path
 * @returns {unknown}
 */
export function getPathValue(source, path) {
  if (!source || typeof source !== "object" || !path) return undefined;
  const parts = String(path).split(".");
  /** @type {any} */
  let cursor = source;
  for (const part of parts) {
    if (UNSAFE_KEYS.has(part)) return undefined;
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Take a lightweight shallow snapshot of a source value so later mutations do not affect cached `before` state.
 * @param {unknown} value
 * @returns {unknown}
 */
export function snapshotValue(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice();
  if (isPlainObject(value)) return {...value};
  return String(value);
}

/**
 * Parse Foundry `-=key` removal and `==key` forced-replacement prefixes from a flattened path.
 * @param {string} rawPath
 * @returns {{ path: string, isRemove: boolean, forceSet: boolean }}
 */
export function parseChangePath(rawPath) {
  const segments = String(rawPath).split(".");
  let isRemove = false;
  let forceSet = false;
  const cleaned = segments.map((segment, index) => {
    if (segment.startsWith("-=") && (index === segments.length - 1 || index === 0)) {
      isRemove = true;
      return segment.slice(2);
    }
    if (segment.startsWith("==")) {
      forceSet = true;
      return segment.slice(2);
    }
    return segment;
  });
  return {
    path: cleaned.join("."),
    isRemove,
    forceSet
  };
}

/**
 * Collect shallow `before` values from a document source for all leaf paths touched by `changes`.
 * @param {unknown} source
 * @param {unknown} changes
 * @returns {Map<string, unknown>}
 */
export function collectBeforeValues(source, changes) {
  /** @type {Map<string, unknown>} */
  const beforeMap = new Map();
  if (!isPlainObject(changes)) return beforeMap;
  const flat = flattenObject(changes);
  for (const rawPath of Object.keys(flat)) {
    const {path} = parseChangePath(rawPath);
    if (!path || ALWAYS_IGNORED.has(path)) continue;
    beforeMap.set(path, snapshotValue(getPathValue(source, path)));
  }
  return beforeMap;
}

/**
 * Sanitize and truncate a single diff value for safe, bounded storage and display.
 * @param {unknown} value
 * @param {string} path
 * @param {{ maxStringLength?: number, maxArrayItems?: number }} [limits]
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function sanitizeDiffValue(value, path = "", limits = {}) {
  const maxStr = limits.maxStringLength ?? MAX_STRING_LENGTH;
  const maxArr = limits.maxArrayItems ?? MAX_ARRAY_ITEMS;

  if (value === undefined || value === null) return {value, truncated: false};

  if (typeof value === "string") {
    let text = value;
    let truncated = false;
    if (FULL_DATA_URI_RE.test(text)) {
      return {value: `[data-uri length=${text.length}]`, truncated: true};
    }
    if (INLINE_DATA_URI_RE.test(text)) {
      INLINE_DATA_URI_RE.lastIndex = 0;
      text = text.replace(INLINE_DATA_URI_RE, match => `[data-uri length=${match.length}]`);
      truncated = true;
    }
    if (text.length > maxStr) {
      text = `${text.slice(0, maxStr)}… (${value.length})`;
      truncated = true;
    }
    return {value: text, truncated};
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return {value, truncated: false};
  }

  if (Array.isArray(value)) {
    if (path === "_movementHistory" || path.endsWith("._movementHistory")) {
      return {value: `[waypoints: ${value.length}]`, truncated: value.length > 0};
    }
    if (value.length > maxArr) {
      return {value: `[array: ${value.length}]`, truncated: true};
    }
    let anyTruncated = false;
    const items = value.map(item => {
      const sanitized = sanitizeDiffValue(item, path, limits);
      if (sanitized.truncated) anyTruncated = true;
      return sanitized.value;
    });
    return {value: items, truncated: anyTruncated};
  }

  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json && json.length > maxStr) {
        return {value: `${json.slice(0, maxStr)}… (${json.length})`, truncated: true};
      }
      if (json) {
        const parsed = JSON.parse(json);
        return {value: parsed, truncated: false};
      }
    } catch {
      // Fall through to String fallback for circular/non-serializable objects.
    }
    return {value: String(value), truncated: true};
  }

  return {value: String(value), truncated: false};
}

/**
 * Determine whether a diff path belongs to Foundry `_stats` metadata.
 * @param {string} path
 * @returns {boolean}
 */
function isStatsPath(path) {
  return path === "_stats" || path.startsWith("_stats.");
}

/**
 * Compute normalized, bounded `EventDiffEntry` records from a Foundry document change object.
 * @param {unknown} changes
 * @param {Map<string, unknown> | null} [beforeMap]
 * @param {{ maxDiffs?: number, maxStringLength?: number, maxArrayItems?: number, mode?: "update" | "create" | "delete" }} [options]
 * @returns {import('../../types/internal.d.ts').DiffComputationResult}
 */
export function computeDiffs(changes, beforeMap = null, options = {}) {
  const maxDiffs = options.maxDiffs ?? MAX_DIFFS;
  const mode = options.mode ?? "update";
  const hasBeforeCache = beforeMap instanceof Map;

  if (!isPlainObject(changes)) {
    return {diffs: [], omittedDiffCount: 0, beforeCached: hasBeforeCache};
  }

  const flat = flattenObject(changes);
  /** @type {Array<{ path: string, op: import('../../types/api.d.ts').EventDiffOp, rawAfter: unknown, forceSet: boolean }>} */
  const nonStats = [];
  /** @type {Array<{ path: string, op: import('../../types/api.d.ts').EventDiffOp, rawAfter: unknown, forceSet: boolean }>} */
  const statsOnly = [];

  for (const [rawPath, rawValue] of Object.entries(flat)) {
    const {path, isRemove, forceSet} = parseChangePath(rawPath);
    if (!path || ALWAYS_IGNORED.has(path)) continue;
    /** @type {import('../../types/api.d.ts').EventDiffOp} */
    const op = mode === "delete"
      ? "remove"
      : (mode === "create" ? "add" : (isRemove ? "remove" : "set"));
    const targetList = isStatsPath(path) ? statsOnly : nonStats;
    targetList.push({path, op, rawAfter: rawValue, forceSet});
  }

  // Suppress `_stats` noise whenever real document fields changed; keep `_stats` only if nothing else changed.
  const selected = nonStats.length > 0
    ? nonStats.filter(item => !IGNORED_SET.has(item.path))
    : statsOnly;

  /** @type {import('../../types/api.d.ts').EventDiffEntry[]} */
  const entries = [];
  for (const item of selected) {
    let op = item.op;
    let rawBefore;
    if (mode === "delete") {
      rawBefore = item.rawAfter;
    } else if (hasBeforeCache) {
      rawBefore = beforeMap.get(item.path);
      if (op === "set" && !item.forceSet && (!beforeMap.has(item.path) || rawBefore === undefined)) {
        op = "add";
      }
    }

    const beforeSanitized = sanitizeDiffValue(rawBefore, item.path, options);
    const afterRaw = op === "remove" ? undefined : item.rawAfter;
    const afterSanitized = sanitizeDiffValue(afterRaw, item.path, options);

    /** @type {import('../../types/api.d.ts').EventDiffEntry} */
    const entry = {
      path: item.path,
      op,
      before: beforeSanitized.value,
      after: afterSanitized.value
    };
    if (beforeSanitized.truncated || afterSanitized.truncated) {
      entry.truncated = true;
    }
    entries.push(entry);
  }

  if (entries.length > maxDiffs) {
    return {
      diffs: entries.slice(0, maxDiffs),
      omittedDiffCount: entries.length - maxDiffs,
      beforeCached: hasBeforeCache
    };
  }
  return {diffs: entries, omittedDiffCount: 0, beforeCached: hasBeforeCache};
}
