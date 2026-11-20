// Generated Markdown for MDX pages: fenced code must survive byte-for-byte,
// and component renderers must emit the same commands as their HTML.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { absoluteMarkdownLinks, renderEntryAsMarkdown } from "../src/_internal/transform.js";
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

test("a fence opened on a list-item line stays inside the item", () => {
  const source = ["1. Run:", "", "- ```yaml", "  paths:", "    /a: {}", "  ```", "", "  Then build."].join("\n");
  const out = mdx(source);
  assert.ok(out.includes(["- ```yaml", "  paths:", "    /a: {}", "  ```"].join("\n")), out);
  assert.ok(out.includes("  Then build."), out);
});

describe("renderEntryAsMarkdown: fences inside list items", () => {
  test("a fence in a nested list item stays in the item, and so does the prose after it", () => {
    assert.equal(
      mdx("- Outer\n  - Inner:\n\n    ```sh\n    run\n    ```\n\n    Prose after.\n"),
      "- Outer\n  - Inner:\n\n    ```sh\n    run\n    ```\n\n    Prose after.",
    );
  });

  test("a fence in an ordered item doesn't split the list", () => {
    assert.equal(
      mdx("1. First:\n\n   ```sh\n   run\n   ```\n\n   More.\n2. Second\n"),
      "1. First:\n\n   ```sh\n   run\n   ```\n\n   More.\n2. Second",
    );
  });

  // 4+ columns past the item's content, or tab-indented, the fence would read
  // as indented code; it moves to the item's content column instead.
  test("an over-indented fence in a list item moves to the item's content column", () => {
    assert.equal(
      mdx("- Step:\n\n      ```sh\n      x\n      ```\n\n  After.\n"),
      "- Step:\n\n  ```sh\n  x\n  ```\n\n  After.",
    );
  });

  // A tab reaches the item's content column, so Markdown reads the same fence.
  test("a tab-indented fence in a list item keeps the author's text", () => {
    assert.equal(mdx("- Step:\n\n\t```sh\n\tx\n\t```\n"), "- Step:\n\n\t```sh\n\tx\n\t```");
  });

  test("a fence indented only by component markup still moves to column 0", () => {
    assert.equal(
      mdx('<Tabs>\n  <TabItem label="A">\n    ```sh\n    a\n    ```\n  </TabItem>\n</Tabs>\n'),
      "### A\n\n```sh\na\n```",
    );
  });
});

describe("renderEntryAsMarkdown: lists inside components", () => {
  test("a list item inside <Aside> keeps its code block and prose", () => {
    assert.equal(
      mdx('<Aside type="tip">\n  Before:\n\n  1. Install:\n\n     ```sh\n     npm i x\n     ```\n\n     Then run it.\n  2. Check.\n</Aside>\n'),
      "> **Tip**\n>\n> Before:\n>\n> 1. Install:\n>\n>    ```sh\n>    npm i x\n>    ```\n>\n>    Then run it.\n> 2. Check.",
    );
  });

  test("a list item inside <Step> keeps its prose", () => {
    assert.equal(
      mdx('<Steps>\n  <Step title="Configure">\n    Set:\n\n    - One\n\n      More about one.\n    - Two\n  </Step>\n</Steps>\n'),
      "1. **Configure**\n\n   Set:\n\n   - One\n\n     More about one.\n   - Two",
    );
  });

  test("a list item inside <TabItem> keeps its code block", () => {
    assert.equal(
      mdx('<Tabs>\n  <TabItem label="npm">\n    1. Run:\n\n       ```sh\n       npm i\n       ```\n  </TabItem>\n</Tabs>\n'),
      "### npm\n\n1. Run:\n\n   ```sh\n   npm i\n   ```",
    );
  });

  test("an <Aside> inside a list item stays in the item", () => {
    assert.equal(
      mdx("- Setup:\n\n  <Aside>\n    Careful.\n\n    Twice.\n  </Aside>\n- Next\n"),
      "- Setup:\n\n  > **Note**\n  >\n  > Careful.\n  >\n  > Twice.\n- Next",
    );
  });
});

