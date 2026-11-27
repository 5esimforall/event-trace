import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTimelineSections,
  checkDocumentVisibility,
  computeCombatSnapshot,
  countFilterKinds,
  filterEvents,
  groupEvents,
  normalizeFilter,
  notificationSignature,
  sanitizeConcealedRecord
} from "../module/scripts/trace.mjs";
import {TraceStore} from "../module/scripts/store.mjs";
import {formatDiffEntry} from "../module/scripts/format.mjs";

test("checkDocumentVisibility enforces GM vs player gates on TokenDocument, Combatant, ChatMessage, Setting, and ancestors", () => {
  // Hidden / secret TokenDocument.
  const hiddenToken = {documentName: "Token", visible: true, hidden: true, isOwner: false, isSecret: false};
  assert.equal(checkDocumentVisibility(hiddenToken, {isGM: false}).visible, false);
  assert.equal(checkDocumentVisibility(hiddenToken, {isGM: true}).visible, true);

  const ownedHiddenToken = {documentName: "Token", visible: true, hidden: true, isOwner: true, isSecret: false};
  assert.equal(checkDocumentVisibility(ownedHiddenToken, {isGM: false}).visible, true);

  const secretToken = {documentName: "Token", visible: true, hidden: false, isOwner: true, isSecret: true};
  assert.equal(checkDocumentVisibility(secretToken, {isGM: false}).visible, false);

  // Embedded item on hidden token synthetic actor must also stay hidden for player.
  const itemOnHiddenToken = {
    documentName: "Item",
    visible: true,
    parent: {documentName: "Actor", visible: true, parent: hiddenToken}
  };
  assert.equal(checkDocumentVisibility(itemOnHiddenToken, {isGM: false}).visible, false);

  // Combatant visibility.
  assert.equal(checkDocumentVisibility({documentName: "Combatant", visible: false}, {isGM: false}).visible, false);
  assert.equal(checkDocumentVisibility({documentName: "Combatant", visible: false}, {isGM: true}).visible, true);

  // ChatMessage two-tier gate.
  assert.equal(checkDocumentVisibility({documentName: "ChatMessage", visible: false, isContentVisible: false}, {isGM: false}).visible, false);
  assert.deepEqual(
    checkDocumentVisibility({documentName: "ChatMessage", visible: true, isContentVisible: false}, {isGM: false}),
    {visible: true, concealContent: true, reason: "contentConcealed"}
  );

  // Setting filtering for non-GM.
  assert.equal(
    checkDocumentVisibility({documentName: "Setting", key: "core.moduleConfiguration", user: null}, {isGM: false, userId: "p1"}).visible,
    false
  );
  assert.equal(
    checkDocumentVisibility({documentName: "Setting", key: "mod.userPref", user: "p2"}, {isGM: false, userId: "p1"}).visible,
    false
  );
  assert.equal(
    checkDocumentVisibility({documentName: "Setting", key: "mod.userPref", user: "p1"}, {isGM: false, userId: "p1"}).visible,
    true
  );
  assert.equal(
    checkDocumentVisibility({documentName: "Setting", key: "dnd5e.metricLengthUnits", user: null}, {
      isGM: false,
      userId: "p1",
      settingConfig: {scope: "world", config: true}
    }).visible,
    true
  );
});

