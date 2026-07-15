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
