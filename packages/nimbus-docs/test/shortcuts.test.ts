// Keyboard shortcuts in a DOM: how keys match, where they don't fire, and the
// reader's switch for single keys (WCAG 2.1.4).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;
const g = globalThis as Record<string, unknown>;

function setPlatform(mac: boolean) {
  Object.defineProperty(dom.window.navigator, "userAgent", { value: mac ? "Macintosh" : "Windows NT", configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
}

beforeEach(() => {
  dom = new JSDOM(`<!DOCTYPE html><body><input id="field"><button data-nb-shortcuts-toggle></button></body>`, { url: "https://example.com/" });
  for (const name of ["window", "document", "HTMLElement", "CustomEvent", "localStorage"]) g[name] = (dom.window as unknown as Record<string, unknown>)[name];
  setPlatform(false);
});

// A fresh copy of the module each test: its "reader's choice" is per page load.
let n = 0;
const load = async () => (await import(`../src/client/shortcuts.ts?t=${n++}`)) as typeof import("../src/client/shortcuts.ts");

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = dom.window.document.body) {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

test("a literal key fires as typed, Shift allowed, never with Ctrl, ⌘ or Alt", async () => {
  const { onShortcut } = await load();
  const seen: string[] = [];
  onShortcut("[", () => seen.push("["));
  onShortcut("?", () => seen.push("?"));
  press("[");
  press("?", { shiftKey: true });
  press("[", { ctrlKey: true });
  press("[", { metaKey: true });
  press("[", { altKey: true });
  assert.deepEqual(seen, ["[", "?"]);
});

test("a combo needs exactly its modifiers; Mod is ⌘ on macOS and Ctrl elsewhere", async () => {
  const { onShortcut } = await load();
  let hits = 0;
  onShortcut("Shift+Alt+P", () => hits++);
  press("P", { shiftKey: true, altKey: true });
  press("p", { shiftKey: true, altKey: true, ctrlKey: true });
  press("P", { altKey: true });
  assert.equal(hits, 1);

  let mod = 0;
  onShortcut("Mod+K", () => mod++);
  press("k", { ctrlKey: true });
  press("k", { metaKey: true });
  assert.equal(mod, 1, "Ctrl elsewhere");
  setPlatform(true);
  const mac = await load();
  let macHits = 0;
  mac.onShortcut("Mod+K", () => macHits++);
  press("k", { metaKey: true });
  press("k", { ctrlKey: true });
  assert.equal(macHits, 1, "⌘ on macOS");
});

test("nothing fires while typing (combos still do), composing, on repeat, or after another handler", async () => {
  const { onShortcut } = await load();
  let single = 0;
  let combo = 0;
  onShortcut("/", () => single++);
  onShortcut("Mod+K", () => combo++);
  const field = dom.window.document.getElementById("field")!;
  press("/", {}, field);
  press("k", { ctrlKey: true }, field);
  press("/", { isComposing: true });
  press("/", { repeat: true });
  const prevented = new dom.window.KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
  prevented.preventDefault();
  dom.window.document.body.dispatchEvent(prevented);
  assert.equal(single, 0);
  assert.equal(combo, 1);
});

test("false binds nothing, and the cleanup unbinds", async () => {
  const { onShortcut } = await load();
  let hits = 0;
  onShortcut(false, () => hits++);
  const off = onShortcut("]", () => hits++);
  press("]");
  off();
  press("]");
  assert.equal(hits, 1);
});

test("the reader's switch stops single keys at once, keeps combos, and survives broken storage", async () => {
  const s = await load();
  let single = 0;
  let combo = 0;
  s.onShortcut("[", () => single++);
  s.onShortcut("Mod+K", () => combo++);
  let changes = 0;
  dom.window.document.addEventListener(s.SHORTCUTS_CHANGE, () => changes++);
  s.setSingleKeyShortcutsEnabled(false);
  press("[");
  press("k", { ctrlKey: true });
  assert.deepEqual([single, combo, changes], [0, 1, 1]);
  s.setSingleKeyShortcutsEnabled(true);
  press("[");
  assert.equal(single, 1, "back on without rebinding");

  // Storage that throws: on until the reader chooses, and "off" still holds.
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  Object.defineProperty(dom.window, "localStorage", { value: broken, configurable: true });
  g.localStorage = broken;
  const fresh = await load();
  assert.equal(fresh.singleKeyShortcutsEnabled(), true);
  fresh.setSingleKeyShortcutsEnabled(false);
  assert.equal(fresh.singleKeyShortcutsEnabled(), false);
});

test("another tab's choice applies here", async () => {
  const s = await load();
  assert.equal(s.singleKeyShortcutsEnabled(), true);
  dom.window.localStorage.setItem("nb-single-key-shortcuts", "off");
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "nb-single-key-shortcuts" }));
  assert.equal(s.singleKeyShortcutsEnabled(), false);
});

test("without the reader's switch on the page, single keys don't bind page-wide", async () => {
  const s = await load();
  let hits = 0;
  s.onShortcut("/", () => hits++);
  dom.window.document.querySelector("[data-nb-shortcuts-toggle]")!.remove();
  press("/");
  assert.equal(hits, 0);
});