describe("renderEntryAsMarkdown: components without a renderer", () => {
  test("nested wrappers unwrap fully, one paragraph per block", () => {
    const out = mdx(
      "<AccordionGroup>\n  <Accordion>\n    <AccordionTrigger>How do I deploy?</AccordionTrigger>\n    <AccordionContent>Run `deploy`.</AccordionContent>\n  </Accordion>\n  <Accordion>\n    <AccordionTrigger>Can I preview?</AccordionTrigger>\n    <AccordionContent>Yes.</AccordionContent>\n  </Accordion>\n</AccordionGroup>\n",
    );
    assert.doesNotMatch(out, /<\/?[A-Z]/);
    assert.equal(out, "How do I deploy?\n\nRun `deploy`.\n\nCan I preview?\n\nYes.");
  });

  test("attributes of a component without a renderer are dropped", () => {
    assert.equal(mdx('<Tip title="Hover text">\n  Body.\n</Tip>\n'), "Body.");
  });

  test("a wrapper without a title keeps just its children", () => {
    assert.equal(mdx("<Frame>\n  <Popover>Hover me</Popover>\n</Frame>\n"), "Hover me");
  });
});

test("a component without a renderer inside a list item stays in the item", () => {
  assert.equal(mdx("- <Frame>Because.\n  More.</Frame>\n- Next\n"), "- Because.\n  More.\n- Next");
});

describe("renderEntryAsMarkdown: component placement", () => {
  test("<Steps> right under an HTML wrapper keeps the blank line that ends the HTML block", () => {
    assert.equal(
      mdx('<div class="x">\n<Steps>\n  <Step title="Install">\n    Run it.\n  </Step>\n</Steps>\n</div>\n'),
      '<div class="x">\n\n1. **Install**\n\n   Run it.\n\n</div>',
    );
  });

  test("cards under an HTML wrapper stay a list", () => {
    assert.equal(
      mdx('<div>\n  <CardGrid>\n    <Card title="A">one</Card>\n    <Card title="B">two</Card>\n  </CardGrid>\n</div>\n'),
      "<div>\n\n- **A** — one\n- **B** — two\n\n</div>",
    );
  });

  test("<Steps> and <Tabs> under a nested list item sit at the item's content column", () => {
    assert.equal(
      mdx('- Setup\n  - Sub step:\n\n    <Steps>\n      <Step title="Install">\n        Run it.\n      </Step>\n    </Steps>\n'),
      "- Setup\n  - Sub step:\n\n    1. **Install**\n\n       Run it.",
    );
    assert.equal(
      mdx('1. Pick:\n   - One of:\n\n     <Tabs>\n       <TabItem label="npm">\n         npm i\n       </TabItem>\n     </Tabs>\n'),
      "1. Pick:\n   - One of:\n\n     ### npm\n\n     npm i",
    );
  });

  test("<Steps> inside a card starts on its own line within the card", () => {
    assert.equal(
      mdx('<Card title="Setup">\n  <Steps>\n    <Step title="Install">\n      Run it.\n    </Step>\n  </Steps>\n</Card>\n'),
      "- **Setup**\n\n  1. **Install**\n\n     Run it.",
    );
  });

  test("a bold-led list item stays inside its step", () => {
    assert.equal(
      mdx('<Steps>\n  <Step title="Config">\n    Set:\n\n    - **site**: the URL\n\n      ```ts\n      site: "x"\n      ```\n  </Step>\n</Steps>\n'),
      '1. **Config**\n\n   Set:\n\n   - **site**: the URL\n\n     ```ts\n     site: "x"\n     ```',
    );
  });

  test("a nested bold-led list outside components keeps its nesting", () => {
    assert.equal(mdx("- Genres:\n  - **Dated** — per release\n"), "- Genres:\n  - **Dated** — per release");
  });

  test("indentation outside a list item never becomes indented code", () => {
    assert.equal(
      mdx("<Aside>\nThis is important.\n\n    Keep this in mind.\n</Aside>\n"),
      "> **Note**\n>\n> This is important.\n>\n> Keep this in mind.",
    );
  });

  test("a component inside a blockquote isn't quoted twice", () => {
    assert.equal(mdx("> <Frame>\n> body\n> </Frame>\n"), "> body");
    assert.equal(mdx("> <Aside>\n> quoted\n> </Aside>\n"), "> > **Note**\n> >\n> > quoted");
  });

  test("a titled component mid-sentence keeps only its text", () => {
    assert.equal(mdx('Click <Tooltip title="hint">here</Tooltip> to continue.\n'), "Click here to continue.");
  });

  test("only string titles show; an expression title falls back", () => {
    assert.equal(mdx('<Aside title={"Heads up"}>\n  Body.\n</Aside>\n'), "> **Heads up**\n>\n> Body.");
    assert.equal(mdx('<Aside title={t("warn")}>\n  Body.\n</Aside>\n'), "> **Note**\n>\n> Body.");
  });

  test("a trigger and its content become separate paragraphs", () => {
    assert.equal(
      mdx("<AccordionItem>\n  <AccordionTrigger>What is it?</AccordionTrigger>\n  <AccordionContent>A framework.</AccordionContent>\n</AccordionItem>\n"),
      "What is it?\n\nA framework.",
    );
  });

  test("an HTML line after a list in a component ends the list", () => {
    assert.equal(
      mdx("<Frame>\n  <div>\n\n  - one\n\n  </div>\n</Frame>\n"),
      "<div>\n\n- one\n\n</div>",
    );
  });
});

