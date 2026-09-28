// Generated Markdown for MDX pages: fenced code must survive byte-for-byte,
// and component renderers must emit the same commands as their HTML.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { renderEntryAsMarkdown } from "../src/_internal/transform.js";
import { getTabs, type CommandType } from "../src/lib/pkgm.js";

const mdx = (body: string) =>
  renderEntryAsMarkdown({ body, filePath: "page.mdx" });

const yaml = [
  "paths:",
  "  /v1/events/{event_id}:",
  "    get:",
  "      operationId: retrieveEvent",
].join("\n");

const python = [
  "def outer():",
  "    def inner():",
  "        return 1",
  "",
  "",
  "    return inner",
].join("\n");

const nestedList = ["- one", "    - two", "        - three"].join("\n");

describe("renderEntryAsMarkdown: fenced code fidelity", () => {
  for (const [lang, code] of [
    ["yaml", yaml],
    ["python", python],
    ["markdown", nestedList],
  ] as const) {
    test(`top-level ${lang} keeps its indentation`, () => {
      const out = mdx(`Intro.\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nOutro.`);
      assert.ok(
        out.includes(`\`\`\`${lang}\n${code}\n\`\`\``),
        `expected verbatim block, got:\n${out}`,
      );
    });
  }

  test("a fence indented inside JSX drops only its own indentation", () => {
    const indented = yaml
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    const out = mdx(
      `<Wrapper>\n  <Inner>\n    \`\`\`yaml\n${indented}\n    \`\`\`\n  </Inner>\n</Wrapper>`,
    );
    assert.ok(out.includes(`\`\`\`yaml\n${yaml}\n\`\`\``), out);
  });

  test("code inside <Aside> gets the quote prefix on every line", () => {
    const out = mdx(
      `<Aside type="caution">\n\nCheck this:\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n</Aside>`,
    );
    const quoted = ["```yaml", ...yaml.split("\n"), "```"]
      .map((line) => `> ${line}`)
      .join("\n");
    assert.ok(out.includes(quoted), `expected quoted block, got:\n${out}`);
  });

  test("code inside an indented <Aside> keeps relative indentation", () => {
    const out = mdx(
      `<Aside>\n  \`\`\`python\n${python
        .split("\n")
        .map((line) => (line ? `  ${line}` : line))
        .join("\n")}\n  \`\`\`\n</Aside>`,
    );
    const quoted = ["```python", ...python.split("\n"), "```"]
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    assert.ok(out.includes(quoted), `expected quoted block, got:\n${out}`);
  });

  test("longer fences and tilde fences are protected whole", () => {
    const body = "````md\n```js\n    <Card title=\"x\" />\n```\n````\n\n~~~txt\n    <Aside>keep</Aside>\n~~~";
    assert.equal(mdx(body), body);
  });

  test("CRLF blocks and several inline spans per line survive", () => {
    const block = "```yaml\r\na:\r\n    b: 1\r\n```";
    const out = mdx(`Use \`a\` and \`b\`.\r\n\r\n${block}\r\n`);
    assert.ok(out.includes("Use `a` and `b`."), out);
    assert.ok(out.includes(block), JSON.stringify(out));
  });

  test("a fence written inside a source blockquote keeps its markers", () => {
    const body = "> ```yaml\n> a:\n>     b: 1\n>\n> ```";
    assert.equal(mdx(body), body);
  });

  test("Markdown files are returned unchanged", () => {
    const body = `\`\`\`yaml\n${yaml}\n\`\`\``;
    assert.equal(
      renderEntryAsMarkdown({ body, filePath: "page.md" }),
      body,
    );
  });
});

describe("renderEntryAsMarkdown: <PackageManagers>", () => {
  const cases: Array<{
    type: CommandType;
    attrs: string;
    pkg?: string;
    args?: string;
    dev?: boolean;
  }> = [
    { type: "add", attrs: 'pkg="astro"', pkg: "astro" },
    { type: "add", attrs: 'pkg="vitest" dev', pkg: "vitest", dev: true },
    {
      type: "create",
      attrs: 'type="create" pkg="astro@latest"',
      pkg: "astro@latest",
    },
    {
      type: "dlx",
      attrs: 'type="dlx" pkg="@cloudflare/nimbus-docs" args="list"',
      pkg: "@cloudflare/nimbus-docs",
      args: "list",
    },
    {
      type: "exec",
      attrs: 'type="exec" pkg="astro" args="check"',
      pkg: "astro",
      args: "check",
    },
    { type: "install", attrs: 'type="install"' },
    { type: "remove", attrs: 'type="remove" pkg="astro"', pkg: "astro" },
    { type: "run", attrs: 'type="run" pkg="build"', pkg: "build" },
  ];

  for (const { type, attrs, pkg, args, dev } of cases) {
    test(`type=${type} (${attrs}) matches the HTML commands`, () => {
      const out = mdx(`<PackageManagers ${attrs} />`);
      const expected = getTabs(type, pkg, { args, dev }).map((t) => t.cmd);
      assert.equal(out, ["```sh", ...expected, "```"].join("\n"));
      if (pkg) {
        const name = pkg.replace(/(?<=.)@[^/]*$/, "");
        for (const line of expected) assert.ok(line.includes(name), line);
      }
    });
  }

  test("dlx keeps the package: npx @cloudflare/nimbus-docs list", () => {
    const out = mdx(
      '<PackageManagers pkg="@cloudflare/nimbus-docs" type="dlx" args="list" />',
    );
    assert.match(out, /^npx @cloudflare\/nimbus-docs list$/m);
  });

  test("run renders the named script, not dev", () => {
    const out = mdx('<PackageManagers pkg="build" type="run" />');
    assert.match(out, /^npm run build$/m);
    assert.doesNotMatch(out, /\bdev\b/);
  });

  test("a comment is emitted once above the commands", () => {
    const out = mdx(
      '<PackageManagers pkg="@cloudflare/nimbus-docs" type="dlx" args="init" comment="scan a nested package" />',
    );
    assert.equal(out.match(/# scan a nested package/g)?.length, 1);
    assert.match(out, /^npx @cloudflare\/nimbus-docs init$/m);
  });
});
