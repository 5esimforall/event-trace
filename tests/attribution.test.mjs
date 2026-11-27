import test from "node:test";
import assert from "node:assert/strict";
import {HookAttributionRegistry, parseStackAttribution} from "../module/scripts/attribution.mjs";

test("parseStackAttribution handles Chromium, Firefox, Node stacks and skips observer/core frames", () => {
  const chromium = [
    "Error",
    "    at parseStackAttribution (http://localhost:30031/modules/event-trace/scripts/attribution.mjs:120:10)",
    "    at Hooks.on (http://localhost:30031/modules/runtime-monitor/scripts/probes.mjs:44:7)",
    "    at Hooks.on (http://localhost:30031/client/helpers/hooks.mjs:49:10)",
    "    at registerHooks (http://localhost:30031/modules/cool-combat/scripts/hooks.mjs:18:5)"
  ].join("\n");
  assert.deepEqual(parseStackAttribution(chromium, {hookName: "preUpdateActor"}), {
    sourceType: "module",
    packageId: "cool-combat",
    label: "cool-combat",
    hookName: "preUpdateActor",
    fnName: "registerHooks",
    confidence: "exact"
  });

  const firefox = [
    "capture@http://localhost:30031/modules/event-trace/scripts/attribution.mjs:10:2",
    "probes@http://localhost:30031/modules/runtime-monitor/scripts/probes.mjs:22:3",
    "setup@http://localhost:30031/systems/dnd5e/dnd5e.mjs:501:12"
  ].join("\n");
  assert.deepEqual(parseStackAttribution(firefox), {
    sourceType: "system",
    packageId: "dnd5e",
    label: "dnd5e",
    fnName: "setup",
    confidence: "exact"
  });

  const nodeStack = [
    "Error",
    "    at Hooks.on (file:///srv/foundry/Data/modules/event-trace/scripts/attribution.mjs:12:4)",
    "    at ignoreNodeMods (file:///srv/foundry/node_modules/socket.io/index.js:99:3)",
    "    at init (file:///srv/foundry/Data/modules/my%20mod/main.mjs:5:1)"
  ].join("\n");
  assert.equal(parseStackAttribution(nodeStack).packageId, "my mod");

  // Own main.mjs still attributes to event-trace (only attribution.mjs and probes.mjs are skipped).
  const ownMain = [
    "Error",
    "    at http://localhost:30031/modules/event-trace/scripts/attribution.mjs:1:1",
    "    at initMain (http://localhost:30031/modules/event-trace/scripts/main.mjs:20:3)"
  ].join("\n");
  assert.equal(parseStackAttribution(ownMain).packageId, "event-trace");
});

test("parseStackAttribution distinguishes Macro frames and core-only frames", () => {
  const macroChromium = [
    "Error",
    "    at ClientDatabaseBackend (http://localhost:30031/client/data/client-backend.mjs:120:5)",
    "    at eval (eval at #executeScript (http://localhost:30031/client/documents/macro.mjs:210:12), <anonymous>:3:1)"
  ].join("\n");
  const attr = parseStackAttribution(macroChromium);
  assert.equal(attr.sourceType, "user");
  assert.equal(attr.label, "Macro");

  const coreOnly = [
    "Error",
    "    at ActorSheet._onSubmit (http://localhost:30031/client/applications/sheets/actor-sheet.mjs:40:2)"
  ].join("\n");
  assert.equal(parseStackAttribution(coreOnly).sourceType, "core");
});

function createMockHooks({independentOnce = false} = {}) {
  let nextId = 1;
  const events = {};
  const ids = new Map();
  return {
    get events() { return events; },
    on(hook, fn, {once = false} = {}) {
      const id = nextId++;
      if (!events[hook]) events[hook] = [];
      const entry = {hook, id, fn, once};
      events[hook].push(entry);
      ids.set(id, entry);
      return id;
    },
    once(hook, fn) {
      if (!independentOnce) return this.on(hook, fn, {once: true});
      const id = nextId++;
      if (!events[hook]) events[hook] = [];
      const entry = {hook, id, fn, once: true};
      events[hook].push(entry);
      ids.set(id, entry);
      return id;
    },
    off(hook, fnOrId) {
      if (typeof fnOrId === "number") {
        const entry = ids.get(fnOrId);
        if (!entry) return;
        ids.delete(fnOrId);
        const list = events[entry.hook];
        const idx = list?.findIndex(h => h.id === fnOrId) ?? -1;
        if (idx >= 0) list.splice(idx, 1);
      } else {
        const list = events[hook];
        const idx = list?.findIndex(h => h.fn === fnOrId) ?? -1;
        if (idx >= 0) {
          const [removed] = list.splice(idx, 1);
          ids.delete(removed.id);
        }
      }
    },
    call(hook, ...args) {
      const list = events[hook];
      if (!list) return true;
      for (const entry of Array.from(list)) {
        if (entry.once) this.off(hook, entry.id);
        const res = entry.fn(...args);
        if (res === false) return false;
      }
      return true;
    }
  };
}

