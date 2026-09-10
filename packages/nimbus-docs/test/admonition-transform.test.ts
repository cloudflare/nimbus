import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  mdxToMdast,
  mdxToJs,
  markdownToHtml,
  defineMdastPlugin,
  type MdastNode,
} from "satteri";
import { parseAdmonitions } from "../src/_internal/admonition-transform.js";
import { satteri } from "@astrojs/markdown-satteri";
import {
  configureAdmonitions,
  satteriAdmonitions,
} from "../src/_internal/admonition-processor.js";

const nodes = (node: MdastNode): MdastNode[] => [
  node,
  ...("children" in node ? node.children.flatMap(nodes) : []),
];
const asides = (source: string) =>
  nodes(parseAdmonitions(source)).filter(
    (node) => node.type === "mdxJsxFlowElement" && node.name === "Aside",
  );
const codeValues = (node: MdastNode) =>
  nodes(node)
    .filter((n) => n.type === "code" || n.type === "inlineCode")
    .map((n) => ("value" in n ? n.value : undefined));
const plugin = satteriAdmonitions({
  contentDirs: ["/docs"],
  skip: (file) => file.endsWith("skip.mdx"),
});
const compile = (source: string, file = "/docs/page.mdx") =>
  mdxToJs(source, { fileURL: pathToFileURL(file), mdastPlugins: [plugin] })
    .code;

