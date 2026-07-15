/**
 * code-transformers.test.ts — guards Expressive-Code (EC) fence-meta parity.
 *
 * Each case highlights a small fixture THROUGH `defaultCodeTransformers()`
 * (via shiki's `codeToHtml`) and asserts the emitted HTML/HAST classes. These
 * assertions fail against the stock `transformerMetaHighlight` /
 * `transformerMetaWordHighlight` behaviour (spaced ranges ignored, `ins={}`
 * hijacked as a plain highlight, `"word"` never matched) and pass after the
 * Nimbus meta transformer takes over. See `_internal/code-transformers.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { codeToHtml } from "shiki";
import {
  defaultCodeTransformers,
  parseNimbusMeta,
} from "../src/_internal/code-transformers.ts";
import {
  clearCodeStyleRegistry,
  getCodeStyleCSS,
  shouldClassShikiTokens,
} from "../src/_internal/code-style-registry.ts";

const THEME = "github-light";

/** Render `code` with the given fence-meta through the Nimbus chain. */
async function render(code: string, meta: string, lang = "ts"): Promise<string> {
  return codeToHtml(code, {
    lang,
    theme: THEME,
    meta: { __raw: meta },
    transformers: defaultCodeTransformers(),
  });
}

/** Parse rendered HTML and return the per-line <span class="line"> elements. */
function lines(html: string): Element[] {
  const { document } = new JSDOM(html).window;
  return Array.from(document.querySelectorAll("pre code .line"));
}

/** 1-based set of line numbers carrying `cls`. */
function linesWith(html: string, cls: string): number[] {
  const out: number[] = [];
  lines(html).forEach((el, i) => {
    if (el.classList.contains(cls)) out.push(i + 1);
  });
  return out;
}

const NUMBERED = Array.from({ length: 42 }, (_, i) => `const l${i + 1} = ${i + 1};`).join(
  "\n",
);
const SMALL = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;";

// ---------------------------------------------------------------------------
// Pure parser precedence.
// ---------------------------------------------------------------------------

test("parser: bare braces are space-tolerant", () => {
  const a = parseNimbusMeta("{5-16, 21-40}");
  const b = parseNimbusMeta("{5-16,21-40}");
  assert.deepEqual([...a.highlightLines].sort((x, y) => x - y), [...b.highlightLines].sort((x, y) => x - y));
  assert.ok(a.highlightLines.has(5) && a.highlightLines.has(16) && a.highlightLines.has(21) && a.highlightLines.has(40));
  assert.ok(!a.highlightLines.has(17) && !a.highlightLines.has(20));
});

test("parser: ins/del braces never become plain highlights", () => {
  const m = parseNimbusMeta('del={2} ins={3}');
  assert.deepEqual([...m.delLines], [2]);
  assert.deepEqual([...m.insLines], [3]);
  assert.equal(m.highlightLines.size, 0, "ins/del braces must NOT leak into highlightLines");
});

test("parser: collapse braces are neutral, not highlights", () => {
  const m = parseNimbusMeta("collapse={2-4}");
  assert.deepEqual([...m.collapseLines].sort((x, y) => x - y), [2, 3, 4]);
  assert.equal(m.highlightLines.size, 0);
});

test("parser: quoted forms and wrap keyword", () => {
  const m = parseNimbusMeta('title="src/x.ts" ins="TOKEN" del="OLD" "needle" wrap');
  assert.deepEqual(m.insTokens, ["TOKEN"]);
  assert.deepEqual(m.delTokens, ["OLD"]);
  assert.deepEqual(m.searchWords, ["needle"]);
  assert.equal(m.wrap, true);
});

// ---------------------------------------------------------------------------
// Acceptance criteria, proven through rendered HTML.
// ---------------------------------------------------------------------------

// AC1 — title
test("AC1 title= → figcaption.nb-code-title", async () => {
  const html = await render(SMALL, 'title="src/foo.ts"');
  const { document } = new JSDOM(html).window;
  const cap = document.querySelector("figure.nb-code-figure-titled figcaption.nb-code-title");
  assert.ok(cap, "figcaption.nb-code-title present");
  assert.match(cap!.textContent ?? "", /src\/foo\.ts/);
});