test("a body that starts with blank lines still places indented components", () => {
  assert.equal(mdx("\n\n  <Aside>\n    Hi.\n  </Aside>\n"), "> **Note**\n>\n> Hi.");
});

test("<Steps> and <Tabs> in a list item inside <Aside> stay in the item", () => {
  assert.equal(
    mdx(
      '<Aside title="Outer">\n\n- Configure:\n\n  <Steps>\n    <Step title="Install">\n\n    Run install.\n\n    </Step>\n  </Steps>\n\n- Choose:\n\n  <Tabs>\n    <TabItem label="First">\n\n    Pick it.\n\n    </TabItem>\n  </Tabs>\n\n- Last.\n\n</Aside>\n',
    ),
    "> **Outer**\n>\n> - Configure:\n>\n>   1. **Install**\n>\n>      Run install.\n>\n> - Choose:\n>\n>   ### First\n>\n>   Pick it.\n>\n> - Last.",
  );
});

test("tab items and steps written on one line each keep their label", () => {
  assert.equal(
    mdx('<Tabs><TabItem label="A">One.</TabItem><TabItem label="B">Two.</TabItem></Tabs>\n'),
    "### A\n\nOne.\n\n### B\n\nTwo.",
  );
  assert.equal(
    mdx('<Steps><Step title="A">One.</Step><Step title="B">Two.</Step></Steps>\n'),
    "1. **A**\n\n   One.\n2. **B**\n\n   Two.",
  );
});

describe("renderEntryAsMarkdown: nesting the reviewers found", () => {
  test("a card whose body is a list keeps the list under its title", () => {
    assert.equal(mdx('<Card title="Options">\n\n- Alpha.\n- Beta.\n\n</Card>\n'), "- **Options**\n\n  - Alpha.\n  - Beta.");
  });

  test("an <Aside> inside an <Aside> keeps both", () => {
    assert.equal(
      mdx('<Aside title="Outer">\n\nOuter text.\n\n<Aside title="Inner">\n\nInner text.\n\n</Aside>\n\nOuter ending.\n\n</Aside>\n'),
      "> **Outer**\n>\n> Outer text.\n>\n> > **Inner**\n> >\n> > Inner text.\n>\n> Outer ending.",
    );
  });

  test("an HTML wrapper inside a list item stays in the item, with its component", () => {
    assert.equal(
      mdx('<Aside title="Notice">\n\n- Parent.\n\n  <div>\n\n  <Tabs>\n  <TabItem label="First">\n\n  Body.\n\n  </TabItem>\n  </Tabs>\n\n  </div>\n\n- Sibling.\n\n</Aside>\n'),
      "> **Notice**\n>\n> - Parent.\n>\n>   <div>\n>\n>   ### First\n>\n>   Body.\n>\n>   </div>\n>\n> - Sibling.",
    );
  });

  test("an HTML wrapper around cards closes where it opened", () => {
    assert.equal(
      mdx('<Frame>\n  <div>\n    <CardGrid>\n      <Card title="A">one</Card>\n      <Card title="B">two</Card>\n    </CardGrid>\n  </div>\n</Frame>\n'),
      "<div>\n\n- **A** — one\n- **B** — two\n\n</div>",
    );
  });
});