test("sanitizeConcealedRecord strips content, flavor, and rolls diffs from concealed ChatMessage events", () => {
  const sanitized = sanitizeConcealedRecord({
    id: "ev-1",
    seq: 1,
    timestamp: 1000,
    kind: "document",
    actionId: "act-1",
    groupingBasis: "standalone",
    combat: null,
    user: {id: "u1", name: "Alice", isSelf: false, remote: true},
    attribution: {sourceType: "user", packageId: null, label: "Alice", confidence: "exact"},
    target: {type: "message", messageId: "m1"},
    summary: "ChatMessage m1 · rolls: 20",
    detail: {
      documentName: "ChatMessage",
      messageId: "m1",
      isRoll: true,
      rollCount: 1,
      content: "<p>20</p>",
      flavor: "Stealth",
      diffs: [
        {path: "content", op: "add", before: undefined, after: "20"},
        {path: "rolls.0.total", op: "add", before: undefined, after: 20},
        {path: "whisper", op: "add", before: undefined, after: ["gm1"]}
      ]
    },
    repeat: null,
    concealed: true
  });

  assert.equal(sanitized.summary, "ChatMessage · [concealed]");
  assert.equal(sanitized.detail.rollCount, 0);
  assert.equal(sanitized.detail.content, undefined);
  assert.equal(sanitized.detail.flavor, undefined);
  assert.deepEqual(sanitized.detail.diffs, [{path: "whisper", op: "add", before: undefined, after: ["gm1"]}]);
});

test("normalizeFilter maps both TraceFilter and TargetRef inputs", () => {
  assert.deepEqual(normalizeFilter({type: "document", uuid: "Actor.1"}), {uuid: "Actor.1"});
  assert.deepEqual(normalizeFilter({type: "message", messageId: "msg-9"}), {messageId: "msg-9"});
  assert.deepEqual(normalizeFilter({type: "module", moduleId: "midi-qol"}), {moduleId: "midi-qol"});
  assert.deepEqual(normalizeFilter({type: "hook", hookName: "preUpdateActor"}), {query: "preUpdateActor"});
  assert.deepEqual(normalizeFilter({type: "actorField", uuid: "Actor.1", path: "system.hp"}), {
    uuid: "Actor.1",
    query: "system.hp"
  });
  assert.deepEqual(normalizeFilter({type: "visibility", uuid: "Token.2"}), {uuid: "Token.2"});
  assert.deepEqual(normalizeFilter({kind: "error", moduleId: "foo", query: "  hp  "}), {
    kind: "error",
    moduleId: "foo",
    query: "hp"
  });
  assert.deepEqual(normalizeFilter({kind: "all"}), {});
});

test("TraceStore groups events via sync-stack and 250ms time-window while splitting cross-user, remote, and overtime events", () => {
  let now = 10_000;
  const store = new TraceStore({now: () => now, actionWindowMs: 250});
  const selfUser = {id: "gm", name: "GM", isSelf: true, remote: false};
  const otherUser = {id: "p1", name: "Bob", isSelf: false, remote: true};
  const modA = {sourceType: "module", packageId: "mod-a", label: "mod-a", confidence: "exact"};
  const modB = {sourceType: "module", packageId: "mod-b", label: "mod-b", confidence: "exact"};

  // Sync-stack grouping (nested frames + exception-safe pop).
  const rootToken = store.pushSyncFrame({hookName: "preUpdateActor"});
  const e1 = store.recordEvent({kind: "document", user: selfUser, attribution: modA, summary: "e1", detail: {uuid: "Actor.1"}});
  assert.throws(() => {
    store.runInSyncFrame({hookName: "inner"}, () => {
      store.recordEvent({kind: "error", user: selfUser, attribution: modA, summary: "err", detail: {}});
      throw new Error("boom");
    });
  });
  // Sync frame stack remains intact at outer depth after inner throw.
  assert.equal(store.syncDepth, 1);
  const e2 = store.recordEvent({kind: "document", user: selfUser, attribution: modA, summary: "e2", detail: {uuid: "Item.1"}});
  store.popSyncFrame(rootToken);
  assert.equal(store.syncDepth, 0);
  assert.equal(e1.actionId, e2.actionId);
  assert.equal(e2.groupingBasis, "sync-stack");

  // Time-window merge within 250ms for same local user & module.
  now = 10_150;
  const e3 = store.recordEvent({kind: "document", user: selfUser, attribution: modA, summary: "e3", detail: {uuid: "Actor.2"}});
  assert.equal(e3.actionId, e1.actionId);
  assert.equal(e3.groupingBasis, "time-window");

  // Different unrelated module & different target within 250ms splits into new group.
  now = 10_200;
  const e4 = store.recordEvent({kind: "document", user: selfUser, attribution: modB, summary: "e4", detail: {uuid: "Actor.9"}});
  assert.notEqual(e4.actionId, e3.actionId);
  assert.equal(e4.groupingBasis, "standalone");

  // Exceeding 250ms splits.
  now = 10_600;
  const e5 = store.recordEvent({kind: "document", user: selfUser, attribution: modB, summary: "e5", detail: {uuid: "Actor.9"}});
  assert.notEqual(e5.actionId, e4.actionId);

  // Remote user never merges into local time-window.
  now = 10_650;
  const e6 = store.recordEvent({kind: "document", user: otherUser, attribution: modB, summary: "e6", detail: {uuid: "Actor.9"}});
  assert.notEqual(e6.actionId, e5.actionId);
});