// AC2 — {2-3} and {1,3-5}
test("AC2 {2-3} highlights lines 2,3", async () => {
  const html = await render(SMALL, "{2-3}");
  assert.deepEqual(linesWith(html, "highlighted"), [2, 3]);
});

test("AC2 {1,3-5} highlights lines 1,3,4,5", async () => {
  const html = await render(NUMBERED, "{1,3-5}");
  assert.deepEqual(linesWith(html, "highlighted"), [1, 3, 4, 5]);
});

// AC3 — spaced ranges match the no-space form
test("AC3 {5-16, 21-40} (spaced) == no-space form", async () => {
  const spaced = linesWith(await render(NUMBERED, "{5-16, 21-40}"), "highlighted");
  const tight = linesWith(await render(NUMBERED, "{5-16,21-40}"), "highlighted");
  assert.deepEqual(spaced, tight);
  assert.ok(spaced.includes(5) && spaced.includes(16) && spaced.includes(21) && spaced.includes(40));
  assert.ok(!spaced.includes(17) && !spaced.includes(20));
});

// AC4 — wrap
test("AC4 wrap → data-nb-wrap on pre and figure", async () => {
  const html = await render(SMALL, "wrap");
  const { document } = new JSDOM(html).window;
  assert.ok(document.querySelector("pre[data-nb-wrap]"), "pre[data-nb-wrap]");
  assert.ok(document.querySelector("figure[data-nb-wrap]"), "figure[data-nb-wrap]");
});

// AC5 — ins={3} / del={2}
test("AC5 ins={3} → line 3 diff add", async () => {
  const html = await render(SMALL, "ins={3}");
  assert.deepEqual(linesWith(html, "diff"), [3]);
  assert.deepEqual(linesWith(html, "add"), [3]);
});

test("AC5 del={2} → line 2 diff remove", async () => {
  const html = await render(SMALL, "del={2}");
  assert.deepEqual(linesWith(html, "diff"), [2]);
  assert.deepEqual(linesWith(html, "remove"), [2]);
});

// AC6 — ins="TOKEN" / del="TOKEN"
test('AC6 ins="TOKEN" → matching lines diff add', async () => {
  const code = "const keep = 1;\nconst TOKEN = 2;\nconst alsoTOKEN = 3;\nconst other = 4;";
  const html = await render(code, 'ins="TOKEN"');
  assert.deepEqual(linesWith(html, "add"), [2, 3]);
  assert.deepEqual(linesWith(html, "highlighted"), []);
});

test('AC6 del="TOKEN" → matching line diff remove', async () => {
  const code = "const keep = 1;\nconst TOKEN = 2;\nconst other = 3;";
  const html = await render(code, 'del="TOKEN"');
  assert.deepEqual(linesWith(html, "remove"), [2]);
});

// AC7 — del={2} ins={3}, order-independent
test("AC7 del={2} ins={3} → line2 remove, line3 add", async () => {
  const html = await render(SMALL, "del={2} ins={3}");
  assert.deepEqual(linesWith(html, "remove"), [2]);
  assert.deepEqual(linesWith(html, "add"), [3]);
});

test("AC7 ins={3} del={2} (reversed) → same result", async () => {
  const html = await render(SMALL, "ins={3} del={2}");
  assert.deepEqual(linesWith(html, "remove"), [2]);
  assert.deepEqual(linesWith(html, "add"), [3]);
});

// AC8 — "needle"
test('AC8 "needle" → highlighted-word spans', async () => {
  const code = 'const x = findThe("needle");\nconst y = 2;\nconst z = "needle";';
  const html = await render(code, '"needle"');
  const { document } = new JSDOM(html).window;
  const words = document.querySelectorAll("span.highlighted-word");
  assert.ok(words.length >= 2, `expected >=2 highlighted-word spans, got ${words.length}`);
  for (const w of words) assert.equal(w.textContent, "needle");
});

// AC9 — collapse={2-4} → no false highlight
test("AC9 collapse={2-4} → lines 2-4 NOT highlighted", async () => {
  const html = await render(SMALL, "collapse={2-4}");
  assert.deepEqual(linesWith(html, "highlighted"), [], "no false highlight on collapse lines");
  assert.deepEqual(linesWith(html, "diff"), []);
});