describe("renderEntryAsMarkdown: the parsed-tree review", () => {
  test("<Steps> around a Markdown list keeps the list and its start", () => {
    assert.equal(
      mdx("<Steps start={3}>\n1. Install.\n\n   ```sh\n   npm install\n   ```\n\n   Then this.\n2. Deploy.\n</Steps>\n"),
      "3. Install.\n\n   ```sh\n   npm install\n   ```\n\n   Then this.\n4. Deploy.",
    );
  });

  test("components in table cells keep their title and link", () => {
    assert.equal(
      mdx('| A | B |\n| --- | --- |\n| <Aside title="Watch">Cell warning</Aside> | x |\n| <LinkCard title="Guide" href="https://example.com/guide" /> | y |\n'),
      "| A | B |\n| - | - |\n| **Watch** Cell warning | x |\n| [Guide](https://example.com/guide) | y |",
    );
  });

  test("an <Aside> alone in a one-line HTML wrapper stays a callout", () => {
    assert.equal(
      mdx('<div><Aside type="danger" title="Do not delete">Keep backups.</Aside></div>\n'),
      "<div>\n\n> **Do not delete**\n>\n> Keep backups.\n\n</div>",
    );
  });

  test("an HTML wrapper without blank lines keeps its heading and list", () => {
    assert.equal(
      mdx("<div>\n## Heading\n- one\n- two\n</div>\n"),
      "<div>\n\n## Heading\n\n- one\n- two\n\n</div>",
    );
  });

  test("an HTML wrapper Markdown reads the same is kept as written", () => {
    assert.equal(mdx('<ul>\n  <li><strong>a</strong></li>\n</ul>\n'), '<ul>\n  <li><strong>a</strong></li>\n</ul>');
  });

  test("import and export lines are dropped; a string expression becomes its text", () => {
    assert.equal(
      mdx('import { Badge } from "./badge";\nexport const name = "x";\n\nHello{" "}world. Value: {name}.\n'),
      "Hello world. Value: {name}.",
    );
  });

  test("spaces left inside emphasis by a removed component move outside it", () => {
    assert.equal(mdx("**<Badge> bold </Badge>** and _<Badge> italic </Badge>_ end.\n"), "**bold** and *italic* end.");
  });
});

describe("renderEntryAsMarkdown: the second parsed-tree review", () => {
  test("an indented fence MDX reads as a fence starts its line", () => {
    assert.equal(mdx("Before.\n\n    ```sh\n    echo hello\n    ```\n\nAfter.\n"), "Before.\n\n```sh\necho hello\n```\n\nAfter.");
  });

  test("manual tabs take their labels from the triggers", () => {
    assert.equal(
      mdx('<Tabs><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList><TabsContent value="a">Install it.</TabsContent></Tabs>\n'),
      "### A\n\nInstall it.",
    );
  });

  test("content around tab items, and a wrapper around them, is kept", () => {
    assert.equal(
      mdx('<Tabs>\n\nIntro.\n\n<div>\n<TabItem label="One">First.</TabItem>\n</div>\n\nSee [more](/more).\n\n</Tabs>\n'),
      "Intro.\n\n<div>\n\n### One\n\nFirst.\n\n</div>\n\nSee [more](/more).",
    );
  });

  test("content around steps is kept, and numbering continues past it", () => {
    assert.equal(
      mdx('<Steps>\n\nBack up first.\n\n<Step title="Install">Run install.</Step>\n\nRestart afterward.\n\n</Steps>\n'),
      "Back up first.\n\n1. **Install**\n\n   Run install.\n\nRestart afterward.",
    );
    assert.equal(
      mdx('<Steps>\n<Step title="A">a</Step>\n\nNote.\n\n<Step title="B">b</Step>\n</Steps>\n'),
      "1. **A**\n\n   a\n\nNote.\n\n2. **B**\n\n   b",
    );
  });

  test("inline Markdown inside a one-line HTML element stays Markdown", () => {
    assert.equal(mdx("<div>Some **bold** and a [link](/x).</div>\n"), "<div>\n\nSome **bold** and a [link](/x).\n\n</div>");
  });

  test("two callouts on one line stay two callouts", () => {
    assert.equal(
      mdx('<Aside title="A">One.</Aside><Aside title="B">Two.</Aside>\n'),
      "> **A**\n>\n> One.\n\n> **B**\n>\n> Two.",
    );
  });

  test("a custom renderer's output is rendered too, without recursing into itself", () => {
    const render = (componentMap: Record<string, (ctx: { children: string }) => string>, body: string) =>
      renderEntryAsMarkdown({ body, filePath: "page.mdx" }, { componentMap });
    assert.equal(render({ MyTip: ({ children }) => `<Aside>${children}</Aside>` }, "<MyTip>Read this.</MyTip>\n"), "> **Note**\n>\n> Read this.");
    assert.equal(render({ Loop: ({ children }) => `<Loop>${children}</Loop>` }, "<Loop>x</Loop>\n"), "x");
  });
});

