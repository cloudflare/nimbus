/**
 * Tests for `choiceStateScript`, the serialized `restoreChoice` (with
 * `readUrlParam`) that shows a choice group's remembered panel before paint.
 * Each test runs the shipped script string in a fresh page, so a bundler
 * helper or import leaking into the serialized functions fails here, not in a
 * reader's browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { choiceStateScript } from "../src/runtime.ts";

const KEY = "nb-test__lang";

function group(panels: Array<[value: string, kind?: string]>, attrs = `data-nb-choice-param="lang"`): string {
  const options = panels.map(([v]) => `<option value="${v}">${v}</option>`).join("");
  const rows = panels
    .map(([v, kind], i) => `<div data-nb-choice-panel="${v}"${kind ? ` data-nb-choice-kind="${kind}"` : ""}${i ? " hidden" : ""}></div>`)
    .join("");
  return `<div data-nb-choice="${KEY}" ${attrs}><select data-nb-choice-select>${options}</select>${rows}</div>`;
}

function page(body: string, { url = "https://x.dev/a", saved }: { url?: string; saved?: string } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { url, runScripts: "outside-only" });
  if (saved) dom.window.localStorage.setItem(KEY, saved);
  dom.window.eval(choiceStateScript);
  return dom;
}

function shown(dom: JSDOM, g: Element = dom.window.document.querySelector("[data-nb-choice]")!): string {
  const visible = [...g.querySelectorAll<HTMLElement>(":scope > [data-nb-choice-panel]")].filter((p) => !p.hidden);
  assert.equal(visible.length, 1, "exactly one panel is visible");
  const value = visible[0]!.getAttribute("data-nb-choice-panel")!;
  assert.equal(g.querySelector<HTMLSelectElement>(":scope > [data-nb-choice-select]")!.value, value, "the control matches");
  return value;
}

const SAMPLES: Array<[string, string]> = [
  ["curl", "curl"],
  ["python", "python"],
  ["python-2", "python"],
];

test("is safe inside an inline <script>", () => {
  assert.doesNotMatch(choiceStateScript, /<\/script|<!--/i);
});

test("an exact param value wins, then the param's kind", () => {
  assert.equal(shown(page(group(SAMPLES), { url: "https://x.dev/a?lang=python-2", saved: "curl" })), "python-2");
  assert.equal(shown(page(group(SAMPLES), { url: "https://x.dev/a?lang=Python", saved: "curl" })), "python");
});

test("a param stranded in the fragment is read", () => {
  assert.equal(shown(page(group(SAMPLES), { url: "https://x.dev/a#op?lang=python-2" })), "python-2");
});

test("an unknown param falls back to the saved kind, then the server's choice", () => {
  assert.equal(shown(page(group(SAMPLES), { url: "https://x.dev/a?lang=nope", saved: "PYTHON" })), "python");
  assert.equal(shown(page(group(SAMPLES), { url: "https://x.dev/a?lang=nope" })), "curl");
});

test("the param is ignored unless the group names one", () => {
  assert.equal(shown(page(group(SAMPLES, ""), { url: "https://x.dev/a?lang=python" })), "curl");
});

test("a panel's kind defaults to its value", () => {
  assert.equal(shown(page(group([["npm"], ["pnpm"]]), { saved: "pnpm" })), "pnpm");
});

test("kinds match case-insensitively in the markup too", () => {
  assert.equal(shown(page(group([["a", "Python"], ["b", "CURL"]]), { saved: "curl" })), "b");
});

test("an empty param is ignored", () => {
  assert.equal(shown(page(group(SAMPLES), { url: "https://x.dev/a?lang=", saved: "python" })), "python");
});

test("a group without a select still shows its panel", () => {
  const dom = page(group(SAMPLES).replace(/<select.*<\/select>/, ""), { saved: "python" });
  const visible = [...dom.window.document.querySelectorAll<HTMLElement>("[data-nb-choice-panel]")].filter((p) => !p.hidden);
  assert.deepEqual(visible.map((p) => p.getAttribute("data-nb-choice-panel")), ["python"]);
});

test("a group's select is its own, not a nested group's", () => {
  const inner = group([["a"], ["b"]]).replace(KEY, "nb-test__inner");
  const dom = page(group(SAMPLES).replace("<select", `${inner}<select`), { saved: "python" });
  assert.equal(shown(dom), "python");
  assert.equal(shown(dom, dom.window.document.querySelector("[data-nb-choice] [data-nb-choice]")!), "a");
});

test("a group still being parsed waits for its own script", () => {
  const inner = group([["a"], ["b"]]).replace(KEY, "nb-test__inner");
  const tag = `<script>${choiceStateScript}</script>`;
  const outer = group(SAMPLES).replace("</select>", `</select>${inner}${tag}`);
  const dom = new JSDOM(`<!DOCTYPE html><body>${outer}${tag}</body>`, { url: "https://x.dev/a?lang=python", runScripts: "dangerously" });
  assert.equal(shown(dom), "python");
});

test("a nested group is left to its own key", () => {
  const inner = group([["a"], ["b"]]).replace(KEY, "nb-test__inner");
  const dom = page(group(SAMPLES).replace("</select>", `</select>${inner}`), { saved: "python" });
  assert.equal(shown(dom), "python");
  assert.equal(shown(dom, dom.window.document.querySelector("[data-nb-choice] [data-nb-choice]")!), "a");
});

test("storage that throws leaves the server's choice", () => {
  const dom = new JSDOM(`<!DOCTYPE html><body>${group(SAMPLES)}</body>`, { url: "https://x.dev/a", runScripts: "outside-only" });
  Object.defineProperty(dom.window, "localStorage", { get: () => { throw new Error("blocked"); } });
  dom.window.eval(choiceStateScript);
  assert.equal(shown(dom), "curl");
});

test("restores each group once, and a swapped-in group before paint", () => {
  const dom = page(group(SAMPLES), { saved: "python" });
  const { document } = dom.window;
  document.querySelector<HTMLSelectElement>("[data-nb-choice-select]")!.value = "curl";
  dom.window.eval(choiceStateScript);
  assert.equal(document.querySelector<HTMLSelectElement>("[data-nb-choice-select]")!.value, "curl", "not restored twice");

  let swaps = 0;
  const add = document.addEventListener.bind(document);
  document.addEventListener = ((name: string, fn: EventListener) => {
    if (name === "astro:after-swap") swaps++;
    add(name, fn);
  }) as typeof document.addEventListener;
  dom.window.eval(choiceStateScript);
  assert.equal(swaps, 0, "binds the swap listener once per window");

  document.body.innerHTML = group(SAMPLES);
  document.dispatchEvent(new dom.window.Event("astro:after-swap"));
  assert.equal(shown(dom), "python");
});
