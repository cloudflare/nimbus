// Tests the markdown pipeline-extension seam and the `nimbus-docs/markdown`
// exports by driving `satteri({ hastPlugins, mdastPlugins })` directly — the
// same construction the integration wires from the markdown options.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { satteri } from "@astrojs/markdown-satteri";
import { externalLinks, titleFigure } from "../src/markdown/index.ts";

async function renderWith(
  md: string,
  opts: Parameters<typeof satteri>[0] = {},
  shared: Record<string, unknown> = { syntaxHighlight: false },
): Promise<string> {
  const renderer = await satteri(opts).createRenderer(shared);
  const { code } = await renderer.render(md, { frontmatter: {} });
  return code;
}

describe("seam: hastPlugins passthrough + back-compat", () => {
  test("empty plugin arrays are equivalent to bare satteri()", async () => {
    const bare = await renderWith("# Title\n\ntext", undefined);
    const empty = await renderWith("# Title\n\ntext", {
      hastPlugins: [],
      mdastPlugins: [],
    });
    assert.equal(empty, bare);
  });

  test("a supplied hast plugin reaches the processor and mutates output", async () => {
    const tag = {
      name: "test:stamp",
      element: {
        filter: ["p"],
        // Mutations go through ctx (Sätteri's arena lives in Rust; direct
        // JS-object mutation does not persist).
        visit(node: unknown, ctx: { setProperty(n: unknown, k: string, v: unknown): void }) {
          ctx.setProperty(node, "data-stamped", "1");
        },
      },
    };
    const html = await renderWith("hello", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hastPlugins: [tag as any],
    });
    assert.match(html, /<p data-stamped="1">hello<\/p>/);
  });

  test("a supplied mdast plugin reaches the processor and mutates output", async () => {
    // mdast plugins use node-type visitors (heading, paragraph, …) + ctx.
    const demote = {
      name: "test:demote",
      heading(node: unknown, ctx: { setProperty(n: unknown, k: string, v: unknown): void }) {
        ctx.setProperty(node, "depth", 4);
      },
    };
    const html = await renderWith("# Title", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mdastPlugins: [demote as any],
    });
    assert.match(html, /<h4[^>]*>Title<\/h4>/);
    assert.ok(!html.includes("<h1"));
  });

  test("a full processor override takes precedence (plugins ignored)", () => {
    // Mirrors integration.ts: `options.markdown?.processor ?? satteri({…})`.
    // A supplied processor short-circuits, so the plugin arrays never apply.
    const custom = { name: "custom" };
    const sentinelPlugin = { name: "should-not-run", element: { filter: ["p"], visit() {} } };
    const resolved =
      (custom as unknown) ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      satteri({ hastPlugins: [sentinelPlugin as any] });
    assert.equal(resolved, custom);
  });

  test("Astro-native smartypants flows through (no Nimbus knob)", async () => {
    // No `features` set by the seam → shared `smartypants` governs.
    const on = await renderWith(`"q" -- x...`, { hastPlugins: [] }, {
      syntaxHighlight: false,
    });
    const off = await renderWith(`"q" -- x...`, { hastPlugins: [] }, {
      syntaxHighlight: false,
      smartypants: false,
    });
    assert.match(on, /[“”–…]/); // smart punctuation by default
    assert.match(off, /"q" -- x\.\.\./); // straight when shared flag is false
  });
});

describe("externalLinks() export", () => {
  const render = (md: string) =>
    renderWith(md, { hastPlugins: [externalLinks()] });

  test("decorates an external link with target/rel + arrow span", async () => {
    const html = await render("[foo](https://example.com)");
    assert.match(
      html,
      /<a href="https:\/\/example\.com" target="_blank" rel="noopener">foo<span class="external-link"> ↗<\/span><\/a>/,
    );
  });

  test("leaves internal links untouched", async () => {
    const html = await render("[foo](/)");
    assert.match(html, /<a href="\/">foo<\/a>/);
    assert.ok(!html.includes("external-link"));
  });

  test("no arrow when the link wraps an image", async () => {
    const html = await render("[![](/i.jpg)](https://example.com)");
    assert.ok(html.includes(`target="_blank"`));
    assert.ok(!html.includes("external-link"));
  });

  test("internalHosts option suppresses decoration", async () => {
    const html = await renderWith("[foo](https://docs.me/x)", {
      hastPlugins: [externalLinks({ internalHosts: ["docs.me"] })],
    });
    assert.match(html, /<a href="https:\/\/docs\.me\/x">foo<\/a>/);
    assert.ok(!html.includes("external-link"));
  });
});

describe("titleFigure() export", () => {
  const render = (md: string) =>
    renderWith(md, { hastPlugins: [titleFigure()] });

  test("wraps a titled standalone image in figure + figcaption", async () => {
    const html = await render(`![alt](/i.jpg "my cap")`);
    assert.match(
      html,
      /<figure><img src="\/i\.jpg" alt="alt" title="my cap"><figcaption>my cap<\/figcaption><\/figure>/,
    );
  });

  test("leaves an untitled image uncaptioned", async () => {
    const html = await render(`![alt](/i.jpg)`);
    assert.ok(!html.includes("<figure>"));
    assert.ok(html.includes(`<img src="/i.jpg" alt="alt">`));
  });

  test("optional class config", async () => {
    const html = await renderWith(`![a](/i.jpg "c")`, {
      hastPlugins: [titleFigure({ figureClass: "nb-fig" })],
    });
    assert.match(html, /<figure class="nb-fig">/);
  });
});
