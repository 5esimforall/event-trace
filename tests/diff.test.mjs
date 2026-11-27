import test from "node:test";
import assert from "node:assert/strict";
import {
  collectBeforeValues,
  computeDiffs,
  flattenObject,
  parseChangePath,
  sanitizeDiffValue
} from "../module/scripts/diff.mjs";

test("flattenObject flattens nested plain objects and preserves arrays and empty objects", () => {
  const input = {
    name: "Goblin",
    system: {
      attributes: {hp: {value: 7, max: 7}},
      traits: ["darkvision"]
    },
    flags: {empty: {}}
  };
  assert.deepEqual(flattenObject(input), {
    name: "Goblin",
    "system.attributes.hp.value": 7,
    "system.attributes.hp.max": 7,
    "system.traits": ["darkvision"],
    "flags.empty": {}
  });
});

test("parseChangePath handles Foundry -= remove and == forced set prefixes", () => {
  assert.deepEqual(parseChangePath("system.abilities.-=str"), {
    path: "system.abilities.str",
    isRemove: true,
    forceSet: false
  });
  assert.deepEqual(parseChangePath("flags.myMod.==data.score"), {
    path: "flags.myMod.data.score",
    isRemove: false,
    forceSet: true
  });
  assert.deepEqual(parseChangePath("-=flags.oldFlag"), {
    path: "flags.oldFlag",
    isRemove: true,
    forceSet: false
  });
});

test("computeDiffs pairs cached before values and distinguishes set, add, remove, and uncached before", () => {
  const source = {
    name: "Hero",
    system: {hp: {value: 20}, notes: "old note"}
  };
  const changes = {
    _id: "actor-1",
    "system.hp.value": 12,
    "system.hp.temp": 5,
    "system.-=notes": null,
    "flags.==mod": {ready: true}
  };
  const beforeMap = collectBeforeValues(source, changes);
  const res = computeDiffs(changes, beforeMap);
  assert.equal(res.beforeCached, true);
  assert.equal(res.omittedDiffCount, 0);

  const byPath = Object.fromEntries(res.diffs.map(d => [d.path, d]));
  assert.equal(byPath._id, undefined);
  assert.deepEqual(byPath["system.hp.value"], {path: "system.hp.value", op: "set", before: 20, after: 12});
  assert.deepEqual(byPath["system.hp.temp"], {path: "system.hp.temp", op: "add", before: undefined, after: 5});
  assert.deepEqual(byPath["system.notes"], {path: "system.notes", op: "remove", before: "old note", after: undefined});
  assert.deepEqual(byPath["flags.mod.ready"], {path: "flags.mod.ready", op: "set", before: undefined, after: true});

  // Without cached beforeMap, regular changes keep op "set" with before === undefined and beforeCached: false.
  const uncached = computeDiffs({"system.hp.value": 8}, null);
  assert.equal(uncached.beforeCached, false);
  assert.deepEqual(uncached.diffs, [{path: "system.hp.value", op: "set", before: undefined, after: 8}]);
});

test("computeDiffs suppresses _stats noise unless only _stats changed", () => {
  const withRealChange = computeDiffs({
    _id: "1",
    name: "Orc",
    _stats: {modifiedTime: 1000, lastModifiedBy: "gm", systemVersion: "5.2.5"}
  });
  assert.equal(withRealChange.diffs.length, 1);
  assert.equal(withRealChange.diffs[0].path, "name");

  const statsOnly = computeDiffs({
    _id: "1",
    _stats: {modifiedTime: 2000, lastModifiedBy: "gm"}
  });
  assert.equal(statsOnly.diffs.length, 2);
  assert.equal(statsOnly.diffs[0].path, "_stats.modifiedTime");
  assert.equal(statsOnly.diffs[1].path, "_stats.lastModifiedBy");
});

test("sanitizeDiffValue compresses _movementHistory, summarizes arrays > 12, truncates strings > 200, and redacts data URIs", () => {
  const move = sanitizeDiffValue([{x: 0, y: 0}, {x: 100, y: 100}, {x: 200, y: 100}], "_movementHistory");
  assert.deepEqual(move, {value: "[waypoints: 3]", truncated: true});

  const bigArr = sanitizeDiffValue(Array.from({length: 15}, (_, i) => i), "system.items");
  assert.deepEqual(bigArr, {value: "[array: 15]", truncated: true});

  const longText = "a".repeat(250);
  const truncStr = sanitizeDiffValue(longText, "system.bio");
  assert.equal(truncStr.truncated, true);
  assert.ok(String(truncStr.value).startsWith("a".repeat(200)));
  assert.match(String(truncStr.value), /… \(250\)/);

  const uri = "data:image/png;base64," + "A".repeat(400);
  const redacted = sanitizeDiffValue(uri, "img");
  assert.deepEqual(redacted, {value: `[data-uri length=${uri.length}]`, truncated: true});

  const inlineUriHtml = `<img src="${uri}">`;
  const inlineRedacted = sanitizeDiffValue(inlineUriHtml, "content");
  assert.equal(inlineRedacted.truncated, true);
  assert.ok(!String(inlineRedacted.value).includes("A".repeat(50)));
  assert.match(String(inlineRedacted.value), /\[data-uri length=/);
});

test("computeDiffs caps diffs at 24 entries and records omittedDiffCount", () => {
  const changes = {};
  for (let i = 0; i < 30; i++) {
    changes[`system.field${i}`] = i;
  }
  const res = computeDiffs(changes);
  assert.equal(res.diffs.length, 24);
  assert.equal(res.omittedDiffCount, 6);
  assert.equal(res.diffs[0].path, "system.field0");
  assert.equal(res.diffs[23].path, "system.field23");
});
