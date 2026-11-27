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
      frame.className = "application";
      const content = document.createElement("div");
      content.className = "window-content event-trace-content";
      frame.append(content);
      this.element = frame;
      document.body.append(frame);
    }
    const content = this.element.querySelector(".window-content");
    const result = this._renderHTML({}, {isFirstRender: true});
    this._replaceHTML(result, content, {});
    this.rendered = true;
    await this._onRender({}, {isFirstRender: true});
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

const enTable = JSON.parse(readFileSync(new URL("../module/lang/en.json", import.meta.url), "utf8"));
const localize = key => enTable[key] ?? key;
const savedFiles = [];

globalThis.foundry = {
  applications: {api: {ApplicationV2}},
  utils: {
    saveDataToFile: (data, type, filename) => savedFiles.push({data, type, filename})
  }
};
globalThis.game = {
  world: {id: "test-world"},
  user: {id: "gm", isGM: true, character: null},
  i18n: {
    lang: "en",
    localize,
    format: (key, data = {}) => localize(key).replace(/\{(\w+)\}/g, (_, k) => String(data[k] ?? ""))
  },
  modules: new Map()
};
globalThis.canvas = {tokens: {controlled: []}, animatePan: () => {}};
globalThis.fromUuidSync = () => null;

const {TraceStore} = await import("../module/scripts/store.mjs");
const {TraceWindow, openTraceWindow} = await import("../module/scripts/window.mjs");

test("TraceWindow renders direct DOM, filters by kind/module/query, handles Esc, expands groups, and exports snapshot", async () => {
  savedFiles.length = 0;
  document.body.replaceChildren();
  const store = new TraceStore();

  // Create a 2-event sync action group + 1 standalone error.
  store.runInSyncFrame({hookName: "preUpdateActor"}, () => {
    store.recordEvent({
      kind: "document",
      attribution: {sourceType: "module", packageId: "mod-a", label: "mod-a", confidence: "exact"},
      target: {type: "document", uuid: "Actor.1"},
      summary: "Actor Goblin · hp 5",
      detail: {
        action: "update",
        documentName: "Actor",
        uuid: "Actor.1",
        name: "Goblin",
        beforeCached: false,
        diffs: [{path: "system.hp.value", op: "set", before: undefined, after: 5}],
        omittedDiffCount: 0
      }
    });
    store.recordEvent({
      kind: "document",
      attribution: {sourceType: "module", packageId: "mod-a", label: "mod-a", confidence: "exact"},
      target: {type: "message", messageId: "msg-1"},
      summary: "ChatMessage Roll",
      detail: {
        action: "create",
        documentName: "ChatMessage",
        messageId: "msg-1",
        isRoll: true,
        rollCount: 1,
        diffs: [],
        omittedDiffCount: 0
      }
    });
  });
  store.recordEvent({
    kind: "error",
    attribution: {sourceType: "module", packageId: "mod-b", label: "mod-b", hookName: "updateToken", confidence: "exact"},
    summary: "ReferenceError: x",
    detail: {origin: "hooks", location: "Hooks.#call", message: "x is not defined", stackLines: ["at foo (mod-b.mjs:1)"]}
  });

  const win = await openTraceWindow(undefined, {store});
  assert.equal(win.options.id, "event-trace-window");
  assert.equal(win.options.position.width, 760);
  assert.equal(win.options.position.height, 560);
  assert.equal(win.options.window.resizable, true);

  // Unread errors cleared when opened.
  assert.equal(store.summary().unreadErrors, 0);

  // Collapsible <details> action group starts collapsed and can expand.
  const groupDetails = win.element.querySelector("details.et-group");
  assert.ok(groupDetails);
  assert.equal(groupDetails.open, false);
  groupDetails.open = true;
  groupDetails.dispatchEvent(new Event("toggle"));

  // Filter by kind="error".
  win.element.querySelector('[data-trace-kind="error"]').click();
  assert.equal(win.element.querySelectorAll("[data-trace-event-id]").length, 1);

  // Select the error event and verify detail pane + uncached/stack display.
  win.element.querySelector("[data-trace-event-id]").click();
  assert.equal(win.element.querySelector(".et-detail").hidden, false);
  assert.match(win.element.querySelector(".et-stack").textContent, /mod-b\.mjs/);

  // Filter by module + search query + Esc clears non-empty search.
  win.element.querySelector('[data-trace-kind="all"]').click();
  const search = win.element.querySelector('[data-trace-filter="query"]');
  search.value = "Goblin";
  search.dispatchEvent(new Event("input", {bubbles: true}));
  assert.match(win.element.querySelector(".et-status-text").textContent, /Showing 1 \/ 3/);

  const escWithText = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
  search.dispatchEvent(escWithText);
  assert.equal(escWithText.defaultPrevented, true);
  assert.equal(search.value, "");

  // When search is empty, Esc is NOT swallowed.
  const escEmpty = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
  search.dispatchEvent(escEmpty);
  assert.equal(escEmpty.defaultPrevented, false);

  // Export snapshot.
  win.element.querySelector('[data-trace-action="export-snapshot"]').click();
  assert.equal(savedFiles.length, 1);
  const parsed = JSON.parse(savedFiles[0].data);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.producer, "event-trace");

  // Throttled live update while open, and zero DOM updates after close().
  const beforeCloseRenders = win.refreshCount;
  store.recordNotification({level: "info", text: "Live ping"});
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.ok(win.refreshCount > beforeCloseRenders);

  await win.close();
  const afterCloseRenders = win.refreshCount;
  store.recordNotification({level: "info", text: "Closed ping"});
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(win.refreshCount, afterCloseRenders);
});