describe("renderEntryAsMarkdown: site renderers and parse failures", () => {
  const render = (body: string, componentMap?: Record<string, (ctx: { children: string }) => string>) =>
    renderEntryAsMarkdown({ body, filePath: "page.mdx" }, componentMap ? { componentMap } : {});

  test("a renderer's plain Markdown goes in exactly as written", () => {
    assert.equal(render("<MyList>x</MyList>\n", { MyList: () => "* one\n* two\n\n| a |\n|:-|\n| b |" }), "* one\n* two\n\n| a |\n|:-|\n| b |");
  });

  test("a renderer's output that uses a component still converts", () => {
    assert.equal(render("<MyTip>Read this.</MyTip>\n", { MyTip: ({ children }) => `<Aside>${children}</Aside>` }), "> **Note**\n>\n> Read this.");
  });

  test("a renderer's code samples and non-MDX text go in as written", () => {
    assert.equal(render("<X/>\n", { X: () => 'Use {"literal"} with `<Note/>`' }), 'Use {"literal"} with `<Note/>`');
    assert.equal(render("<X/>\n", { X: () => "~~~tsx\n<Note/>\n~~~" }), "~~~tsx\n<Note/>\n~~~");
    assert.equal(render("<X/>\n", { X: () => "Array<T>" }), "Array<T>");
  });

  test("output that uses a lowercase mapped name or a fragment still converts", () => {
    assert.equal(render("<X/>\n", { X: () => "<foo>x</foo>", foo: () => "lower rendered" }), "lower rendered");
    assert.equal(render("<X/>\n", { X: () => "<>x</>" }), "x");
  });

  test("in a table cell, multi-line or piped output keeps the row whole", () => {
    const table = "| a | b |\n|---|---|\n| <X/> | next |\n";
    assert.equal(render(table, { X: () => "one\ntwo" }), "| a | b |\n| - | - |\n| one&#xA;two | next |");
    assert.equal(render(table, { X: () => "a | b" }), "| a | b |\n| - | - |\n| a \\| b | next |");
  });

  test("multi-line output for a list item stays in the item", () => {
    assert.equal(render("- Item:\n\n  <X/>\n- Next\n", { X: () => "line one\nline two" }), "- Item:\n\n  line one\n  line two\n- Next");
  });

  test("a body Sätteri can't parse keeps its text, with a warning", () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => void warnings.push(message);
    try {
      assert.equal(render("Intro.\n\n<div>\nnever closed\n"), "Intro.\n\n<div>\nnever closed");
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\[nimbus\] Generated Markdown for page\.mdx keeps its MDX as written: it couldn't be parsed/);
  });
});