// AC10 — notation // [!code highlight]
test("AC10 // [!code highlight] → line highlighted, comment stripped", async () => {
  const code = "const x = 1; // [!code highlight]\nconst y = 2;";
  const html = await render(code, "");
  assert.deepEqual(linesWith(html, "highlighted"), [1]);
  const { document } = new JSDOM(html).window;
  assert.ok(!(document.querySelector("pre code")!.textContent ?? "").includes("[!code highlight]"), "notation comment stripped");
});

// AC11 — no meta leak into code text or lang badge
test("AC11 meta does not leak into rendered code or lang badge", async () => {
  const html = await render(SMALL, 'title="src/foo.ts" {2-3} ins={4} "needle" wrap');
  const { document } = new JSDOM(html).window;
  const codeText = document.querySelector("pre code")!.textContent ?? "";
  for (const leak of ['title="', "ins={", "{2-3}", "wrap", '"needle"']) {
    assert.ok(!codeText.includes(leak), `meta token "${leak}" must not appear in code text`);
  }
  // data-nb-lang reflects the language, not the meta string.
  assert.equal(document.querySelector("pre")!.getAttribute("data-nb-lang"), "ts");
});

test("classTokens converts default dual-theme token styles to shared classes", async () => {
  clearCodeStyleRegistry();
  const html = await codeToHtml("const value = 1;", {
    lang: "ts",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    transformers: defaultCodeTransformers({ classTokens: true }),
  });

  assert.match(html, /class="[^"]*nb-shiki-/);
  assert.doesNotMatch(html, /style="[^"]*--shiki/);
  assert.match(getCodeStyleCSS(), /\.nb-shiki-[^{]+\{[^}]*--shiki-light:/);
  assert.match(getCodeStyleCSS(), /--shiki-dark:/);
});

test("clearCodeStyleRegistry empties generated CSS", async () => {
  clearCodeStyleRegistry();
  await codeToHtml("const value = 1;", {
    lang: "ts",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    transformers: defaultCodeTransformers({ classTokens: true }),
  });
  assert.notEqual(getCodeStyleCSS(), "");
  clearCodeStyleRegistry();
  assert.equal(getCodeStyleCSS(), "");
});

test("defaultCodeTransformers without classTokens preserves inline styles", async () => {
  clearCodeStyleRegistry();
  const html = await codeToHtml("const value = 1;", {
    lang: "ts",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    transformers: defaultCodeTransformers(),
  });

  assert.doesNotMatch(html, /nb-shiki-/);
  assert.match(html, /style="[^"]*--shiki/);
  assert.equal(getCodeStyleCSS(), "");
});

test("beforeTitleTransformers run before style classing and title wrapping", async () => {
  clearCodeStyleRegistry();
  const html = await codeToHtml("const value = 1;", {
    lang: "ts",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    transformers: defaultCodeTransformers({
      classTokens: true,
      beforeTitleTransformers: [
        {
          name: "test:pre-style",
          pre(node) {
            node.properties = node.properties ?? {};
            node.properties.style = "--test-pre-style:1";
          },
        },
      ],
    }),
  });

  const { document } = new JSDOM(html).window;
  const pre = document.querySelector("figure.nb-code-figure pre")!;
  assert.ok(pre.className.includes("nb-shiki-"));
  assert.equal(pre.getAttribute("style"), null);
  assert.match(getCodeStyleCSS(), /--test-pre-style:1/);
});

test("shouldClassShikiTokens only allows the default dual-theme contract", () => {
  assert.equal(shouldClassShikiTokens(undefined), true);
  assert.equal(shouldClassShikiTokens({}), true);
  assert.equal(shouldClassShikiTokens({ themes: {} }), true);
  assert.equal(shouldClassShikiTokens({ theme: "github-dark" }), true);
  assert.equal(
    shouldClassShikiTokens({
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    }),
    true,
  );
  assert.equal(shouldClassShikiTokens({ theme: "dracula" }), false);
  assert.equal(
    shouldClassShikiTokens({ themes: { light: "min-light", dark: "github-dark" } }),
    false,
  );
  assert.equal(shouldClassShikiTokens({ defaultColor: "light" }), false);
});