test("TraceWindow conditionally shows peer jump buttons for chat-lens, rule-lens, and runtime-monitor", async () => {
  document.body.replaceChildren();
  const store = new TraceStore();
  const rollMsg = store.recordEvent({
    kind: "document",
    attribution: {sourceType: "module", packageId: "midi-qol", hookName: "createChatMessage", label: "midi-qol", confidence: "exact"},
    target: {type: "message", messageId: "msg-42"},
    summary: "ChatMessage Roll",
    detail: {
      action: "create",
      documentName: "ChatMessage",
      messageId: "msg-42",
      isRoll: true,
      rollCount: 1,
      diffs: []
    }
  });
  const actorChange = store.recordEvent({
    kind: "document",
    attribution: {sourceType: "module", packageId: "dae", hookName: "updateActor", label: "dae", confidence: "exact"},
    target: {type: "document", uuid: "Actor.10"},
    summary: "Actor Hero · system.hp.value: 10",
    detail: {
      action: "update",
      documentName: "Actor",
      uuid: "Actor.10",
      diffs: [{path: "system.hp.value", op: "set", before: 12, after: 10}]
    }
  });

  // Case 1: no peers active -> no peer jump buttons rendered.
  const winNoPeers = new TraceWindow({store});
  await winNoPeers.render({force: true});
  winNoPeers.element.querySelector(`[data-trace-event-id="${rollMsg.id}"]`).click();
  assert.equal(
    winNoPeers.element.querySelector('[data-trace-action="jump-chat-lens-focus"], [data-trace-action="jump-chat-lens-details"], [data-trace-action="jump-rule-lens"], [data-trace-action="jump-runtime-monitor"]'),
    null
  );
  await winNoPeers.close();

  // Case 2: chat-lens active WITHOUT focusMessage/openDetails -> Chat Lens buttons stay hidden.
  const calls = [];
  const peers = new Map([
    ["chat-lens", {id: "chat-lens", active: true, api: {model: () => ({})}}],
    ["rule-lens", {id: "rule-lens", active: true, api: {open: target => calls.push(["rule", target])}}],
    ["runtime-monitor", {id: "runtime-monitor", active: true, api: {open: focus => calls.push(["rm", focus])}}]
  ]);
  const winPartialChat = new TraceWindow({
    store,
    env: {getPeer: id => peers.get(id) ?? null}
  });
  await winPartialChat.render({force: true});
  winPartialChat.element.querySelector(`[data-trace-event-id="${rollMsg.id}"]`).click();
  assert.equal(winPartialChat.element.querySelector('[data-trace-action="jump-chat-lens-focus"]'), null);
  assert.equal(winPartialChat.element.querySelector('[data-trace-action="jump-chat-lens-details"]'), null);
  assert.ok(winPartialChat.element.querySelector('[data-trace-action="jump-rule-lens"]'));
  assert.ok(winPartialChat.element.querySelector('[data-trace-action="jump-runtime-monitor"]'));

  winPartialChat.element.querySelector('[data-trace-action="jump-rule-lens"]').click();
  winPartialChat.element.querySelector('[data-trace-action="jump-runtime-monitor"]').click();
  assert.deepEqual(calls, [
    ["rule", {type: "roll", messageId: "msg-42"}],
    ["rm", {moduleId: "midi-qol", hookName: "createChatMessage"}]
  ]);

  // Case 3: chat-lens WITH focusMessage and openDetails + Actor field Rule Lens target.
  calls.length = 0;
  peers.set("chat-lens", {
    id: "chat-lens",
    active: true,
    api: {
      focusMessage: id => calls.push(["chat-focus", id]),
      openDetails: id => calls.push(["chat-details", id])
    }
  });
  winPartialChat.element.querySelector(`[data-trace-event-id="${rollMsg.id}"]`).click(); // deselect
  winPartialChat.element.querySelector(`[data-trace-event-id="${rollMsg.id}"]`).click(); // select
  winPartialChat.element.querySelector('[data-trace-action="jump-chat-lens-focus"]').click();
  winPartialChat.element.querySelector('[data-trace-action="jump-chat-lens-details"]').click();
  assert.deepEqual(calls, [
    ["chat-focus", "msg-42"],
    ["chat-details", "msg-42"]
  ]);

  calls.length = 0;
  winPartialChat.element.querySelector(`[data-trace-event-id="${actorChange.id}"]`).click();
  winPartialChat.element.querySelector('[data-trace-action="jump-rule-lens"]').click();
  assert.deepEqual(calls, [
    ["rule", {type: "actorField", uuid: "Actor.10", path: "system.hp.value"}]
  ]);

  // ActiveEffect change jumps to Rule Lens with { type: "effects" } & focus-selected + sheet/token actions work.
  const effectChange = store.recordEvent({
    kind: "document",
    attribution: {sourceType: "module", packageId: "dae", label: "dae", confidence: "exact"},
    target: {type: "document", uuid: "Actor.10.ActiveEffect.e1"},
    summary: "ActiveEffect Bless · disabled: false",
    detail: {
      action: "update",
      documentName: "ActiveEffect",
      uuid: "Actor.10.ActiveEffect.e1",
      parentUuid: "Actor.10",
      actorUuid: "Actor.10",
      diffs: [{path: "disabled", op: "set", before: true, after: false}]
    }
  });
  const concealedRoll = store.recordEvent({
    kind: "document",
    concealed: true,
    target: {type: "message", messageId: "msg-blind"},
    summary: "ChatMessage · [concealed]",
    detail: {action: "create", documentName: "ChatMessage", messageId: "msg-blind", isRoll: true, rollCount: 0, diffs: []}
  });

  // Token/sheet/selection mock on a fresh window.
  let sheetRendered = 0;
  let tokenLocated = 0;
  const controlledWin = new TraceWindow({
    store,
    env: {
      getPeer: id => peers.get(id) ?? null,
      getSelectedTarget: () => ({uuid: "Actor.10", label: "Hero"}),
      fromUuidSync: uuid => (uuid === "Actor.10"
        ? {uuid, sheet: {render: () => { sheetRendered += 1; }}, object: {center: {x: 1, y: 1}}}
        : null),
      locateToken: () => { tokenLocated += 1; return true; }
    }
  });
  await controlledWin.render({force: true});

  controlledWin.element.querySelector('[data-trace-action="focus-selected"]').click();
  assert.equal(controlledWin.filter.uuid, "Actor.10");

  controlledWin.element.querySelector(`[data-trace-event-id="${actorChange.id}"]`).click();
  controlledWin.element.querySelector('[data-trace-action="open-sheet"]').click();
  controlledWin.element.querySelector('[data-trace-action="locate-token"]').click();
  assert.equal(sheetRendered, 1);
  assert.equal(tokenLocated, 1);

  calls.length = 0;
  controlledWin.element.querySelector(`[data-trace-event-id="${effectChange.id}"]`).click();
  controlledWin.element.querySelector('[data-trace-action="jump-rule-lens"]').click();
  assert.deepEqual(calls, [["rule", {type: "effects", uuid: "Actor.10", path: "disabled"}]]);

  // Reset filters so concealedRoll is visible, and ensure concealed roll does NOT expose Rule Lens jump.
  controlledWin.element.querySelector('[data-trace-action="reset-filters"]').click();
  controlledWin.element.querySelector(`[data-trace-event-id="${concealedRoll.id}"]`).click();
  assert.equal(controlledWin.element.querySelector('[data-trace-action="jump-rule-lens"]'), null);

  // Clear store empties buffer and detail pane.
  controlledWin.element.querySelector('[data-trace-action="clear-store"]').click();
  assert.equal(store.summary().total, 0);
  assert.equal(controlledWin.element.querySelector(".et-detail").hidden, true);

  await controlledWin.close();
  await winPartialChat.close();
});
