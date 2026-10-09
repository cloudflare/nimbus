// Tests the pure full-documentation collation behind `renderLlmsFullMarkdown()` /
// `llms-full.txt`: deterministic ordering, `#`-level block shape, header
// cross-reference, and URL absolutization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildLlmsFullMarkdown,
  type LlmsFullBlock,
} from "../src/_internal/llms-full.ts";

const HEADER = {
  title: "Acme Docs",
  description: "Documentation for Acme.",
  site: "https://docs.acme.dev",
};

function block(overrides: Partial<LlmsFullBlock>): LlmsFullBlock {
  return {
    title: "Page",
    description: undefined,
    url: "/page/",
    markdownUrl: "/page/index.md",
    markdown: "## Section\n\nBody text.",
    ...overrides,
  };
}

describe("buildLlmsFullMarkdown", () => {
  test("sorts blocks by url regardless of input order", () => {
    const out = buildLlmsFullMarkdown(
      [
        block({ title: "Zulu", url: "/zulu/" }),
        block({ title: "Alpha", url: "/alpha/" }),
        block({ title: "Mid", url: "/mid/" }),
      ],
      HEADER,
    );
    const zulu = out.indexOf("# Zulu");
    const alpha = out.indexOf("# Alpha");
    const mid = out.indexOf("# Mid");
    assert.ok(alpha !== -1 && mid !== -1 && zulu !== -1);
    assert.ok(alpha < mid && mid < zulu);
  });

  test("sorts non-ASCII URLs without locale-dependent collation", () => {
    const out = buildLlmsFullMarkdown(
      [
        block({ title: "Aether", url: "/äther/" }),
        block({ title: "Zulu", url: "/zulu/" }),
        block({ title: "Alpha", url: "/Alpha/" }),
      ],
      HEADER,
    );
    assert.ok(out.indexOf("# Alpha") < out.indexOf("# Zulu"));
    assert.ok(out.indexOf("# Zulu") < out.indexOf("# Aether"));
  });

  test("is deterministic: same input set yields identical bytes", () => {
    const blocks = [
      block({ title: "B", url: "/b/" }),
      block({ title: "A", url: "/a/" }),
    ];
    const a = buildLlmsFullMarkdown(blocks, HEADER);
    const b = buildLlmsFullMarkdown([...blocks].reverse(), HEADER);
    assert.equal(a, b);
  });

  test("header opens with the site title and cross-references /llms.txt", () => {
    const out = buildLlmsFullMarkdown([], HEADER);
    assert.ok(out.startsWith("# Acme Docs\n"));
    assert.ok(out.includes("> Documentation for Acme."));
    assert.ok(out.includes("Index: https://docs.acme.dev/llms.txt"));
  });

  test("absolutizes URLs against site; stays relative without one", () => {
    const blocks = [block({ url: "/guide/", markdownUrl: "/guide/index.md" })];
    const abs = buildLlmsFullMarkdown(blocks, HEADER);
    assert.ok(
      abs.includes(
        "Source: https://docs.acme.dev/guide/ · Markdown: https://docs.acme.dev/guide/index.md",
      ),
    );
    const rel = buildLlmsFullMarkdown(blocks, { title: "Acme Docs" });
    assert.ok(rel.includes("Source: /guide/ · Markdown: /guide/index.md"));
    assert.ok(rel.includes("Index: /llms.txt"));
  });

  test("prefixes absolute full-documentation URLs with the deployment base", () => {
    const out = buildLlmsFullMarkdown(
      [block({ url: "/guide/", markdownUrl: "/guide/index.md" })],
      { ...HEADER, base: "/docs/" },
    );
    assert.ok(out.includes("Index: https://docs.acme.dev/docs/llms.txt"));
    assert.ok(
      out.includes(
        "Source: https://docs.acme.dev/docs/guide/ · Markdown: https://docs.acme.dev/docs/guide/index.md",
      ),
    );
    const relative = buildLlmsFullMarkdown([], {
      title: "Acme Docs",
      base: "/docs/",
    });
    assert.ok(relative.includes("Index: /docs/llms.txt"));
  });

  test("applies the base to logical paths that share its first segment", () => {
    const out = buildLlmsFullMarkdown(
      [block({ url: "/docs/guide/", markdownUrl: "/docs/guide/index.md" })],
      { ...HEADER, base: "/docs" },
    );
    assert.ok(
      out.includes(
        "Source: https://docs.acme.dev/docs/docs/guide/ · Markdown: https://docs.acme.dev/docs/docs/guide/index.md",
      ),
    );
  });

  test("omits the description blockquote when absent — no empty lines", () => {
    const out = buildLlmsFullMarkdown(
      [block({ title: "NoDesc", description: undefined })],
      { title: "T" },
    );
    assert.ok(out.includes("# NoDesc\n\nSource: "));
    const withDesc = buildLlmsFullMarkdown(
      [block({ title: "HasDesc", description: "About this." })],
      { title: "T" },
    );
    assert.ok(withDesc.includes("# HasDesc\n\n> About this.\n\nSource: "));
  });

  test("every block appears exactly once", () => {
    const out = buildLlmsFullMarkdown(
      [
        block({ title: "One", url: "/one/" }),
        block({ title: "Two", url: "/two/" }),
      ],
      HEADER,
    );
    assert.equal(out.match(/^# One$/gm)?.length, 1);
    assert.equal(out.match(/^# Two$/gm)?.length, 1);
  });
});
