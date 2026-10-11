/**
 * Tests for `client/tabs-controller.ts` `initTabs` — specifically the
 * `boundarySelector` scoping that keeps a nested <Tabs>'s triggers/panels
 * out of the parent instance. Regression for nested tabs flattening into
 * the outer tablist.
 */

import assert from "node:assert/strict";
import { test, before } from "node:test";
import { JSDOM } from "jsdom";

import { initTabs } from "../src/client/tabs-controller.js";

before(() => {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.CustomEvent = dom.window.CustomEvent;
});

// Outer tabs with two panels; the first outer panel contains a nested
// <Tabs> with its own two triggers + panels.
const NESTED_HTML = `
<div data-nb-tabs id="outer">
  <div role="tablist">
    <button data-nb-tabs-trigger id="o0">Outer A</button>
    <button data-nb-tabs-trigger id="o1">Outer B</button>
  </div>
  <div data-nb-tabs-content id="op0">
    <div data-nb-tabs id="inner">
      <div role="tablist">
        <button data-nb-tabs-trigger id="i0">Inner A</button>
        <button data-nb-tabs-trigger id="i1">Inner B</button>
      </div>
      <div data-nb-tabs-content id="ip0">inner panel 0</div>
      <div data-nb-tabs-content id="ip1">inner panel 1</div>
    </div>
  </div>
  <div data-nb-tabs-content id="op1">outer panel 1</div>
</div>`;

function setup() {
  document.body.innerHTML = NESTED_HTML;
  const outer = document.getElementById("outer")!;
  const inner = document.getElementById("inner")!;
  return { outer, inner };
}

const cfg = {
  tabSelector: "[data-nb-tabs-trigger]",
  panelSelector: "[data-nb-tabs-content]",
  boundarySelector: "[data-nb-tabs]",
} as const;

for (const storage of ["local", "session"] as const) {
  test(`synced tabs remain usable when ${storage} storage quota is exhausted`, () => {
    const dom = new JSDOM("", { url: "https://example.test", storageQuota: 0 });
    const name = storage === "local" ? "localStorage" : "sessionStorage";
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    const { outer } = setup();
    const peer = outer.cloneNode(true) as HTMLElement;
    peer.id = "peer";
    peer.querySelectorAll<HTMLElement>("[id]").forEach((element) => { element.id += "-peer"; });
    document.body.append(peer);
    const instances: ReturnType<typeof initTabs>[] = [];
    try {
      for (const container of [outer, peer]) {
        assert.doesNotThrow(() => {
          instances.push(initTabs({ container, ...cfg, sync: { key: "tabs", storage } }));
        });
      }
      assert.doesNotThrow(() => instances[0]!.activate(1));
      assert.equal(instances[0]!.currentIndex, 1);
      assert.equal(instances[1]!.currentIndex, 1);
      assert.equal(peer.querySelector<HTMLElement>("#op1-peer")!.hidden, false);
    } finally {
      instances.forEach((instance) => instance.destroy());
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
      dom.window.close();
    }
  });
}

test("outer instance only controls its own panels (nested excluded)", () => {
  const { outer } = setup();
  initTabs({ container: outer, ...cfg });

  // Initial activation selects outer tab 0; nested panels untouched by it.
  assert.equal(document.getElementById("o0")!.getAttribute("aria-selected"), "true");
  assert.equal(document.getElementById("o1")!.getAttribute("aria-selected"), "false");
  // Nested triggers were NOT swept into the outer instance.
  assert.equal(document.getElementById("i0")!.hasAttribute("aria-selected"), false);
  assert.equal(document.getElementById("i1")!.hasAttribute("aria-selected"), false);
});

test("activating outer tab 1 toggles only outer panels", () => {
  const { outer } = setup();
  const instance = initTabs({ container: outer, ...cfg });
  instance.activate(1);

  assert.equal(document.getElementById("op0")!.hidden, true);
  assert.equal(document.getElementById("op1")!.hidden, false);
  // Inner panels are not owned by the outer instance, so it never set
  // their hidden flag.
  assert.equal(document.getElementById("ip0")!.hidden, false);
  assert.equal(document.getElementById("ip1")!.hidden, false);
});

test("nested instance operates independently", () => {
  const { outer, inner } = setup();
  initTabs({ container: outer, ...cfg });
  const innerInstance = initTabs({ container: inner, ...cfg });
  innerInstance.activate(1);

  assert.equal(document.getElementById("ip0")!.hidden, true);
  assert.equal(document.getElementById("ip1")!.hidden, false);
  // Outer panels unaffected by inner activation.
  assert.equal(document.getElementById("op0")!.hidden, false);
});

test("without boundarySelector, descendants are NOT scoped (legacy behavior)", () => {
  const { outer } = setup();
  initTabs({ container: outer, tabSelector: cfg.tabSelector, panelSelector: cfg.panelSelector });
  // Outer instance sweeps in all 4 triggers — inner ones get aria-selected.
  assert.equal(document.getElementById("i0")!.hasAttribute("aria-selected"), true);
});

test("tabs pair with panels through aria-controls and listen on their own tablist", () => {
  document.body.innerHTML = `
<div data-nb-tabs id="manual">
  <div role="tablist" id="empty"></div>
  <div role="tablist">
    <button data-nb-tabs-trigger id="ta" aria-controls="pb">A</button>
    <button data-nb-tabs-trigger id="tb" aria-controls="pa">B</button>
  </div>
  <div data-nb-tabs-content id="pa">panel a</div>
  <div data-nb-tabs-content id="pb">panel b</div>
</div>`;
  const container = document.getElementById("manual")!;
  const instance = initTabs({ container, ...cfg });
  try {
    const panel = (id: string) => document.getElementById(id)!;
    // Panels are in the opposite order to their tabs.
    assert.equal(panel("ta").getAttribute("aria-controls"), "pb");
    assert.equal(panel("pb").getAttribute("aria-labelledby"), "ta");
    assert.equal(panel("pb").hidden, false);
    assert.equal(panel("pa").hidden, true);
    panel("tb").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(instance.currentIndex, 1);
    assert.equal(panel("tb").getAttribute("aria-selected"), "true");
    assert.equal(panel("pa").hidden, false);
    assert.equal(panel("pb").hidden, true);
  } finally {
    instance.destroy();
  }
});
