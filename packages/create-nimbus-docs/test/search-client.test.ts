import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const CLIENT = path.resolve(
  import.meta.dirname,
  "../../nimbus-starter-source/src/components/ui/search/search.client.ts",
);

// Loads the starter's `initSearch()` outside Vite: the imports it only needs
// for the dialog bootstrap are dropped, and the bootstrap itself is cut so
// nothing mounts on import.
async function loadInitSearch() {
  const source = fs.readFileSync(CLIENT, "utf8");
  const cut = source.indexOf("// Bootstrap");
  assert.ok(cut > 0, "search.client.ts still has its bootstrap section");
  const body = source
    .slice(0, source.lastIndexOf("\n//", cut))
    .replace(/^import \{ mount \}.*$/m, "")
    .replace(/^import \{ provider \}.*$/m, "")
    .replaceAll("import.meta.env.DEV", "false");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-search-client-"));
  const file = path.join(dir, "search.client.ts");
  fs.writeFileSync(file, body);
  return (await import(pathToFileURL(file).href)).initSearch as typeof import(
    "../../nimbus-starter-source/src/components/ui/search/search.client.ts"
  )["initSearch"];
}

test("a search still in flight never shows results after the input changes", async (t) => {
  const { window } = new JSDOM(
    `<input id="q"><div id="results" hidden></div><p id="empty"></p>`,
  );
  Object.assign(globalThis, { document: window.document });
  t.after(() => delete (globalThis as { document?: unknown }).document);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const initSearch = await loadInitSearch();
  const pending: Array<(titles: string[]) => void> = [];
  const input = window.document.querySelector("input")!;
  const results = window.document.getElementById("results")!;
  initSearch({
    input,
    resultsContainer: results,
    emptyState: window.document.getElementById("empty")!,
    provider: {
      search: (_query, { signal } = {}) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
          pending.push((titles) => resolve(titles.map((title) => ({ title, url: `/${title}/` }))));
        }),
    },
  });
  const type = async (value: string) => {
    input.value = value;
    input.dispatchEvent(new window.Event("input"));
    await new Promise(setImmediate);
  };
  const shown = () => results.querySelectorAll("[role='option']").length;

  await type("abc");
  mock.timers.tick(150);
  await new Promise(setImmediate);
  pending.shift()!(["first"]);
  await new Promise(setImmediate);
  assert.equal(shown(), 1);

  // Results on screen stay until the next search starts.
  await type("abcd");
  assert.equal(shown(), 1);
  mock.timers.tick(150);
  await new Promise(setImmediate);

  // Cleared before the debounce fires: the late response is dropped.
  await type("");
  pending.shift()!(["stale"]);
  await new Promise(setImmediate);
  assert.equal(shown(), 0);
  mock.timers.tick(150);
  assert.equal(shown(), 0);
});

test("each result and sub-result is its own option, named by its title, and links aren't Tab stops", async (t) => {
  const { window } = new JSDOM(`<input id="q"><div id="results" hidden></div><p id="empty"></p>`);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.assign(globalThis, { document: window.document });
  t.after(() => delete (globalThis as { document?: unknown }).document);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const initSearch = await loadInitSearch();
  const input = window.document.querySelector("input")!;
  const results = window.document.getElementById("results")!;
  initSearch({
    input,
    resultsContainer: results,
    emptyState: window.document.getElementById("empty")!,
    provider: {
      search: async () => [
        { title: "Install", url: "/install/", snippet: "Get <mark>started</mark>", subResults: [{ title: "Install", url: "/install/" }, { title: "Requirements", url: "/install/#req" }, { title: "Upgrade", url: "/install/#up" }] },
      ],
    },
  });
  input.value = "start";
  input.dispatchEvent(new window.Event("input"));
  mock.timers.tick(150);
  await new Promise(setImmediate);

  const options = [...results.querySelectorAll<HTMLElement>("[role='option']")];
  const name = (o: HTMLElement) => window.document.getElementById(o.getAttribute("aria-labelledby")!)!.textContent;
  assert.deepEqual(options.map(name), ["Install", "Requirements", "Upgrade"], "sub-results are options of their own, and the page's own entry isn't repeated");
  assert.ok(options.every((o) => o.querySelectorAll("a").length === 1), "one link per option");
  assert.ok([...results.querySelectorAll("a")].every((a) => a.getAttribute("tabindex") === "-1"), "no link is a Tab stop");
  assert.equal(window.document.getElementById(options[0]!.getAttribute("aria-describedby")!)!.textContent, "Get started");

  const key = (k: string) => {
    const event = new window.KeyboardEvent("keydown", { key: k, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(key("Home"), false, "with no option active, Home moves the caret");
  assert.equal(key("End"), false);
  key("ArrowDown");
  key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), options[1]!.id, "the arrow keys reach a sub-result");
  assert.equal(key("End"), true, "with an option active, End moves to the last");
  assert.equal(input.getAttribute("aria-activedescendant"), options[2]!.id);

  // Clearing the query leaves no option active, so Home and End move the caret.
  input.value = "";
  input.dispatchEvent(new window.Event("input"));
  mock.timers.tick(150);
  assert.equal(key("Home"), false, "after the query is cleared, Home moves the caret");
});
