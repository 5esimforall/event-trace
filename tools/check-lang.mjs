import {readFileSync, readdirSync} from "node:fs";
import {
  DOCUMENT_ACTIONS,
  ERROR_ORIGINS,
  EVENT_KINDS,
  FILTER_KINDS,
  NOTIFICATION_LEVELS,
  SOURCE_TYPES
} from "../module/scripts/constants.mjs";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const scripts = new URL("module/scripts/", root);

// Keys built from a prefix and a domain value, e.g. `EVENTTRACE.Kind.${record.kind}`.
const DYNAMIC = {
  "EVENTTRACE.Kind.": EVENT_KINDS,
  "EVENTTRACE.Filter.": FILTER_KINDS,
  "EVENTTRACE.Source.": [...SOURCE_TYPES, "macro"],
  "EVENTTRACE.NotificationLevel.": NOTIFICATION_LEVELS,
  "EVENTTRACE.DocumentAction.": DOCUMENT_ACTIONS,
  "EVENTTRACE.ErrorOrigin.": ERROR_ORIGINS
};

const keys = new Set();
for (const file of readdirSync(scripts).filter(file => file.endsWith(".mjs"))) {
  const source = readFileSync(new URL(file, scripts), "utf8");
  for (const [key] of source.matchAll(/\bEVENTTRACE\.[A-Za-z0-9_.]+/g)) {
    if (!key.endsWith(".")) keys.add(key);
    else if (DYNAMIC[key]) for (const value of DYNAMIC[key]) keys.add(`${key}${value}`);
    else {
      console.error(`Unregistered dynamic key prefix: ${key}`);
      process.exitCode = 1;
    }
  }
}

const en = read("module/lang/en.json");
const cn = read("module/lang/cn.json");
const issues = {
  "Missing en": [...keys].filter(key => !Object.hasOwn(en, key)),
  "Missing cn": [...keys].filter(key => !Object.hasOwn(cn, key)),
  "Unused": Object.keys(en).filter(key => !keys.has(key)),
  enOnly: Object.keys(en).filter(key => !Object.hasOwn(cn, key)),
  cnOnly: Object.keys(cn).filter(key => !Object.hasOwn(en, key))
};
for (const [kind, list] of Object.entries(issues)) {
  if (!list.length) continue;
  console.error(`${kind} keys: ${list.join(", ")}`);
  process.exitCode = 1;
}
if (!process.exitCode) {
  console.log(`Localization OK: ${keys.size} used keys, ${Object.keys(en).length} en / ${Object.keys(cn).length} cn entries`);
}
