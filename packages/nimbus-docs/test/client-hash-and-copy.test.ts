/**
 * Tests for two reader-facing client helpers: a parameter link scrolls once,
 * and only when opening a collapsed parent moved its target; the copy button
 * comes before its code in Tab order and still copies the code.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { JSDOM } from "jsdom";

import { initDisclosureGroup } from "../src/client/disclosure-group.js";
import { codeCopy } from "../src/client/code-copy.js";

let dom: JSDOM;
const scrolls: ScrollIntoViewOptions[] = [];

before(() => {
  dom = new JSDOM("<!DOCTYPE html><body></body>", {
    pretendToBeVisual: true,
    url: "https://example.test/api/op/",
  });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLDetailsElement = dom.window.HTMLDetailsElement;
  g.Element = dom.window.Element;
  g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  dom.window.Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
    scrolls.push(options as ScrollIntoViewOptions);
  };
});

const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve));

async function openHash(hash: string, html: string) {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  scrolls.length = 0;
  location.hash = hash;
  const group = initDisclosureGroup({ root: document.getElementById("root")!, deepLink: true });
  await frame();
  group.destroy();
  return document.getElementById(hash.slice(1))!;
}

test("a hash to a field in a closed parent opens it and scrolls once to the field's top", async () => {
  const field = await openHash(
    "#body.name",
    `<details><summary>body</summary><div id="body.name">name</div></details>`,
  );
  assert.equal(field.closest("details")!.open, true);
  assert.deepEqual(scrolls, [{ block: "start" }]);
  assert.equal(document.activeElement, field);
});

test("a hash to a visible field doesn't scroll again", async () => {
  await openHash("#body.id", `<div id="body.id">id</div>`);
  assert.deepEqual(scrolls, []);
});

test("a hash to a field whose only closed <details> is its own doesn't scroll again", async () => {
  const field = await openHash(
    "#body.meta",
    `<div id="body.meta"><details><summary>meta</summary>children</details></div>`,
  );
  assert.equal(field.querySelector("details")!.open, true);
  assert.deepEqual(scrolls, []);
});

test("the copy button comes before its code and copies the code's text", async () => {
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
  });
  document.body.innerHTML = `
    <figure class="nb-code-figure"><figcaption>app.ts</figcaption><pre class="astro-code"><code>const a = 1;</code></pre></figure>
    <pre class="astro-code"><code>npm i</code></pre>`;
  codeCopy();
  const [figure, bare] = [document.querySelector("figure")!, document.querySelector("body > pre")!];
  assert.equal(figure.firstElementChild!.className, "nb-code-copy");
  assert.equal(bare.firstElementChild!.className, "nb-code-copy");
  (figure.firstElementChild as HTMLElement).click();
  (bare.firstElementChild as HTMLElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(copied, ["const a = 1;", "npm i"]);
});
