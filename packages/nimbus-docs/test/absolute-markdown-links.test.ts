import assert from "node:assert/strict";
import { test } from "node:test";
import { absoluteMarkdownLinks } from "../src/_internal/transform.js";

const site = "https://example.test";

test("root-relative links, images and definitions become absolute; nothing else changes", () => {
  const input = [
    "[Guide](/docs/guide/ \"Title\") and [top](#top), [rel](./x), [ext](https://a.test/b), [proto](//cdn.test/x)",
    "",
    "[![Logo](/docs/logo.png)](/docs/)",
    "",
    "[ref]: /docs/ref/",
    "",
    "`[code](/docs/code/)`",
    "",
    "```md",
    "[fence](/docs/fence/)",
    "```",
  ].join("\n");
  assert.equal(
    absoluteMarkdownLinks(input, site),
    [
      "[Guide](https://example.test/docs/guide/ \"Title\") and [top](#top), [rel](./x), [ext](https://a.test/b), [proto](//cdn.test/x)",
      "",
      "[![Logo](https://example.test/docs/logo.png)](https://example.test/docs/)",
      "",
      "[ref]: https://example.test/docs/ref/",
      "",
      "`[code](/docs/code/)`",
      "",
      "```md",
      "[fence](/docs/fence/)",
      "```",
    ].join("\n"),
  );
});

test("the origin goes before each destination as written: escapes, entities, titles and angle brackets", () => {
  const cases: Array<[string, string]> = [
    ["[a](/foo\\(bar\\))", "[a](https://example.test/foo\\(bar\\))"],
    ["[a](&#47;docs/x)", "[a](https://example.test&#47;docs/x)"],
    ['[a](/foo "title ](/foo")', '[a](https://example.test/foo "title ](/foo")'],
    ["[a](</with space>)", "[a](<https://example.test/with space>)"],
    ["[`a]`](/code)", "[`a]`](https://example.test/code)"],
    ["[\\[x\\]](/esc)", "[\\[x\\]](https://example.test/esc)"],
    ["![`a](/fake)`](/real)", "![`a](/fake)`](https://example.test/real)"],
    ["![``a```b`c](/fake)``](/real)", "![``a```b`c](/fake)``](https://example.test/real)"],
    ["![`alt](/real)\n\n`", "![`alt](https://example.test/real)\n\n`"],
    ["[`ref]: /real\n\n[x][`ref]", "[`ref]: https://example.test/real\n\n[x][`ref]"],
    ["> [multi\n> line](/real)", "> [multi\n> line](https://example.test/real)"],
    ["> ![multi\n> line](/img.png)", "> ![multi\n> line](https://example.test/img.png)"],
    ["> [a](\n> /wrapped)", "> [a](\n> https://example.test/wrapped)"],
    ["> [ref]:\n> /def\n\n[ref]", "> [ref]:\n> https://example.test/def\n\n[ref]"],
    ["> - item\n>\n>     > [multi\n>     > line](/x)", "> - item\n>\n>     > [multi\n>     > line](https://example.test/x)"],
    ["[a](\r\n/crlf)", "[a](\r\nhttps://example.test/crlf)"],
    ["[a]:\r\n /def\r\n\r\n[a]", "[a]:\r\n https://example.test/def\r\n\r\n[a]"],
  ];
  for (const [input, expected] of cases) assert.equal(absoluteMarkdownLinks(input, site), expected, input);
});
