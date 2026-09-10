// The generated-Markdown half of citation resolution: `renderEntryAsMarkdown`
// resolves `api.ref:` citations against a supplied citation index (derived mode,
// never build-fails), and fails loud when a body carries citations but no
// citation index was passed — the alternative is a raw sentinel leaking into the served
// markdown.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderEntryAsMarkdown } from "../src/_internal/transform.js";

const index = new Map<string, string>([
  ["zones:createZone", "/api/zones/create-zone"],
]);

describe("renderEntryAsMarkdown: coordinate citations", () => {
  test("resolves a citation against the citation index", () => {
    const out = renderEntryAsMarkdown(
      { body: "See [create a zone](api.ref:zones:createZone) first." },
      { citationIndex: index },
    );
    assert.match(out, /\[create a zone\]\(\/api\/zones\/create-zone\)/);
    assert.doesNotMatch(out, /api\.ref:/);
  });

  test("derived mode: an unresolved citation degrades to # without throwing", () => {
    const out = renderEntryAsMarkdown(
      { body: "See [gone](api.ref:zones:removedOp)." },
      { citationIndex: index },
    );
    assert.match(out, /\[gone\]\(#\)/);
  });

  test("fails loud when a citation is present but no citation index is passed", () => {
    assert.throws(
      () => renderEntryAsMarkdown({ body: "[x](api.ref:zones:createZone)" }),
      /no citation index/,
    );
  });

  test("no citation, no citation index: renders normally", () => {
    const out = renderEntryAsMarkdown({ body: "Plain **prose** only." });
    assert.match(out, /\*\*prose\*\*/);
  });

  test("leaves a citation inside a code fence untouched", () => {
    const out = renderEntryAsMarkdown(
      { body: "```md\n[x](api.ref:zones:createZone)\n```" },
      { citationIndex: index },
    );
    assert.match(out, /api\.ref:zones:createZone/);
  });

  test("rejects runtime partial expansion with migration guidance", () => {
    assert.throws(
      () => renderEntryAsMarkdown({ body: '<Render file="shared" />' }),
      /getMarkdownPayload/,
    );
    assert.doesNotThrow(() =>
      renderEntryAsMarkdown({ body: '```mdx\n<Render file="example" />\n```' }),
    );
  });
});

test("Aside exports use the plain title and preserve body content and custom renderers", () => {
  const children = [
    '<span slot="title-content"><code>Age</code> response header</span>',
    '<span>Body 😀.</span>',
    '<span><span slot="title-content">Nested content.</span></span>',
    '<span slot="other">Other slot.</span>',
    "",
    "```mdx",
    '<span slot="title-content">Literal example.</span>',
    "```",
  ].join("\n");
  const body = `前文 😀.\n\n<Aside title="Age response header">\n${children}\n</Aside>`;
  const out = renderEntryAsMarkdown({ filePath: "page.mdx", body });
  assert.match(out, /^前文 😀\./);
  assert.equal(out.match(/Age response header/g)?.length, 1);
  assert.doesNotMatch(out, /<code>Age<\/code>/);
  assert.match(out, /<span>Body 😀\.<\/span>/);
  assert.match(out, /<span slot="title-content">Nested content\.<\/span>/);
  assert.match(out, /<span slot="other">Other slot\.<\/span>/);
  assert.match(out, /<span slot="title-content">Literal example\.<\/span>/);

  let customChildren = "";
  renderEntryAsMarkdown(
    { filePath: "page.mdx", body },
    { componentMap: { Aside: ({ children }) => (customChildren = children) } },
  );
  assert.match(customChildren, /<code>Age<\/code>/);
  assert.equal(renderEntryAsMarkdown({ filePath: "page.md", body }), body);
});