test("TraceStore merges duplicate notifications, updates progress in-place, and enforces ring capacity and 10s TTL", () => {
  let now = 50_000;
  const store = new TraceStore({now: () => now, maxEvents: 100}); // Clamps min to 200.
  assert.equal(store.capacity, 200);

  const n1 = store.recordNotification({notificationId: 1, level: "warning", text: "Low   memory!"});
  now += 500;
  const n2 = store.recordNotification({notificationId: 2, level: "warning", text: "Low memory!"});
  assert.equal(n1, n2);
  assert.equal(store.summary().total, 1);
  assert.deepEqual(n1.repeat, {count: 2, firstAt: 50_000, lastAt: 50_500});
  assert.equal(notificationSignature("warning", "Low  memory!"), "warning\nLow memory!");

  // Progress notification does not merge and updates in-place by notificationId.
  const p1 = store.recordNotification({notificationId: 10, level: "info", text: "Importing...", progress: true, pct: 0.2});
  assert.equal(store.summary().total, 2);
  store.updateNotificationProgress({notificationId: 10, text: "Almost done", pct: 0.9});
  assert.equal(store.summary().total, 2);
  assert.equal(p1.detail.text, "Almost done");
  assert.equal(p1.detail.pct, 0.9);

  // Dual UUID cache + 10s TTL.
  const map = new Map([["system.hp.value", 10]]);
  store.cacheBefore(["Scene.1.Token.1.Actor.1", "Scene.1.Token.1.ActorDelta.1"], map, null, now);
  const hit = store.consumeBefore(["Scene.1.Token.1.ActorDelta.1"], now + 2000);
  assert.equal(hit?.beforeMap.get("system.hp.value"), 10);
  // Sibling key was also cleared on consume.
  assert.equal(store.consumeBefore(["Scene.1.Token.1.Actor.1"], now + 2000), null);

  store.cacheBefore("Actor.ttl", map, null, now);
  assert.equal(store.consumeBefore("Actor.ttl", now + 10_001), null);

  // Ring buffer eviction at capacity 200.
  for (let i = 0; i < 250; i++) {
    store.recordEvent({kind: "document", summary: `ev-${i}`, detail: {}});
  }
  assert.equal(store.summary().total, 200);
  assert.equal(store.getEvents()[0].summary, "ev-50");
});

