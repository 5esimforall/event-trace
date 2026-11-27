// @ts-check
/**
 * Formatting helpers for timestamps, durations, diffs, attribution labels,
 * combat snapshots, and section headers.
 */

/** @type {Record<string, string>} */
const LOCALE_ALIASES = {cn: "zh-CN", zh: "zh-CN", "zh-Hans": "zh-CN"};

/**
 * Resolve a Foundry language code to a BCP 47 locale tag accepted by `Intl`.
 * @param {string} lang
 * @returns {string | undefined}
 */
export function localeFor(lang) {
  const candidate = LOCALE_ALIASES[lang] ?? lang;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(candidate).length ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** @param {number} value */
const pad = value => String(value).padStart(2, "0");

/**
 * Build a locale-aware clock formatter matching Foundry language codes.
 * @param {string} lang
 * @returns {import('../../types/internal.d.ts').TraceClock}
 */
export function createClock(lang) {
  const locale = localeFor(lang);
  const full = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const section = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  return {
    clock: ts => {
      const date = new Date(ts);
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    },
    clockSeconds: ts => {
      const date = new Date(ts);
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    },
    full: ts => full.format(new Date(ts)),
    section: ts => section.format(new Date(ts)),
    day: ts => {
      const date = new Date(ts);
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    },
    iso: ts => new Date(ts).toISOString()
  };
}

/**
 * Format a duration in milliseconds as a concise human-readable label.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format any sanitized diff value for text display.
 * @param {unknown} value
 * @param {(key: string, data?: Record<string, unknown>) => string} t
 * @returns {string}
 */
export function formatDiffValue(value, t) {
  if (value === undefined) return t("EVENTTRACE.Diff.Empty");
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Format a single `EventDiffEntry` with explicit indication when `before` was not cached.
 * @param {import('../../types/api.d.ts').EventDiffEntry} diff
 * @param {(key: string, data?: Record<string, unknown>) => string} t
 * @param {{ beforeCached?: boolean }} [options]
 * @returns {{ path: string, beforeText: string, afterText: string, line: string }}
 */
export function formatDiffEntry(diff, t, options = {}) {
  const beforeCached = options.beforeCached !== false;
  let beforeText;
  if (diff.op === "add") {
    beforeText = t("EVENTTRACE.Diff.None");
  } else if (diff.before === undefined) {
    beforeText = beforeCached && diff.op === "remove"
      ? t("EVENTTRACE.Diff.None")
      : t("EVENTTRACE.Diff.Uncached");
  } else {
    beforeText = formatDiffValue(diff.before, t);
  }

  const afterText = diff.op === "remove"
    ? t("EVENTTRACE.Diff.Removed")
    : formatDiffValue(diff.after, t);

  const line = diff.op === "add"
    ? `${diff.path}: + ${afterText}`
    : `${diff.path}: ${beforeText} → ${afterText}`;

  return {path: diff.path, beforeText, afterText, line};
}

/**
 * Format an `EventAttribution` into a concise localized source label.
 * @param {import('../../types/api.d.ts').EventAttribution | null | undefined} attr
 * @param {(key: string, data?: Record<string, unknown>) => string} t
 * @returns {string}
 */
export function formatAttributionLabel(attr, t) {
  if (!attr) return t("EVENTTRACE.Source.unknown");
  if (attr.sourceType === "module") return attr.packageId ?? attr.label;
  if (attr.sourceType === "system") {
    return `${t("EVENTTRACE.Source.system")} · ${attr.packageId ?? attr.label}`;
  }
  if (attr.sourceType === "user" && attr.label === "Macro") {
    return t("EVENTTRACE.Source.macro");
  }
  return t(`EVENTTRACE.Source.${attr.sourceType}`);
}

/**
 * Format a timeline section header for either a combat turn or a calendar/time break.
 * @param {import('../../types/internal.d.ts').TraceTimelineSection} section
 * @param {import('../../types/internal.d.ts').TraceClock} clock
 * @param {(key: string, data?: Record<string, unknown>) => string} t
 * @returns {string}
 */
export function formatSectionLabel(section, clock, t) {
  if (section.kind === "combat" && section.combat) {
    return t("EVENTTRACE.Section.Combat", {
      round: section.combat.round,
      turn: section.combat.turn + 1,
      name: section.combat.combatantName ?? t("EVENTTRACE.Diff.None")
    });
  }
  return clock.section(section.timestamp);
}

/**
 * Format an action group summary line with event count and source.
 * @param {import('../../types/api.d.ts').TraceActionGroup} group
 * @param {(key: string, data?: Record<string, unknown>) => string} t
 * @returns {string}
 */
export function formatGroupSummary(group, t) {
  return t("EVENTTRACE.Group.Summary", {
    title: group.title,
    count: group.events.length,
    source: formatAttributionLabel(group.attribution, t)
  });
}
