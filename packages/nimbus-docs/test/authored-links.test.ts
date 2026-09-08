import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeAuthoredLinks } from "../src/_internal/authored-links.ts";

test("normalizes authored Markdown and static JSX links", () => {
  const source = `[Root](/)
[Guide](/guide?view=all#top)
[Collision](/docs/guide)
[External](https://example.com)
[Protocol](//cdn.example.com/x)
[Relative](../guide)
[Anchor](#top)

[Guide ref][guide]

[guide]: /guide "Guide"

<a HREF="/native">Native</a>
<Card href='/card' />
<Card href={"/expression"} />
<Card href={("/parenthesized")} />
<Card href={\`/template\`} />
<Card href={"/" + "joined"} />
<Card href={/* fixed */ "/commented"} />
<Card href={true ? "/conditional" : "/other"} />
<Card href={(void 0, "/sequence")} />
<Card href={"\\u002fescaped"} />
<Card href={destination} />
<Card {...{ pattern: /}/ }} href="/after-spread" />
<Card before={{.../}/}} href={"/after-regex-spread"} />

\`[Code](/unchanged)\`

\`\`\`md
[Fence](/unchanged)
\`\`\`
`;

  const transformed = normalizeAuthoredLinks(source, {
    base: "/docs/",
    sourceId: "guide.mdx",
  });
  assert.match(transformed, /\[Root\]\(\/docs\/\)/);
  assert.match(transformed, /\[Guide\]\(\/docs\/guide\?view=all#top\)/);
  assert.match(transformed, /\[Collision\]\(\/docs\/docs\/guide\)/);
  assert.match(transformed, /\[guide\]: \/docs\/guide "Guide"/);
  assert.match(transformed, /HREF="\/docs\/native"/);
  assert.match(transformed, /href='\/docs\/card'/);
  assert.match(transformed, /href=\{"\/docs\/expression"\}/);
  assert.match(transformed, /href=\{\("\/docs\/parenthesized"\)\}/);
  assert.match(transformed, /href=\{`\/docs\/template`\}/);
  assert.match(transformed, /href=\{"\/docs\/" \+ "joined"\}/);
  assert.match(transformed, /href=\{\/\* fixed \*\/ "\/docs\/commented"\}/);
  assert.match(
    transformed,
    /href=\{true \? "\/docs\/conditional" : "\/other"\}/,
  );
  assert.match(transformed, /href=\{\(void 0, "\/docs\/sequence"\)\}/);
  assert.match(transformed, /href=\{"\/docs\\u002fescaped"\}/);
  assert.match(transformed, /href=\{destination\}/);
  assert.match(transformed, /href="\/docs\/after-spread"/);
  assert.match(transformed, /href=\{"\/docs\/after-regex-spread"\}/);
  assert.match(transformed, /\[Code\]\(\/unchanged\)/);
  assert.match(transformed, /\[Fence\]\(\/unchanged\)/);
});

test("preserves source at the root base", () => {
  const source = "[Guide](/guide)";
  assert.equal(normalizeAuthoredLinks(source, { base: "/" }), source);
});

test("fails closed at the root base", () => {
  assert.throws(
    () => normalizeAuthoredLinks("<Card href={", { base: "/" }),
    /could not parse source/,
  );
});

test("rejects canonical-path escapes", () => {
  for (const destination of [
    "/../admin",
    "/.%2e/admin",
    "/%252e%252e/admin",
    "/%2525252e%2525252e/admin",
    "/safe/%2f..%2fadmin",
  ]) {
    for (const source of [
      `[Escape](${destination})`,
      `[escape]: ${destination}`,
      `<Card href="${destination}" />`,
      `<Card href={"${destination}"} />`,
    ]) {
      assert.throws(
        () => normalizeAuthoredLinks(source, { base: "/docs" }),
        /destination escapes its canonical path/,
      );
    }
  }

  assert.throws(
    () =>
      normalizeAuthoredLinks(`<Card href={"\\u002f..\\u002fadmin"} />`, {
        base: "/docs",
      }),
    /destination escapes its canonical path/,
  );
});

test("maps Satteri code-point positions to UTF-16 offsets", () => {
  const source = `😀😀 [Link](/link)\n\n😀 <Card href="/card" />`;
  assert.equal(
    normalizeAuthoredLinks(source, { base: "/文档" }),
    `😀😀 [Link](/文档/link)\n\n😀 <Card href="/文档/card" />`,
  );
});

test("normalizes links nested in JSX fragments", () => {
  assert.equal(
    normalizeAuthoredLinks("<>[Guide](/guide)</>", { base: "/docs" }),
    "<>[Guide](/docs/guide)</>",
  );
});

test("normalizes after multiline JSX expressions without losing source offsets", () => {
  const source = `<Card foo={
  destination ?? { pattern: /}/, value: \`x\${nested}\` }
} href={
  "/guide"
} />
<Card foo={\r\n\t destination\r\n} href={\r\n\t'/crlf'\r\n} />`;

  assert.equal(
    normalizeAuthoredLinks(source, { base: "/docs" }),
    `<Card foo={
  destination ?? { pattern: /}/, value: \`x\${nested}\` }
} href={
  "/docs/guide"
} />
<Card foo={\r\n\t destination\r\n} href={\r\n\t'/docs/crlf'\r\n} />`,
  );
});

test("distinguishes postfix arithmetic from regular expressions", () => {
  const source = `<Card value={count++ / 2} href="/increment" />
<Card value={count-- / 2} href="/decrement" />`;
  assert.equal(
    normalizeAuthoredLinks(source, { base: "/docs" }),
    `<Card value={count++ / 2} href="/docs/increment" />
<Card value={count-- / 2} href="/docs/decrement" />`,
  );
});

test("fails closed with source location on malformed MDX", () => {
  assert.throws(
    () =>
      normalizeAuthoredLinks("# Before\n\n<Card href={", {
        base: "/docs",
        sourceId: "broken.mdx",
      }),
    /broken\.mdx:3:1: could not parse source/,
  );
});

test("rejects an invalid deployment base", () => {
  for (const base of [
    "docs",
    "//evil.test",
    '/docs" onClick={evil}',
    "/../docs",
    "/%2e%2e/docs",
    "/%2E./docs",
    "/docs/.%2e/escape",
    "/%252e%252e/docs",
    "/%25252fadmin",
  ]) {
    assert.throws(
      () => normalizeAuthoredLinks("[Guide](/guide)", { base }),
      /base must be an absolute pathname/,
    );
  }
});

test("normalizes hrefs on JSX elements whose children contain JSX-like tokens", () => {
  const source = `<Tabs syncKey="x" href="/guide">

\`\`\`js
{
\`\`\`

</Tabs>`;
  assert.equal(
    normalizeAuthoredLinks(source, { base: "/docs" }),
    `<Tabs syncKey="x" href="/docs/guide">

\`\`\`js
{
\`\`\`

</Tabs>`,
  );
});

test("skips JSX elements whose raw slice spans blockquote markers", () => {
  const source = `> Example:
> <PackageManagers
> \ttype="create"
> \tpkg="vike@latest"
> />`;
  assert.equal(normalizeAuthoredLinks(source, { base: "/docs" }), source);
});

test("skips blockquote-mangled JSX hrefs instead of failing", () => {
  const source = `> <Card
> \thref="/card"
> />`;
  assert.equal(normalizeAuthoredLinks(source, { base: "/docs" }), source);
});

test("leaves plain Markdown files untouched", () => {
  const source = `<!-- Auto Generated Below -->

<a name="module_x"></a>

[Guide](/guide)`;
  assert.equal(
    normalizeAuthoredLinks(source, { base: "/docs", sourceId: "generated.md" }),
    source,
  );
});

test("still normalizes links in MDX files with a .mdx sourceId", () => {
  const source = `[Guide](/guide)`;
  assert.equal(
    normalizeAuthoredLinks(source, {
      base: "/docs",
      sourceId: "generated.mdx",
    }),
    `[Guide](/docs/guide)`,
  );
});
