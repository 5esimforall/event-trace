import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://localhost/"});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.HTMLDetailsElement = dom.window.HTMLDetailsElement;
globalThis.Option = dom.window.Option;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.CSS = {escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`)};

class ApplicationV2 {
  static DEFAULT_OPTIONS = {position: {}};
  element = null;
  options = {};
  rendered = false;
  constructor(options = {}) {
    this.options = {...this.constructor.DEFAULT_OPTIONS, ...options};
  }
  async render() {
    if (!this.element) {
      const frame = document.createElement("div");
      const content = document.createElement("div");
      content.className = "window-content event-trace-content";
      frame.append(content);
      this.element = frame;
      document.body.append(frame);
    }
    const content = this.element.querySelector(".window-content");
    this._replaceHTML(this._renderHTML({}, {}), content, {});
    this.rendered = true;
    await this._onRender({}, {});
    return this;
  }
  _renderHTML() { return document.createElement("div"); }
  _replaceHTML(result, content) { content.replaceChildren(result); }
  async _onRender() {}
  _onClose() {}
  bringToFront() {}
  async close() {
    this.rendered = false;
    this.element?.remove();
    this.element = null;
    this._onClose();
    return this;
  }
}

globalThis.foundry = {applications: {api: {ApplicationV2}}, utils: {saveDataToFile: () => {}}};

const enTable = JSON.parse(readFileSync(new URL("../module/lang/en.json", import.meta.url), "utf8"));
const {installEventTrace, uninstallEventTrace} = await import("../module/scripts/main.mjs");

function createRuntimeFixture({sidebarActive = true, isGM = true} = {}) {
  let nextId = 1;
  const events = {};
  const ids = new Map();
  const Hooks = {
    get events() { return events; },
    on(hook, fn, {once = false} = {}) {
      const id = nextId++;
      if (!events[hook]) events[hook] = [];
      const entry = {hook, id, fn, once};
      events[hook].push(entry);
      ids.set(id, entry);
      return id;
    },
    once(hook, fn) { return this.on(hook, fn, {once: true}); },
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
    },
    callAll(hook, ...args) {
      const list = events[hook];
      if (!list) return;
      for (const entry of Array.from(list)) {
        if (entry.once) this.off(hook, entry.id);
        entry.fn(...args);
      }
    }
  };

  let notifySeq = 1;
  class Notifications {
    notify(message, type = "info", opts = {}) {
      return {
        id: notifySeq++,
        type,
        message: String(message),
        timestamp: Date.now(),
        progress: Boolean(opts.progress),
        permanent: Boolean(opts.permanent),
        pct: 0
      };
    }
    info(m, o) { return this.notify(m, "info", o); }
    warn(m, o) { return this.notify(m, "warning", o); }
    error(m, o) { return this.notify(m, "error", o); }
    update(n, u) { if (n && typeof n === "object" && u?.pct !== undefined) n.pct = u.pct; return n; }
  }
  const notificationsInstance = new Notifications();

  const registeredSettings = [];
  const registeredMenus = [];
  const registeredKeybindings = [];
  const sidebarActions = [];
  const settingValues = new Map();
  const settingConfigs = new Map([["world.public", {scope: "world", config: true}]]);
  const socketPrependListeners = [];

  const actors = new Map([
    ["actor1", {id: "actor1", uuid: "Actor.actor1", name: "Hero", visible: true}],
    ["hiddenActor", {id: "hiddenActor", uuid: "Actor.hiddenActor", name: "Secret", visible: false}]
  ]);
  const messages = new Map([
    ["msg1", {id: "msg1", visible: true}],
    ["msgHidden", {id: "msgHidden", visible: false}]
  ]);
  const syntheticActor = {
    id: "actor1",
    uuid: "Scene.s1.Token.t1.Actor.actor1",
    name: "Unlinked Goblin",
    visible: true,
    _source: {system: {hp: {value: 7}}},
    parent: {
      documentName: "Token",
      uuid: "Scene.s1.Token.t1",
      visible: true,
      hidden: false,
      isOwner: true,
      isSecret: false,
      delta: {uuid: "Scene.s1.Token.t1.ActorDelta.d1"}
    }
  };

  const modules = new Map([
    ["event-trace", {id: "event-trace", title: "Event Trace", version: "0.1.0", active: true, api: null}]
  ]);
  if (sidebarActive) {
    modules.set("sidebar-layout", {
      id: "sidebar-layout",
      active: true,
      api: {registerAction: cfg => sidebarActions.push(cfg)}
    });
  }

  const windowListeners = new Map();
  const windowObj = {
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
    dispatchMock(type, event) {
      for (const fn of windowListeners.get(type) ?? []) fn(event);
    }
  };

  const game = {
    version: "13.351",
    system: {id: "dnd5e"},
    world: {id: "world-1"},
    user: {id: "u-gm", name: isGM ? "GM" : "Player", isGM, role: isGM ? 4 : 1},
    users: {get: id => (id === "u-remote" ? {id: "u-remote", name: "Alice"} : undefined)},
    i18n: {
      lang: "en",
      localize: k => enTable[k] ?? k,
      format: (k, d = {}) => (enTable[k] ?? k).replace(/\{(\w+)\}/g, (_, key) => String(d[key] ?? ""))
    },
    modules,
    settings: {
      settings: settingConfigs,
      register(ns, key, cfg) {
        registeredSettings.push({ns, key, cfg});
        settingValues.set(`${ns}.${key}`, cfg.default);
      },
      registerMenu(ns, key, cfg) { registeredMenus.push({ns, key, cfg}); },
      get(ns, key) { return settingValues.get(`${ns}.${key}`); },
      set(ns, key, val) { settingValues.set(`${ns}.${key}`, val); }
    },
    keybindings: {
      register(ns, action, cfg) { registeredKeybindings.push({ns, action, cfg}); }
    },
    combat: {
      id: "combat-1",
      started: true,
      round: 1,
      turn: 0,
      visible: true,
      combatant: {name: "Hero", visible: true},
      combatants: new Map([["c1", {id: "c1", uuid: "Combatant.c1", visible: true, actor: {uuid: "Actor.actor1"}}]])
    },
    collections: new Map([["Actor", actors]]),
    actors,
    messages,
    socket: {
      prependAny(fn) { socketPrependListeners.push(fn); },
      offAny(fn) {
        const idx = socketPrependListeners.indexOf(fn);
        if (idx >= 0) socketPrependListeners.splice(idx, 1);
      },
      emitMock(event, response) {
        for (const fn of socketPrependListeners) fn(event, response);
      }
    }
  };

  const rt = {
    Hooks,
    game,
    ui: {notifications: notificationsInstance, combat: {viewed: game.combat}},
    CONFIG: {ui: {notifications: Notifications}},
    CONST: {USER_ROLE_NAMES: {1: "PLAYER", 4: "GAMEMASTER"}},
    windowObj,
    fromUuidSync: uuid => (uuid === "Scene.s1.Token.t1" ? syntheticActor.parent : null)
  };
  syntheticActor.parent.actor = syntheticActor;

  return {
    rt,
    actors,
    syntheticActor,
    registeredSettings,
    registeredMenus,
    registeredKeybindings,
    sidebarActions,
    windowObj
  };
}

test("main lifecycle registers client settings, API, Sidebar Layout action, Notifications, hooks, errors, socket cache, and context menus", async () => {
  const fx = createRuntimeFixture({sidebarActive: true});
  const inst = installEventTrace(fx.rt);

  fx.rt.Hooks.callAll("init");
  assert.equal(fx.registeredSettings.length, 4);
  assert.ok(fx.registeredSettings.every(s => s.cfg.scope === "client"));
  assert.equal(fx.registeredMenus.length, 1);
  assert.equal(fx.registeredMenus[0].cfg.restricted, false);
  assert.equal(fx.registeredKeybindings.length, 1);

  fx.rt.Hooks.callAll("ready");
  const api = fx.rt.game.modules.get("event-trace").api;
  assert.equal(typeof api.open, "function");
  assert.equal(typeof api.snapshot, "function");
  assert.equal(typeof api.summary, "function");
  assert.equal(fx.sidebarActions.length, 1);
  assert.equal(fx.sidebarActions[0].id, "event-trace.open");

  // Notifications pass through unchanged and record + update progress.
  const warnResult = fx.rt.ui.notifications.warn("Watch out!");
  assert.equal(warnResult.type, "warning");
  assert.equal(warnResult.message, "Watch out!");
  const prog = fx.rt.ui.notifications.notify("Loading", "info", {progress: true});
  fx.rt.ui.notifications.update(prog, {pct: 0.75, message: "75% done"});
  assert.equal(prog.pct, 0.75);

  // Hooks.call returning false records interception and preserves strict false return.
  fx.rt.Hooks.on("preMoveToken", () => false);
  assert.equal(fx.rt.Hooks.call("preMoveToken", {uuid: "Token.1", name: "Goblin"}), false);

  // preUpdateActor -> updateActor captures before & after diffs without duplicating ActorDelta.
  const hero = {
    id: "actor1",
    uuid: "Actor.actor1",
    name: "Hero",
    visible: true,
    _source: {system: {hp: {value: 20}}}
  };
  fx.rt.Hooks.call("preUpdateActor", hero, {"system.hp.value": 14}, {diff: true}, "u-gm");
  hero._source.system.hp.value = 14;
  fx.rt.Hooks.callAll("updateActor", hero, {_id: "actor1", system: {hp: {value: 14}}}, {diff: true}, "u-gm");

  // Unlinked Token synthetic actor via dual UUID + remote socket prependAny before-cache.
  fx.rt.game.socket.emitMock("modifyDocument", {
    type: "ActorDelta",
    action: "update",
    userId: "u-remote",
    operation: {syntheticActorUpdate: true, parentUuid: "Scene.s1.Token.t1"},
    result: [{_id: "d1", system: {hp: {value: 3}}}]
  });
  fx.syntheticActor._source.system.hp.value = 3;
  fx.rt.Hooks.callAll("updateActor", fx.syntheticActor, {_id: "actor1", system: {hp: {value: 3}}}, {}, "u-remote");
  // ActorDelta hook (if fired) is ignored without recording duplicate event.
  fx.rt.Hooks.callAll("updateActorDelta", fx.syntheticActor.parent.delta, {}, {}, "u-remote");

  // clientSettingChanged respect captureSettings toggle.
  fx.rt.Hooks.callAll("clientSettingChanged", "someMod.theme", "dark", {});
  fx.rt.game.settings.set("event-trace", "captureSettings", false);
  fx.rt.Hooks.callAll("clientSettingChanged", "someMod.theme", "light", {});

  // Error capture + re-entrancy protection + ignoring resource element error.
  fx.rt.Hooks.callAll("error", "Hooks.#call", new Error("Kaboom"), {hook: "updateActor"});
  fx.windowObj.dispatchMock("error", {target: fx.windowObj, error: new Error("Script crash"), filename: "http://localhost/modules/bad-mod/a.mjs", lineno: 9, colno: 2});
  fx.windowObj.dispatchMock("error", {target: document.createElement("img"), filename: "http://localhost/missing.png"});
  fx.windowObj.dispatchMock("unhandledrejection", {reason: new Error("Async fail")});

  // Re-entrancy guard when error subscriber throws inside error capture.
  const unsub = inst.store.subscribe(() => {
    throw new Error("Subscriber failure");
  });
  fx.rt.Hooks.callAll("error", "Test", new Error("Outer"), {});
  unsub();

  const events = inst.store.getEvents();
  const docEvents = events.filter(e => e.kind === "document");
  assert.equal(docEvents.length, 3); // hero update, syntheticActor remote update, 1 clientSettingChanged
  assert.equal(docEvents[0].detail.diffs[0].before, 20);
  assert.equal(docEvents[0].detail.diffs[0].after, 14);
  assert.equal(docEvents[1].user.remote, true);
  assert.equal(docEvents[1].detail.diffs[0].before, 7);
  assert.equal(docEvents[1].detail.diffs[0].after, 3);

  const errorEvents = events.filter(e => e.kind === "error");
  assert.equal(errorEvents.length, 4); // Hooks error, window JS error, unhandledrejection, Outer error (not img, no infinite loop!)
  assert.equal(errorEvents[1].attribution.packageId, "bad-mod");

  // Context menu hooks check visibility and target parsing.
  const chatOpts = [];
  fx.rt.Hooks.callAll("getChatMessageContextOptions", {}, chatOpts);
  assert.equal(chatOpts[0].condition({dataset: {messageId: "msg1"}}), true);
  assert.equal(chatOpts[0].condition({dataset: {messageId: "msgHidden"}}), false);

  const actorOpts = [];
  fx.rt.Hooks.callAll("getActorContextOptions", {}, actorOpts);
  assert.equal(actorOpts[0].condition({closest: () => ({dataset: {entryId: "actor1"}})}), true);
  assert.equal(actorOpts[0].condition({closest: () => ({dataset: {entryId: "hiddenActor"}})}), false);

  const combatOpts = [];
  fx.rt.Hooks.callAll("getCombatTrackerContextOptions", {}, combatOpts);
  assert.equal(combatOpts[0].condition({dataset: {combatantId: "c1"}}), true);

  uninstallEventTrace();
});

test("main degrades cleanly without sidebar-layout installed", () => {
  const fx = createRuntimeFixture({sidebarActive: false});
  installEventTrace(fx.rt);
  fx.rt.Hooks.callAll("init");
  fx.rt.Hooks.callAll("ready");
  assert.equal(fx.sidebarActions.length, 0);
  assert.equal(typeof fx.rt.game.modules.get("event-trace").api.open, "function");
  uninstallEventTrace();
});

test("main enforces player visibility gates and preserves Hooks.off by original function reference", () => {
  const fx = createRuntimeFixture({sidebarActive: false, isGM: false});
  const inst = installEventTrace(fx.rt);
  fx.rt.Hooks.callAll("init");
  fx.rt.Hooks.callAll("ready");

  // Cancelable listener unregistered by function reference.
  let runs = 0;
  const blocker = () => {
    runs += 1;
    return false;
  };
  fx.rt.Hooks.on("preUpdateToken", blocker);
  assert.equal(fx.rt.Hooks.call("preUpdateToken", {uuid: "Token.1", visible: true, hidden: false, isOwner: true, isSecret: false}), false);
  assert.equal(runs, 1);
  fx.rt.Hooks.off("preUpdateToken", blocker);
  assert.equal(fx.rt.Hooks.call("preUpdateToken", {uuid: "Token.1"}), true);
  assert.equal(runs, 1);

  // Hidden Token and concealed blind ChatMessage for non-GM player.
  fx.rt.Hooks.callAll("updateToken", {
    id: "tokHidden",
    uuid: "Scene.s1.Token.tokHidden",
    name: "Hidden Boss",
    visible: true,
    hidden: true,
    isOwner: false,
    isSecret: false
  }, {x: 100}, {}, "u-gm");

  fx.rt.Hooks.callAll("createChatMessage", {
    id: "blind1",
    uuid: "ChatMessage.blind1",
    visible: true,
    isContentVisible: false,
    isRoll: true,
    rolls: [{total: 20}]
  }, {content: "Secret 20", rolls: [{total: 20}]}, {}, "u-gm");

  fx.rt.Hooks.callAll("createChatMessage", {
    id: "whisperHidden",
    uuid: "ChatMessage.whisperHidden",
    visible: false,
    isContentVisible: false,
    isRoll: false
  }, {content: "GM secret"}, {}, "u-gm");

  const docs = inst.store.getEvents({kind: "document"});
  assert.equal(docs.length, 1);
  assert.equal(docs[0].concealed, true);
  assert.equal(docs[0].detail.rollCount, 0);
  assert.equal(docs[0].detail.diffs.length, 0);

  uninstallEventTrace();
});