test("labels name the key as each platform writes it", async () => {
  const other = await load();
  assert.equal(other.shortcutLabel("Mod+K"), "Ctrl K");
  assert.equal(other.ariaKeyShortcuts("Mod+K"), "Control+K");
  assert.equal(other.shortcutLabel("["), "[");
  assert.equal(other.shortcutLabel(false), "");
  setPlatform(true);
  const mac = await load();
  assert.equal(mac.shortcutLabel("Mod+K"), "⌘K");
  assert.equal(mac.ariaKeyShortcuts("Mod+K"), "Meta+K");
  assert.equal(mac.isSingleKey("Mod+K"), false);
  assert.equal(mac.isSingleKey("/"), true);
  assert.equal(mac.isSingleKey("Shift+?"), true);
});

test("a key typed with AltGr, or Option on macOS, still fires; Alt alone elsewhere doesn't", async () => {
  const { onShortcut } = await load();
  let hits = 0;
  onShortcut("]", () => hits++);
  press("]", { ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
  press("]", { altKey: true });
  assert.equal(hits, 1, "AltGr on Windows and Linux");
  setPlatform(true);
  const mac = await load();
  let macHits = 0;
  mac.onShortcut("[", () => macHits++);
  press("[", { altKey: true });
  press("[", { altKey: true, metaKey: true });
  assert.equal(macHits, 1, "Option on macOS, never with ⌘");
});

test("within an element, a key answers only while focus is inside it, with or without the switch", async () => {
  dom.window.document.body.innerHTML = `<nav id="bar"><a id="link" href="#">Next</a></nav><p id="out"></p>`;
  const { onShortcut, setSingleKeyShortcutsEnabled } = await load();
  const bar = dom.window.document.getElementById("bar")!;
  let hits = 0;
  onShortcut("]", () => hits++, { within: bar });
  press("]", {}, dom.window.document.getElementById("out")!);
  press("]", {}, dom.window.document.getElementById("link")!);
  assert.equal(hits, 1);
  setSingleKeyShortcutsEnabled(false);
  press("]", {}, dom.window.document.getElementById("link")!);
  assert.equal(hits, 1, "the reader's choice still holds");
});

test("page-wide single keys wait while a modal dialog is open; combos don't", async () => {
  dom.window.document.body.insertAdjacentHTML("beforeend", `<dialog open><button id="close">Close</button></dialog>`);
  // JSDOM has no showModal; stand in for the :modal state the browser reports.
  const doc = dom.window.document;
  const query = doc.querySelector.bind(doc);
  doc.querySelector = ((selector: string) => (selector === "dialog:modal" ? query("dialog") : query(selector))) as typeof doc.querySelector;
  const { onShortcut } = await load();
  const seen: string[] = [];
  onShortcut("]", () => seen.push("]"));
  onShortcut("Mod+K", () => seen.push("k"));
  press("]", {}, dom.window.document.getElementById("close")!);
  press("k", { ctrlKey: true }, dom.window.document.getElementById("close")!);
  assert.deepEqual(seen, ["k"]);
});

test("hints and aria-keyshortcuts follow the platform and the reader's switch", async () => {
  dom.window.document.body.insertAdjacentHTML(
    "beforeend",
    `<button id="search" data-nb-shortcut-for="Mod+K"><kbd id="k" data-nb-shortcut-hint="Mod+K">Ctrl K</kbd></button>
     <a id="next" data-nb-shortcut-for="]"><kbd id="cap" data-nb-shortcut-hint="]">]</kbd></a>`,
  );
  setPlatform(true);
  const { syncShortcutHints, setSingleKeyShortcutsEnabled } = await load();
  const $ = (id: string) => dom.window.document.getElementById(id)!;
  syncShortcutHints();
  assert.equal($("k").textContent, "⌘K");
  assert.equal($("search").getAttribute("aria-keyshortcuts"), "Meta+K");
  assert.equal($("next").getAttribute("aria-keyshortcuts"), "]");

  setSingleKeyShortcutsEnabled(false);
  assert.equal($("cap").style.display, "none", "its hint hides");
  assert.equal($("k").style.display, "", "a combo's hint stays");
  assert.equal($("next").getAttribute("aria-keyshortcuts"), null, "a key that's off isn't announced");
  assert.equal($("search").getAttribute("aria-keyshortcuts"), "Meta+K");

  setSingleKeyShortcutsEnabled(true);
  assert.equal($("cap").style.display, "");
});

test("a key bound within an element is announced without the switch on the page", async () => {
  dom.window.document.body.innerHTML = `<nav data-nb-shortcut-scope><a id="scoped" data-nb-shortcut-for="]"></a></nav><a id="wide" data-nb-shortcut-for="]"></a>`;
  const { syncShortcutHints, setSingleKeyShortcutsEnabled } = await load();
  const $ = (id: string) => dom.window.document.getElementById(id)!;
  syncShortcutHints();
  assert.equal($("scoped").getAttribute("aria-keyshortcuts"), "]");
  assert.equal($("wide").getAttribute("aria-keyshortcuts"), null, "page-wide needs the switch");
  setSingleKeyShortcutsEnabled(false);
  assert.equal($("scoped").getAttribute("aria-keyshortcuts"), null);
});

test("an Alt combo matches its key's place when Option changes the character", async () => {
  setPlatform(true);
  const { onShortcut } = await load();
  let hits = 0;
  onShortcut("Shift+Alt+P", () => hits++);
  onShortcut("Alt+1", () => hits++);
  press("∏", { code: "KeyP", shiftKey: true, altKey: true });
  press("¡", { code: "Digit1", altKey: true });
  press("∏", { code: "KeyO", shiftKey: true, altKey: true });
  assert.equal(hits, 2);
});