test("buildTimelineSections separates combat round/turn transitions and 5-minute / day breaks", () => {
  const combat1 = {combatId: "c1", round: 1, turn: 0, combatantName: "Alice"};
  const combat2 = {combatId: "c1", round: 1, turn: 1, combatantName: "Goblin"};
  const t0 = new Date(2026, 10, 27, 10, 0, 0).getTime();
  const events = [
    {id: "1", seq: 1, timestamp: t0, kind: "document", actionId: "a1", groupingBasis: "standalone", combat: combat1, user: {id: "u", name: "U", isSelf: true, remote: false}, attribution: {sourceType: "user", packageId: null, label: "U", confidence: "exact"}, target: null, summary: "1", detail: {}, repeat: null, concealed: false},
    {id: "2", seq: 2, timestamp: t0 + 1000, kind: "document", actionId: "a2", groupingBasis: "standalone", combat: combat2, user: {id: "u", name: "U", isSelf: true, remote: false}, attribution: {sourceType: "user", packageId: null, label: "U", confidence: "exact"}, target: null, summary: "2", detail: {}, repeat: null, concealed: false},
    {id: "3", seq: 3, timestamp: t0 + 2000, kind: "document", actionId: "a3", groupingBasis: "standalone", combat: null, user: {id: "u", name: "U", isSelf: true, remote: false}, attribution: {sourceType: "user", packageId: null, label: "U", confidence: "exact"}, target: null, summary: "3", detail: {}, repeat: null, concealed: false},
    {id: "4", seq: 4, timestamp: t0 + 305_000, kind: "document", actionId: "a4", groupingBasis: "standalone", combat: null, user: {id: "u", name: "U", isSelf: true, remote: false}, attribution: {sourceType: "user", packageId: null, label: "U", confidence: "exact"}, target: null, summary: "4", detail: {}, repeat: null, concealed: false}
  ];
  const sections = buildTimelineSections(groupEvents(events));
  assert.equal(sections.length, 4);
  assert.equal(sections[0].kind, "combat");
  assert.equal(sections[1].kind, "combat");
  assert.equal(sections[2].kind, "time");
  assert.equal(sections[3].kind, "time");
  assert.ok(sections[3].gapMs >= 300_000);
});

test("multi-facet filtering, snapshot envelope, and uncached before formatting", () => {
  let now = 20_000;
  const store = new TraceStore({
    now: () => now,
    environment: () => ({
      moduleVersion: "0.1.0",
      foundryVersion: "13.351",
      systemId: "dnd5e",
      worldId: "test-world",
      userRole: "GAMEMASTER",
      modules: [{id: "mod-x", title: "Mod X", version: "1.0.0"}]
    })
  });
  store.recordEvent({
    kind: "document",
    attribution: {sourceType: "module", packageId: "mod-x", label: "mod-x", confidence: "exact"},
    target: {type: "document", uuid: "Actor.7"},
    summary: "Actor.7 hp changed",
    detail: {uuid: "Actor.7", documentName: "Actor", diffs: [{path: "system.hp.value", op: "set", before: undefined, after: 4}], beforeCached: false}
  });
  store.recordEvent({
    kind: "error",
    attribution: {sourceType: "module", packageId: "mod-x", label: "mod-x", confidence: "exact"},
    summary: "Null pointer",
    detail: {origin: "hooks", message: "Cannot read hp"}
  });

  const all = store.getEvents();
  assert.equal(filterEvents(all, {moduleId: "mod-x", query: "cannot hp"}).length, 1);
  assert.deepEqual(countFilterKinds(all, {moduleId: "mod-x", kind: "error"}), {
    all: 2,
    document: 1,
    notification: 0,
    interception: 0,
    error: 1
  });

  const snap = store.buildSnapshot({filter: {moduleId: "mod-x"}, limit: 1});
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.producer, "event-trace");
  assert.equal(snap.foundryVersion, "13.351");
  assert.equal(snap.userRole, "GAMEMASTER");
  assert.equal(snap.data.events.length, 1);
  assert.equal(snap.data.events[0].kind, "error");

  const combatSnap = computeCombatSnapshot({
    combat: {id: "c9", started: true, round: 2, turn: 1, visible: true, combatant: {name: "Secret", visible: false}}
  }, {isGM: false});
  assert.deepEqual(combatSnap, {combatId: "c9", round: 2, turn: 1, combatantName: null});

  const formattedUncached = formatDiffEntry(
    {path: "system.hp.value", op: "set", before: undefined, after: 4},
    k => k,
    {beforeCached: false}
  );
  assert.equal(formattedUncached.beforeText, "EVENTTRACE.Diff.Uncached");
});
