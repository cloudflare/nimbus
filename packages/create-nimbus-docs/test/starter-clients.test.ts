// The starter's component clients in a DOM: the dialog's backdrop, the sidebar
// filter, a dismissed banner and the copy-page button.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const UI = path.resolve(import.meta.dirname, "../../nimbus-starter-source/src/components/ui");
const CLIENT = JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../nimbus-docs/src/client/index.ts")).href);
const GLOBALS = ["window", "document", "HTMLElement", "HTMLDialogElement", "HTMLDetailsElement", "HTMLInputElement", "MutationObserver", "localStorage", "getComputedStyle"] as const;

/** A page of `html`, with the starter client at `file` (under ui/) loaded into it. */
async function page(t: test.TestContext, html: string, file?: string, beforeLoad?: (window: JSDOM["window"]) => void) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, { url: "https://example.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) g[name] = (dom.window as unknown as Record<string, unknown>)[name];
  t.after(() => {
    for (const name of GLOBALS) delete g[name];
    dom.window.close();
  });
  beforeLoad?.(dom.window);
  if (file) {
    const source = fs.readFileSync(path.join(UI, file), "utf8").replace(/from "@cloudflare\/nimbus-docs\/client";/, `from ${CLIENT};`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-starter-client-"));
    const target = path.join(dir, path.basename(file));
    fs.writeFileSync(target, source);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    await import(pathToFileURL(target).href);
  }
  return dom.window;
}

test("a text selection dragged onto the dialog's backdrop leaves it open; a backdrop click closes it", async (t) => {
  const window = await page(t, `<dialog data-dialog open><input></dialog>`, "dialog/dialog.client.ts", (w) => {
    // JSDOM has no dialog methods.
    w.HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  });
  const dialog = window.document.querySelector("dialog")!;
  const input = window.document.querySelector("input")!;
  input.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  dialog.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(dialog.open, true, "pressed in the input, released on the backdrop");
  dialog.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  dialog.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(dialog.open, false, "pressed and released on the backdrop");
});

test("the sidebar filter shows a matching nested group and the groups around it", async (t) => {
  const window = await page(
    t,
    `<nav data-nb-sidebar>
      <input data-nb-sidebar-filter-input>
      <details data-outer><summary>Guides</summary><ul>
        <li><a href="/intro/">Intro</a></li>
        <li><details data-inner><summary>Deployment</summary><ul><li><a href="/deploy/workers/">Workers</a></li></ul></details></li>
      </ul></details>
    </nav>`,
    "sidebar/sidebar.client.ts",
  );
  const input = window.document.querySelector("input")!;
  input.value = "deployment";
  input.dispatchEvent(new window.Event("input"));
  const outer = window.document.querySelector<HTMLDetailsElement>("[data-outer]")!;
  const inner = window.document.querySelector<HTMLDetailsElement>("[data-inner]")!;
  assert.equal(inner.hasAttribute("data-nb-sidebar-hidden"), false);
  assert.equal(outer.hasAttribute("data-nb-sidebar-hidden"), false, "its parent group shows too");
  assert.equal(outer.open, true);
  assert.equal(window.document.querySelector('a[href="/intro/"]')!.hasAttribute("data-nb-sidebar-hidden"), true);
});

const bannerScript = () => {
  const source = fs.readFileSync(path.join(UI, "banner/Banner.astro"), "utf8");
  return source.match(/<script is:inline data-astro-rerun>([\s\S]*?)<\/script>/)![1]!;
};
const banner = (key = true) =>
  `<div data-nb-banner-dismiss="sale" ${key ? 'data-nb-banner-key="nb-banner-dismissed-sale"' : ""}>Sale<button data-nb-banner-close></button></div>`;

test("a dismissed banner is gone before the client script runs, and an expired dismissal shows it again", () => {
  const parsed = new JSDOM(`<!DOCTYPE html><body>${banner()}<script>${bannerScript()}</script></body>`, {
    url: "https://example.com/",
    runScripts: "dangerously",
    beforeParse: (w) => w.localStorage.setItem("nb-banner-dismissed-sale", "0"),
  });
  assert.equal(parsed.window.document.querySelector("[data-nb-banner-dismiss]"), null, "removed while the page parses");

  const expired = new JSDOM(`<!DOCTYPE html><body>${banner()}<script>${bannerScript()}</script></body>`, {
    url: "https://example.com/",
    runScripts: "dangerously",
    beforeParse: (w) => w.localStorage.setItem("nb-banner-dismissed-sale", String(Date.now() - 1000)),
  });
  assert.ok(expired.window.document.querySelector("[data-nb-banner-dismiss]"), "an expired dismissal shows the banner");
  assert.equal(expired.window.localStorage.getItem("nb-banner-dismissed-sale"), null, "and forgets it");
});

test("the banner client still hides a dismissed banner from an older Banner.astro, and a close writes the key", async (t) => {
  const old = await page(t, banner(false), "banner/banner.client.ts", (w) => w.localStorage.setItem("nb-banner-dismissed-sale", "0"));
  assert.equal(old.document.querySelector("[data-nb-banner-dismiss]"), null);
});

test("closing a banner remembers it under its key", async (t) => {
  const window = await page(t, banner(), "banner/banner.client.ts");
  window.document.querySelector<HTMLButtonElement>("[data-nb-banner-close]")!.click();
  assert.equal(window.document.querySelector("[data-nb-banner-dismiss]"), null);
  assert.equal(window.localStorage.getItem("nb-banner-dismissed-sale"), "0");
});

test("a failed copy after a successful one shows the copy icon, not the check", async (t) => {
  let fail = false;
  const window = await page(
    t,
    `<div data-nb-page-actions data-md-url="/page.md">
      <button data-nb-page-actions-copy>
        <svg data-nb-page-actions-copy-icon></svg><svg data-nb-page-actions-check-icon class="hidden"></svg>
        <span data-nb-page-actions-label>Copy page</span>
      </button>
    </div>`,
    "page-actions/page-actions.client.ts",
    (w) => {
      Object.defineProperty(w.navigator, "clipboard", {
        value: { writeText: async () => { if (fail) throw new Error("denied"); } },
      });
      (globalThis as Record<string, unknown>).fetch = async () => ({ ok: true, text: async () => "# Page" });
      Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable: true });
      t.after(() => delete (globalThis as Record<string, unknown>).fetch);
    },
  );
  const button = window.document.querySelector<HTMLButtonElement>("[data-nb-page-actions-copy]")!;
  const copyIcon = window.document.querySelector("[data-nb-page-actions-copy-icon]")!;
  const checkIcon = window.document.querySelector("[data-nb-page-actions-check-icon]")!;
  const label = window.document.querySelector("[data-nb-page-actions-label]")!;
  const settle = () => new Promise((r) => setTimeout(r, 10));

  button.click();
  await settle();
  assert.equal(label.textContent, "Copied");
  assert.equal(checkIcon.classList.contains("hidden"), false);

  fail = true;
  button.click();
  await settle();
  assert.equal(label.textContent, "Couldn't copy");
  assert.equal(copyIcon.classList.contains("hidden"), false, "the copy icon shows");
  assert.equal(checkIcon.classList.contains("hidden"), true, "the check is gone");
});