test("HookAttributionRegistry preserves Hooks.on/once/off/call semantics and intercepts false returns", () => {
  const Hooks = createMockHooks();
  const interceptions = [];
  const registry = new HookAttributionRegistry({
    onInterception: payload => interceptions.push(payload)
  });
  registry.install(Hooks);

  const calls = [];
  const blocker = () => {
    calls.push("blocker");
    return false;
  };
  const second = () => {
    calls.push("second");
  };

  const id1 = Hooks.on("preUpdateActor", blocker);
  const id2 = Hooks.on("preUpdateActor", second);
  assert.equal(typeof id1, "number");
  assert.equal(typeof id2, "number");
  assert.ok(id2 > id1);

  const allowed = Hooks.call("preUpdateActor", {uuid: "Actor.1", name: "Hero"});
  assert.equal(allowed, false);
  assert.deepEqual(calls, ["blocker"]);
  assert.equal(interceptions.length, 1);
  assert.equal(interceptions[0].hookName, "preUpdateActor");
  assert.equal(interceptions[0].callbackRegisteredEarly, false);

  // Hooks.off(hook, originalFn) cleanly unregisters the wrapped listener.
  Hooks.off("preUpdateActor", blocker);
  calls.length = 0;
  assert.equal(Hooks.call("preUpdateActor", {uuid: "Actor.1"}), true);
  assert.deepEqual(calls, ["second"]);
  assert.equal(interceptions.length, 1);

  // Hooks.once works both with delegating once and independent once without double-wrapping.
  let onceCount = 0;
  Hooks.once("preMoveToken", () => {
    onceCount += 1;
    return false;
  });
  assert.equal(Hooks.call("preMoveToken", {uuid: "Token.1"}), false);
  assert.equal(Hooks.call("preMoveToken", {uuid: "Token.1"}), true);
  assert.equal(onceCount, 1);
  assert.equal(interceptions.length, 2);

  registry.uninstall();
});

test("HookAttributionRegistry handles independent Hooks.once and early-registered callbacks", () => {
  const Hooks = createMockHooks({independentOnce: true});
  function earlyBlocker() {
    return false;
  }
  Hooks.on("hotbarDrop", earlyBlocker);

  const interceptions = [];
  const registry = new HookAttributionRegistry({
    onInterception: payload => interceptions.push(payload)
  });
  registry.install(Hooks);

  assert.equal(Hooks.call("hotbarDrop", {}, {uuid: "Item.1"}), false);
  assert.equal(interceptions.length, 1);
  assert.equal(interceptions[0].callbackRegisteredEarly, true);
  assert.equal(interceptions[0].attribution.fnName, "earlyBlocker");

  let independentRuns = 0;
  const onceFn = () => {
    independentRuns += 1;
    return false;
  };
  Hooks.once("chatMessage", onceFn);
  assert.equal(Hooks.call("chatMessage", {}, "hi"), false);
  assert.equal(Hooks.call("chatMessage", {}, "hi"), true);
  assert.equal(independentRuns, 1);

  registry.uninstall();
});

test("HookAttributionRegistry coexists cleanly with an outer wrapper (e.g. runtime-monitor)", () => {
  const Hooks = createMockHooks();
  const interceptions = [];
  const registry = new HookAttributionRegistry({
    onInterception: payload => interceptions.push(payload)
  });
  registry.install(Hooks);

  // Simulate another observer wrapping Hooks after event-trace.
  const outerMap = new Map();
  const prevOn = Hooks.on;
  const prevOff = Hooks.off;
  Hooks.on = function(hook, fn, opts) {
    const wrapped = (...args) => fn(...args);
    outerMap.set(fn, wrapped);
    return prevOn.call(this, hook, wrapped, opts);
  };
  Hooks.off = function(hook, fnOrId) {
    const mapped = typeof fnOrId === "function" ? (outerMap.get(fnOrId) ?? fnOrId) : fnOrId;
    return prevOff.call(this, hook, mapped);
  };

  let count = 0;
  const userListener = () => {
    count += 1;
    return false;
  };
  Hooks.on("preDeleteItem", userListener);
  assert.equal(Hooks.call("preDeleteItem", {uuid: "Item.9"}), false);
  assert.equal(count, 1);
  assert.equal(interceptions.length, 1);

  Hooks.off("preDeleteItem", userListener);
  assert.equal(Hooks.call("preDeleteItem", {uuid: "Item.9"}), true);
  assert.equal(count, 1);

  registry.uninstall();
});

test("HookAttributionRegistry prevents re-entrancy loops inside onInterception", () => {
  const Hooks = createMockHooks();
  const interceptions = [];
  const registry = new HookAttributionRegistry({
    onInterception: payload => {
      interceptions.push(payload);
      // Re-entering Hooks.call for a cancelable hook must not infinitely loop.
      Hooks.call("preUpdateActor", {uuid: "Actor.loop"});
    }
  });
  registry.install(Hooks);

  Hooks.on("preUpdateActor", () => false);
  assert.equal(Hooks.call("preUpdateActor", {uuid: "Actor.1"}), false);
  assert.equal(interceptions.length, 1);

  registry.uninstall();
});
