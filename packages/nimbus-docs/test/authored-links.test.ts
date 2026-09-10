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

test("normalizes opening-tag links around MDX bodies that are not TSX", () => {
  const source = [
    '<Card href="/card">',
    "",
    "```ts",
    "const example = <Unclosed>;",
    '<a href="/literal">example</a>',
    "```",
    "",
    "[Guide](/guide)",
    "",
    '<Card href={"/nested"}>',
    "",
    "```ts",
    "export default { fetch() {} } satisfies Handler<Env>;",
    "```",
    "",
    "</Card>",
    "",
    "</Card>",
  ].join("\n");
  assert.equal(
    normalizeAuthoredLinks(source, { base: "/docs" }),
    source
      .replace('href="/card"', 'href="/docs/card"')
      .replace("[Guide](/guide)", "[Guide](/docs/guide)")
      .replace('href={"/nested"}', 'href={"/docs/nested"}'),
  );
  assert.equal(normalizeAuthoredLinks(source, { base: "/" }), source);
});

test("traverses attribute-free wrappers containing fenced code and nested links", () => {
  const source = [
    "1. Configure the prefix.",
    "",
    '   <Tabs> <TabItem label="IRR record">',
    "",
    "   ```txt",
    "   cf-validation: <OWNERSHIP_VALIDATION_TOKEN>",
    "   ```",
    "",
    '   <a href="/guide">Guide</a>',
    "",
    "   </TabItem> </Tabs>",
    "",
    "<TypeScriptExample>",
    "",
    "```ts",
    "export default { fetch() {} } satisfies ExportedHandler<Env>;",
    "```",
    "",
    "</TypeScriptExample>",
  ].join("\n");
  assert.equal(normalizeAuthoredLinks(source, { base: "/" }), source);
  assert.equal(
    normalizeAuthoredLinks(source, { base: "/docs" }),
    source.replace('href="/guide"', 'href="/docs/guide"'),
  );
});

test("normalization preserves unrelated source across format, nesting, Unicode and line endings", () => {
  for (const format of ["md", "mdx"] as const) {
    for (const newline of ["\n", "\r\n"]) {
      for (const prefix of ["", "😀 文档\n\n"]) {
        for (const wrapper of format === "md"
          ? ["plain", "quote", "list"]
          : ["plain", "quote", "list", "component"]) {
          const link =
            format === "md"
              ? '<a\nHREF = "&sol;html">HTML</a>'
              : '<Card href={"/html"}>HTML</Card>';
          const body = [
            format === "md"
              ? "<!-- generated {comment} -->"
              : "{/* comment */}",
            "",
            "[Guide](/guide?x=1#top)",
            "",
            link,
            "",
            "<code>www.example.org</code>",
            "",
            '<template>\n<a href="/template">Template</a>\n</template>',
            "",
            "```tsx",
            '<a href="/literal">example</a>',
            "const value = <Unclosed>;",
            "```",
            "",
            "`[Inline](/literal)`",
          ].join("\n");
          const wrap = (text: string) =>
            wrapper === "quote"
              ? text
                  .split("\n")
                  .map((line) => `> ${line}`)
                  .join("\n")
              : wrapper === "list"
                ? `1. Item\n\n${text
                    .split("\n")
                    .map((line) => `   ${line}`)
                    .join("\n")}`
                : wrapper === "component" && format === "mdx"
                  ? `<Card href="/outer">\n\n${text}\n\n</Card>`
                  : text;
          const source = (prefix + wrap(body)).replaceAll("\n", newline);
          const expected = source
            .replace("[Guide](/guide?x=1#top)", "[Guide](/docs/guide?x=1#top)")
            .replace('HREF = "&sol;html"', 'HREF = "/docs&sol;html"')
            .replace('href={"/html"}', 'href={"/docs/html"}')
            .replace('href="/outer"', 'href="/docs/outer"')
            .replace('href="/template"', 'href="/docs/template"');
          const sourceId = `docs:fixture.${format}`;
          const label = JSON.stringify({ format, newline, prefix, wrapper });
          assert.equal(
            normalizeAuthoredLinks(source, { base: "/", sourceId }),
            source,
            label,
          );
          assert.equal(
            normalizeAuthoredLinks(source, { base: "/docs", sourceId }),
            expected,
            label,
          );
        }
      }
    }
  }
  for (const href of [
    '"/../escape"',
    '"&sol;../escape"',
    "'/safe/%2fescape'",
  ]) {
    for (const source of [
      `<a href=${href}>Link</a>`,
      `> <a\n> href=${href}>Link</a>`,
    ]) {
      assert.throws(
        () => normalizeAuthoredLinks(source, { base: "/", format: "md" }),
        /destination escapes its canonical path/,
      );
    }
  }
});
