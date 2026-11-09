import assert from "node:assert/strict";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { absolutizeMarkdownLinks, type MdastNode } from "../src/_internal/markdown-links.ts";
import { absoluteMarkdownLinks } from "../src/_internal/transform.ts";

// The API serialization parses with mdast-util-from-markdown plus GFM where
// authored pages parse with Sätteri; both must place the origin at the same
// bytes, or a request-rendered page differs from the baked file.
const runtimeParse = (source: string) =>
  fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdastNode;

const SITE = "https://docs.example";

const CASES: Array<[string, string]> = [
  ["plain link", "See [the guide](/guide/) and [outside](https://other.test/x) and [frag](#here)."],
  ["image and title", '![alt](/img/a.png "A title") then [t](/t "Title with ](/not/ inside")'],
  ["definition", "Use [ref][1].\n\n[1]: /refs/one 'One'"],
  ["code span keeps bytes", "Run `[x](/not-a-link)` then [real](/real)."],
  ["fenced code keeps bytes", "```md\n[x](/inside)\n```\n\n[outside](/out)"],
  ["blockquote", "> A quote with [a link](/quoted) in it\n> and [another](/second)."],
  ["list in blockquote", "> - item [one](/one)\n>   - nested [two](/two)\n> - [three](/three)"],
  ["gfm table cells", "| A | B |\n| --- | --- |\n| [cell](/cell) | `code | [not](/not) |` |\n| plain | [also](/also) |"],
  ["table with pipe in code span", "| A | B |\n| --- | --- |\n| `foo | [real](/real) | bar` |"],
  ["angle brackets", "[a](</with space/>) and [b](/plain)"],
  ["escaped bracket", "\\[not a link](/no) but [yes](/yes)"],
  ["autolink literal", "Visit https://auto.test/path and [l](/l)."],
  ["strikethrough and link", "~~[old](/old)~~ [new](/new)"],
  ["html inline", "<span>[x](/x)</span> and [y](/y)"],
  ["nested emphasis", "**bold [link](/bold)** and *em [l](/em)*"],
  ["parens in url", "[p](/path/(group)/x) and [q](/q)"],
];

for (const [name, source] of CASES) {
  test(`GFM parser matches Sätteri: ${name}`, () => {
    const expected = absoluteMarkdownLinks(source, SITE);
    const actual = absolutizeMarkdownLinks(source, SITE, runtimeParse);
    assert.equal(actual, expected);
  });
}

test("a root-relative link gains the origin; relative, protocol-relative and fragment URLs do not", () => {
  const out = absolutizeMarkdownLinks("[a](/a) [b](b/) [c](//cdn.test/c) [d](#d) [e](mailto:x@y.z)", SITE, runtimeParse);
  assert.equal(out, `[a](${SITE}/a) [b](b/) [c](//cdn.test/c) [d](#d) [e](mailto:x@y.z)`);
});