describe("renderEntryAsMarkdown: relative images", () => {
  const render = (body: string, filePath = "src/content/docs/guides/deploy.mdx", base = "/") =>
    renderEntryAsMarkdown({ body, filePath }, { base });
  const published = /\/_nimbus\/md\/[a-z0-9]+\/pipeline\.png/;

  test("a relative image points at its published copy", () => {
    const out = render("![The pipeline](./pipeline.png)");
    assert.match(out, new RegExp(`^!\\[The pipeline\\]\\(${published.source}\\)$`));
  });

  test("the same source gets the same URL from every page", () => {
    const a = render("![a](./pipeline.png)");
    const b = render("![b](../pipeline.png)", "src/content/docs/guides/other/page.mdx");
    assert.equal(a.match(published)?.[0], b.match(published)?.[0]);
  });

  test("the site's base goes in front", () => {
    assert.match(render("![x](pipeline.png)", undefined, "/docs/"), /^!\[x\]\(\/docs\/_nimbus\/md\//);
  });

  test("a reference definition an image uses is rewritten, a link's is not", () => {
    const out = render("![x][img] and [y][doc]\n\n[img]: ./pipeline.png\n[doc]: ./other.md");
    assert.match(out, /\[img\]: \/_nimbus\/md\/[a-z0-9]+\/pipeline\.png/);
    assert.match(out, /\[doc\]: \.\/other\.md/);
  });

  test("absolute, external and in-code images are left alone", () => {
    const body = "![a](/a.png) ![b](https://x.test/b.png)\n\n```md\n![c](./c.png)\n```";
    assert.equal(render(body), body);
  });

  test("plain Markdown pages are rewritten too", () => {
    assert.match(render("![x](./pipeline.png)", "src/content/docs/guides/deploy.md"), published);
  });
});

describe("linked components keep their links", () => {
  test("a Card with href links its title, in a list, a sentence and a table cell", () => {
    assert.equal(mdx('<Card title="Quickstart" href="/start/">Your first request.</Card>\n'), "- [**Quickstart**](/start/) — Your first request.");
    assert.equal(
      mdx('<CardGrid>\n  <Card title="A" href="/a/">one</Card>\n  <Card title="B">two</Card>\n</CardGrid>\n'),
      "- [**A**](/a/) — one\n- **B** — two",
    );
    assert.equal(mdx('See <Card title="Quickstart" href="/start/">x</Card> here.\n'), "See [**Quickstart**](/start/) — x here.");
    assert.equal(mdx('| A |\n| --- |\n| <Card title="Q" href="/q/" /> |\n'), "| A |\n| - |\n| [**Q**](/q/) |");
  });

  test("a LinkButton is a link, on its own line or in a sentence", () => {
    assert.equal(mdx('<LinkButton href="/start/">Get started</LinkButton>\n'), "[Get started](/start/)");
    assert.equal(mdx('Try <LinkButton href="/start/">Get started</LinkButton> now.\n'), "Try [Get started](/start/) now.");
    assert.equal(mdx('<LinkButton href={"/x/"}>Lit</LinkButton>\n'), "[Lit](/x/)");
  });

  test("no link without a href Nimbus can read, or around more than one line", () => {
    assert.equal(mdx("<LinkButton {...props}>Spread</LinkButton>\n"), "Spread");
    assert.equal(mdx('<LinkButton href="">Empty</LinkButton>\n'), "Empty");
    assert.equal(mdx("<LinkButton href={url}>Expr</LinkButton>\n"), "Expr");
    assert.equal(mdx('<Card title="Q" href="/q/" {...rest}>x</Card>\n'), "- **Q** — x");
    assert.equal(mdx('<LinkButton href="/m/">\n\nPara one.\n\nPara two.\n\n</LinkButton>\n'), "Para one.\n\nPara two.");
  });

  test("a site's own renderer still wins", () => {
    const render = (body: string, name: string) =>
      renderEntryAsMarkdown({ body, filePath: "page.mdx" }, { componentMap: { [name]: () => "custom" } });
    assert.equal(render('<Card title="Q" href="/q/">x</Card>\n', "Card"), "custom");
    assert.equal(render('<LinkButton href="/q/">x</LinkButton>\n', "LinkButton"), "custom");
  });

  test("their root-relative links become full URLs in the published Markdown", () => {
    const body = '<Card title="Q" href="/q/">x</Card>\n\n<LinkButton href="/start/">Go</LinkButton>\n';
    assert.equal(
      absoluteMarkdownLinks(mdx(body), "https://docs.example.com"),
      "- [**Q**](https://docs.example.com/q/) — x\n\n[Go](https://docs.example.com/start/)",
    );
  });
});

describe("component links never nest", () => {
  test("inside a link, or around content that has one, the component adds no link", () => {
    assert.equal(mdx('<LinkButton href="/outer/">[Inner](/inner/)</LinkButton>\n'), "[Inner](/inner/)");
    assert.equal(mdx('[<Card title="Q" href="/q/">body</Card>](/outer/)\n'), "[**Q** — body](/outer/)");
    assert.equal(mdx('[Go <LinkButton href="/b/">now</LinkButton>](/outer/)\n'), "[Go now](/outer/)");
  });

  test("a link inside a custom renderer's output counts too", () => {
    const out = renderEntryAsMarkdown(
      { body: 'Go <LinkButton href="/outer/"><Badge>Inner</Badge></LinkButton> now.\n', filePath: "page.mdx" },
      { componentMap: { Badge: () => "[Inner](/inner/)" } },
    );
    assert.equal(out, "Go [Inner](/inner/) now.");
    const reference = renderEntryAsMarkdown(
      { body: 'Go <LinkButton href="/outer/"><Badge>Inner</Badge></LinkButton> now.\n\n[Inner]: /inner/\n', filePath: "page.mdx" },
      { componentMap: { Badge: () => "[Inner]" } },
    );
    assert.equal(reference, "Go [Inner] now.\n\n[Inner]: /inner/");
  });
});