test("native directive maps aliases and plain title attributes to Aside", () => {
  for (const [alias, type] of Object.entries({
    note: "note",
    info: "note",
    tip: "tip",
    warning: "caution",
    important: "caution",
    caution: "caution",
    danger: "danger",
  })) {
    const node = asides(`:::${alias}[Say "hi"]\nBody\n:::`)[0]!;
    assert.ok(node.type === "mdxJsxFlowElement");
    assert.deepEqual(node.attributes, [
      { type: "mdxJsxAttribute", name: "type", value: type },
      { type: "mdxJsxAttribute", name: "title", value: 'Say "hi"' },
    ]);
  }
  assert.match(
    JSON.stringify(
      parseAdmonitions(":::heads\nBody\n:::", {
        typeAliases: { heads: "tip" },
      }),
    ),
    /"value":"tip"/,
  );
});
for (const title of [
  "`Age` response header",
  "Run <code>traceroute</code>",
  "**Strong** and *emphasis*",
  "[Link](https://example.com)",
  "😀 `Age` &amp; cache",
  "{value}",
  "<code title={value}>Run</code>",
  "Escaped \\] bracket",
  "Run `x]:y`",
]) {
  test(`title stays a plain string: ${title}`, () => {
    const source = `:::note[${title}]\nBody\n:::`;
    const node = asides(source)[0]!;
    assert.ok(node?.type === "mdxJsxFlowElement");
    assert.deepEqual(node.attributes[1], {
      type: "mdxJsxAttribute",
      name: "title",
      value: title,
    });
    assert.doesNotThrow(() => compile(source));
  });
}
for (const protectedSource of [
  "```mdx\n:::note\nliteral\n:::\n```",
  "````mdx\n:::note\n```txt\n:::\n```\n:::\n````",
  "~~~~mdx\n:::note\n~~~txt\n:::\n~~~\n:::\n~~~~",
  "---\ndescription: |\n  :::note\n  literal\n  :::\n---",
  '+++\ndescription = """\n:::note\nliteral\n:::\n"""\n+++',
  "{`\n:::note\nliteral\n:::\n`}",
  "export const example = `\n:::note\nliteral\n:::\n`;",
  "<pre>\n:::note\nliteral\n:::\n</pre>",
  "<Box value={`\n:::note\nliteral\n:::\n`} />",
  "`\n:::note\nliteral\n:::\n`",
  "[example]:\n:::note",
  '[example]: /url "\n:::note\nliteral\n:::\n"',
]) {
  test(`native syntax protection: ${protectedSource.slice(0, 25)}`, () => {
    const source = `${protectedSource}\n\n:::tip\nReal\n:::\n`;
    assert.equal(asides(source).length, 1);
    assert.deepEqual(
      codeValues(parseAdmonitions(source)),
      codeValues(mdxToMdast(source)),
    );
    assert.doesNotThrow(() => compile(source));
  });
}
for (const body of [
  "  - Plain\n  - With `code`",
  "  - Plain\n  - With <code>code</code>",
  '  - Plain\n  - With {"code"}',
  "  - Plain\n  - With `some\n    multiline code`\n  - Last",
  "  Plain `some\n    multiline code`",
  "  - With `some\nmultiline code`",
  "```txt\nkeep\rthese\n```",
]) {
  test(`native bodies retain code values: ${body.slice(0, 25)}`, () => {
    const source = `:::note\n\n${body}\n:::\n`;
    const tree = parseAdmonitions(source);
    assert.equal(asides(source).length, body.includes("\r") ? 0 : 1);
    assert.deepEqual(codeValues(tree), codeValues(mdxToMdast(source)));
    assert.doesNotThrow(() => compile(source));
    if (body.includes("- Plain")) {
      const list = nodes(tree).find((n) => n.type === "list");
      assert.ok(list?.type === "list");
      assert.equal(list.children.length, body.includes("- Last") ? 3 : 2);
    }
  });
}
for (const newline of ["\n", "\r\n", "\r"]) {
  test(`native newline handling ${JSON.stringify(newline)}`, () => {
    const source = [":::note", "Body", ":::", ""].join(newline);
    assert.equal(asides(source).length, newline === "\r" ? 0 : 1);
    assert.match(compile(source), /Body/);
  });
}
test("legacy opening-line bodies are parsed by Sätteri without text loss", () => {
  for (const source of [
    ":::note Quick tip. :::\n",
    ":::note[Title] First line.\nSecond line.\n:::\n",
  ]) {
    const code = compile(source);
    assert.equal(asides(source).length, 1);
    assert.match(code, /Quick tip\.|First line/);
    if (source.includes("Second")) assert.match(code, /Second line/);
  }
});
test("native nesting and longer fences remain structured", () => {
  assert.equal(asides("::::note\nOuter\n:::tip\nInner\n:::\n::::\n").length, 2);
});
test("unknown and non-container directives stay literal", () => {
  const source =
    ":::custom\nBody\n:::\n\nText :badge[hello].\n\n::leaf[label]\n\n:::note\nReal\n:::\n";
  assert.equal(asides(source).length, 1);
  const output = compile(source);
  assert.match(output, /:::custom/);
  assert.match(output, /:badge\[hello\]/);
  assert.match(output, /::leaf\[label\]/);
});
test("scope, skip and Markdown are untouched", () => {
  const source = ":::note\nBody\n:::";
  for (const file of ["/docs/page.md", "/docs/skip.mdx", "/other/page.mdx"]) {
    assert.doesNotMatch(compile(source, file), /_jsx\(Aside/);
    assert.match(compile(source, file), /:::note/);
  }
  assert.match(
    markdownToHtml(source, {
      fileURL: pathToFileURL("/docs/page.md"),
      mdastPlugins: [plugin],
    }).html,
    /:::note/,
  );
});
test("consumer plugins see the generated Aside and original body", () => {
  let found = false;
  const consumer = defineMdastPlugin({
    name: "consumer",
    mdxJsxFlowElement(node) {
      if (node.name === "Aside") found = true;
    },
  });
  mdxToJs(":::note\nBody\n:::", {
    fileURL: pathToFileURL("/docs/page.mdx"),
    mdastPlugins: [plugin, consumer],
  });
  assert.equal(found, true);
});
test("full Cloudflare fixture emits three Asides and retains every code node", async () => {
  const source = await readFile(
    new URL(
      "./fixtures/admonitions/code-block-guidelines.mdx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(asides(source).length, 3);
  assert.deepEqual(
    codeValues(parseAdmonitions(source)),
    codeValues(mdxToMdast(source)),
  );
  assert.doesNotThrow(() => compile(source));
});
test("nested JSX and list bodies compile without source reindentation", () => {
  const source =
    "<Tabs>\n\n1. Item\n\n   <TabItem>\n\n   :::note\n   Body `code`\n   :::\n\n   </TabItem>\n\n</Tabs>\n";
  assert.equal(asides(source).length, 1);
  assert.doesNotThrow(() => compile(source));
});

test("legacy body stays inside its enclosing list and Aside", () => {
  const tree = parseAdmonitions("- Item\n\n  :::note Quick tip. :::\n\n  More");
  assert.equal(tree.children.length, 1);
  const aside = nodes(tree).find(
    (n) => n.type === "mdxJsxFlowElement" && n.name === "Aside",
  );
  assert.ok(aside);
  assert.match(JSON.stringify(aside), /Quick tip/);
  assert.match(
    compile("- Item\n\n  :::note Quick tip. :::\n\n  More"),
    /Quick tip/,
  );
});
for (const title of [
  'Run <code title="]">x</code>',
  "Run <code>items]</code>",
]) {
  test(`JSX brackets in plain titles: ${title}`, () => {
    const source = `:::note[${title}]\nBody\n:::`;
    const aside = asides(source)[0];
    assert.ok(aside?.type === "mdxJsxFlowElement");
    assert.deepEqual(aside.attributes[1], {
      type: "mdxJsxAttribute",
      name: "title",
      value: title,
    });
    assert.doesNotThrow(() => compile(source));
  });
}
test("inline literal JSX retains native node kind and original positions", () => {
  const source = "Intro.\n\n:::note\n\nWith <code>x</code>.\n:::\n";
  const before = nodes(mdxToMdast(source)).find(
    (n) => n.type === "mdxJsxTextElement" && n.name === "code",
  );
  const after = nodes(parseAdmonitions(source)).find(
    (n) => n.type === "mdxJsxTextElement" && n.name === "code",
  );
  assert.deepEqual(after, before);
});
test("explicit compiler GFM and smart punctuation overrides are retained", () => {
  const source = '~~outside~~ "quoted"\n\n:::note\n\n~~inside~~ "quoted"\n:::';
  const code = mdxToJs(source, {
    features: { gfm: false, smartPunctuation: false },
    fileURL: pathToFileURL("/docs/page.mdx"),
    mdastPlugins: [
      satteriAdmonitions(
        { contentDirs: ["/docs"] },
        { gfm: true, smartPunctuation: true },
      ),
    ],
  }).code;
  assert.match(code, /~~outside~~/);
  assert.match(code, /~~inside~~/);
  assert.doesNotMatch(code, /“/);
  assert.match(code, /_jsx\(Aside/);
});
test("already-enabled directives containing only code still become Aside", () => {
  const code = mdxToJs(":::note\n```txt\nx\n```\n:::", {
    features: { directive: true },
    fileURL: pathToFileURL("/docs/page.mdx"),
    mdastPlugins: [
      satteriAdmonitions({ contentDirs: ["/docs"] }, { directive: true }),
    ],
  }).code;
  assert.match(code, /_jsx\(Aside|_jsxs\(Aside/);
  assert.match(code, /children: "x\\n"/);
});
test("JavaScript brackets and colons outside titles remain valid", () => {
  const source =
    "export const obj = {items: [1,2]};\n\n<Box value={{items: [1,2]}} />\n\n:::note\n{obj.items[0]}\n:::";
  assert.doesNotThrow(() => compile(source));
  assert.equal(asides(source).length, 1);
});

test("titles remain attached inside enclosing JSX", () => {
  const aside = asides("<Tabs>\n  :::note[Title]\n  Body\n  :::\n</Tabs>")[0];
  assert.ok(aside?.type === "mdxJsxFlowElement");
  assert.deepEqual(aside.attributes[1], {
    type: "mdxJsxAttribute",
    name: "title",
    value: "Title",
  });
});
test("legacy body stays inside a blockquote", () => {
  const tree = parseAdmonitions("> :::note Quick tip. :::\n> More");
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0]?.type, "blockquote");
  const aside = nodes(tree).find(
    (n) => n.type === "mdxJsxFlowElement" && n.name === "Aside",
  );
  assert.ok(aside);
  assert.match(JSON.stringify(aside), /Quick tip/);
});

test("unknown blocks retain their paragraph structure", () => {
  const source = ":::unknown\nBody\n:::";
  assert.deepEqual(
    parseAdmonitions(source),
    structuredClone(mdxToMdast(source)),
  );
});

test("admonition configuration is isolated from reusable and frozen processors", async () => {
  const processor = satteri();
  Object.freeze(processor.options.mdastPlugins);
  Object.freeze(processor.options);
  Object.freeze(processor);
  const enabled = configureAdmonitions(processor, { contentDirs: ["/docs"] });
  const skipped = configureAdmonitions(processor, {
    contentDirs: ["/docs"],
    skip: () => true,
  });
  const elsewhere = configureAdmonitions(processor, {
    contentDirs: ["/other"],
  });
  const source = ":::note\nBody\n:::";
  const run = (value: typeof processor) =>
    mdxToJs(source, {
      fileURL: pathToFileURL("/docs/page.mdx"),
      mdastPlugins: value.options.mdastPlugins,
    }).code;
  assert.match(run(enabled), /_jsx\(Aside/);
  for (const unchanged of [processor, skipped, elsewhere]) {
    assert.match(run(unchanged), /:::note/);
    assert.doesNotMatch(run(unchanged), /_jsx\(Aside/);
  }
  assert.equal(processor.options.mdastPlugins.length, 0);
  const renderer = await enabled.createRenderer({
    syntaxHighlight: false,
  } as Parameters<typeof enabled.createRenderer>[0]);
  assert.match(
    (await renderer.render(source, { frontmatter: {} })).code,
    /:::note/,
  );
});

test("consumer plugins retain opted-in native custom directive nodes", () => {
  const seen: string[] = [];
  const observer = defineMdastPlugin({
    name: "custom-directives",
    containerDirective(node) {
      seen.push(node.name);
    },
    leafDirective(node) {
      seen.push(node.name);
    },
    textDirective(node) {
      seen.push(node.name);
    },
  });
  const source =
    ":::custom\nCustom\n:::\n\nText :badge[hello].\n\n::leaf[label]\n\n:::note\nNote\n:::";
  const code = mdxToJs(source, {
    features: { directive: true },
    fileURL: pathToFileURL("/docs/page.mdx"),
    mdastPlugins: [
      satteriAdmonitions({ contentDirs: ["/docs"] }, { directive: true }),
      observer,
    ],
  }).code;
  assert.deepEqual(seen, ["custom", "badge", "leaf"]);
  assert.match(code, /_jsx\(Aside/);
});

test("arbitrary literal titles can use the existing direct Aside contract", () => {
  for (const title of ["Use <T>", "Use {foo bar}", "Set {name to value"]) {
    assert.throws(() => compile(`:::note[${title}]\nBody\n:::`));
    assert.doesNotThrow(() => compile(`<Aside title="${title}">Body</Aside>`));
  }
});
