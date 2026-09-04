import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  authoredLinksPlugin,
  transformAuthoredLinks,
} from "../src/_internal/authored-links.js";

test("transformAuthoredLinks applies base to authored internal links", () => {
  const source = `[Root](/)
[Components](/components?view=all#cards)
[Already based](/docs/components)
[External](https://example.com/components)
[Protocol relative](//cdn.example.com/file.js)
[Relative](../components)
[Anchor](#cards)

[Reference][components]

[components]: /components "Components"
[x][foo\\\\]

[foo\\\\]: /escaped-definition
[Trap](/trap "title ]( example")
[Escaped](\\/escaped)
[Entity](&#x2F;entity)

<a href="/plain">Plain</a>
<a HREF="/uppercase">Uppercase</a>
<a href="&#x2F;entity-attribute">Entity attribute</a>
<a href="/&#x64;ocs/already-based">Already based entity</a>
<LinkCard href='/card' />
<LinkCard href={target} />

\`[Inline code](/unchanged)\`

\`\`\`md
[Fenced code](/unchanged)
\`\`\`
`;

  const transformed = transformAuthoredLinks(source, "/docs/");
  assert.match(transformed, /\[Root\]\(\/docs\/\)/);
  assert.match(transformed, /\[Components\]\(\/docs\/components\?view=all#cards\)/);
  assert.match(transformed, /\[Already based\]\(\/docs\/components\)/);
  assert.match(transformed, /\[components\]: \/docs\/components "Components"/);
  assert.match(transformed, /\[foo\\\\\]: \/docs\/escaped-definition/);
  assert.match(transformed, /\[Trap\]\(\/docs\/trap "title \]\( example"\)/);
  assert.match(transformed, /\[Escaped\]\(\/docs\\\/escaped\)/);
  assert.match(transformed, /\[Entity\]\(\/docs&#x2F;entity\)/);
  assert.match(transformed, /\[Relative\]\(\.\.\/components\)/);
  assert.match(transformed, /href="\/docs\/plain"/);
  assert.match(transformed, /HREF="\/docs\/uppercase"/);
  assert.match(transformed, /href="\/docs&#x2F;entity-attribute"/);
  assert.match(transformed, /href="\/&#x64;ocs\/already-based"/);
  assert.match(transformed, /href='\/docs\/card'/);
  assert.match(transformed, /href=\{target\}/);
  assert.match(transformed, /\[Inline code\]\(\/unchanged\)/);
  assert.match(transformed, /\[Fenced code\]\(\/unchanged\)/);
  assert.equal(transformAuthoredLinks(transformed, "/docs/"), transformed);
});

test("transformAuthoredLinks is unchanged at the root base", () => {
  const source = "[Components](/components)";
  assert.equal(transformAuthoredLinks(source, "/"), source);
});

test("transformAuthoredLinks handles astral characters before links and JSX", () => {
  const source = `😀😀 [Link](/link)

😀 <Card href="/card" />`;
  assert.equal(
    transformAuthoredLinks(source, "/docs"),
    `😀😀 [Link](/docs/link)

😀 <Card href="/docs/card" />`,
  );
});

test("transformAuthoredLinks does not rewrite code nested inside JSX", () => {
  const source = `<Box href="/outer">

\`<a href="/inline-code">\`

\`\`\`html
<a href="/fenced-code">example</a>
\`\`\`

<a href="/inner">inner</a>
</Box>`;

  const transformed = transformAuthoredLinks(source, "/docs");
  assert.match(transformed, /<Box href="\/docs\/outer">/);
  assert.match(transformed, /`<a href="\/inline-code">`/);
  assert.match(transformed, /<a href="\/fenced-code">example<\/a>/);
  assert.match(transformed, /<a href="\/docs\/inner">inner<\/a>/);
});

test("transformAuthoredLinks handles JSX expressions before static hrefs", () => {
  const source = `<Card enabled={count > 0} label={'href="/example"'} value={/* } href } href */ target} href="/components/card" />`;
  assert.equal(
    transformAuthoredLinks(source, "/docs"),
    `<Card enabled={count > 0} label={'href="/example"'} value={/* } href } href */ target} href="/docs/components/card" />`,
  );
});

test("transformAuthoredLinks ignores href-like text inside expressions", () => {
  const source = '<Card href={` } href="/evil"`} />';
  assert.equal(transformAuthoredLinks(source, "/docs"), source);
});

test("transformAuthoredLinks handles static hrefs around multiline expressions", () => {
  const source = `<Card href="/before" foo={
    count > 0
  } bar={/}/.test(value)} quote={/"/.test(value)} slash={/[//]/.test(value)} trap={/} href/.test(value)} keyword={(() => { return /"/.test(value); })()} href="/after" />`;
  assert.equal(
    transformAuthoredLinks(source, "/docs"),
    `<Card href="/docs/before" foo={
    count > 0
  } bar={/}/.test(value)} quote={/"/.test(value)} slash={/[//]/.test(value)} trap={/} href/.test(value)} keyword={(() => { return /"/.test(value); })()} href="/docs/after" />`,
  );
});

test("authoredLinksPlugin only transforms project content", () => {
  const plugin = authoredLinksPlugin({
    base: "/docs",
    contentDirs: ["/project/src/content"],
  });
  assert.deepEqual(plugin.transform("[Components](/components)", "/project/src/content/a.mdx"), {
    code: "[Components](/docs/components)",
    map: null,
  });
  assert.equal(plugin.transform("[Components](/components)", "/project/README.md"), null);
  assert.equal(
    plugin.transform("[Components](/components)", "/project/src/content/node_modules/pkg/readme.md"),
    null,
  );
});

test("authoredLinksPlugin rejects content symlinked outside the project", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nimbus-authored-links-"));
  const project = path.join(root, "project");
  const external = path.join(root, "external");
  mkdirSync(project);
  mkdirSync(external);
  const externalFile = path.join(external, "guide.mdx");
  writeFileSync(externalFile, "[Components](/components)");
  const linkedFile = path.join(project, "guide.mdx");
  symlinkSync(externalFile, linkedFile);

  try {
    const plugin = authoredLinksPlugin({ base: "/docs", contentDirs: [project] });
    assert.equal(plugin.transform("[Components](/components)", linkedFile), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
