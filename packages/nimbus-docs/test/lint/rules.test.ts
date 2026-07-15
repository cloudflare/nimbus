import assert from "node:assert/strict";
import { test } from "node:test";

import { lintFile, parseSource } from "../../src/lint/index.js";
import type { DiagnosticFix, RuleCode } from "../../src/lint/index.js";

const FM = `---
title: Test
description: A description.
---
`;

function parse(source: string, collection: string | null = null) {
  return parseSource(source, {
    path: "x.mdx",
    absPath: "/x.mdx",
    collection,
  });
}

function only(source: string, code: RuleCode, options?: Record<string, unknown>) {
  return lintFile(parse(source), {
    only: code,
    rules: options ? { [code]: ["error", options] } : {},
  });
}

/** Apply a fix's edits to the source (right-to-left so offsets stay valid). */
function applyFix(source: string, fix: DiagnosticFix): string {
  let out = source;
  const edits = [...fix.edits].sort((a, b) => b.range[0] - a.range[0]);
  for (const e of edits) {
    out = out.slice(0, e.range[0]) + e.text + out.slice(e.range[1]);
  }
  return out;
}

test("heading-punctuation flags and fixes a trailing colon", () => {
  const src = `${FM}\n## Section:\n`;
  const diags = only(src, "nimbus/heading-punctuation");
  assert.equal(diags.length, 1);
  assert.ok(diags[0]!.fix);
  const fixed = applyFix(src, diags[0]!.fix!);
  assert.ok(fixed.includes("## Section\n"));
  assert.ok(!fixed.includes("Section:"));
});

test("list-marker-style fixes an asterisk to the default dash", () => {
  const src = `${FM}\n* an item\n`;
  const diags = only(src, "nimbus/list-marker-style");
  assert.equal(diags.length, 1);
  const fixed = applyFix(src, diags[0]!.fix!);
  assert.ok(fixed.includes("- an item"));
});

test("list-marker-style honors the asterisk option", () => {
  const src = `${FM}\n- an item\n`;
  const diags = only(src, "nimbus/list-marker-style", { style: "asterisk" });
  assert.equal(diags.length, 1);
  assert.ok(applyFix(src, diags[0]!.fix!).includes("* an item"));
});

test("emphasis-style fixes underscores to the default asterisk", () => {
  const src = `${FM}\nSome _em_ word.\n`;
  const diags = only(src, "nimbus/emphasis-style");
  assert.equal(diags.length, 1);
  const fixed = applyFix(src, diags[0]!.fix!);
  assert.ok(fixed.includes("*em*"));
  assert.ok(!fixed.includes("_em_"));
});

test("duplicate-heading-text flags the second occurrence only", () => {
  const src = `${FM}\n## Setup\n\ntext\n\n## Setup\n`;
  const diags = only(src, "nimbus/duplicate-heading-text");
  assert.equal(diags.length, 1);
  assert.match(diags[0]!.message, /duplicate heading "Setup"/);
});

test("bare-url flags a naked external link", () => {
  const src = `${FM}\nVisit https://example.com today.\n`;
  const diags = only(src, "nimbus/bare-url");
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/bare-url");
});

test("code-block-prompt-prefix flags a $-prefixed shell block", () => {
  const src = `${FM}\n\`\`\`bash\n$ echo hi\n\`\`\`\n`;
  const diags = only(src, "nimbus/code-block-prompt-prefix");
  assert.equal(diags.length, 1);
});

test("no-self-host-url flags localhost links always", () => {
  const src = `${FM}\n[here](http://localhost:3000/x)\n`;
  const diags = only(src, "nimbus/no-self-host-url");
  assert.equal(diags.length, 1);
});

test("no-self-host-url flags a configured production host", () => {
  const src = `${FM}\n[here](https://docs.example.com/page)\n`;
  const diags = only(src, "nimbus/no-self-host-url", {
    hosts: ["docs.example.com"],
  });
  assert.equal(diags.length, 1);
});

test("no-self-host-url infers the deploy host from ctx.site automatically", () => {
  const src = `${FM}\n[here](https://docs.example.com/page)\n`;
  const diags = lintFile(parse(src), {
    only: "nimbus/no-self-host-url",
    site: "https://docs.example.com",
  });
  assert.equal(diags.length, 1, "ctx.site should be banned without `hosts` config");
});

test("no-self-host-url stays silent on a different host even when ctx.site is set", () => {
  const src = `${FM}\n[mdn](https://developer.mozilla.org/en-US/)\n`;
  const diags = lintFile(parse(src), {
    only: "nimbus/no-self-host-url",
    site: "https://docs.example.com",
  });
  assert.deepEqual(diags, []);
});

test("no-self-host-url tolerates a malformed ctx.site without crashing", () => {
  const src = `${FM}\n[here](http://localhost:3000/x)\n`;
  const diags = lintFile(parse(src), {
    only: "nimbus/no-self-host-url",
    site: "not-a-valid-url",
  });
  // Falls back to the always-banned localhost catch.
  assert.equal(diags.length, 1);
});

test("a malformed MDX file yields nimbus/mdx-syntax, not a crash", () => {
  // `<http://x>` is a markdown autolink but invalid MDX (bare `<`).
  const src = `${FM}\nText with <http://x> in it.\n`;
  const diags = lintFile(parse(src));
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/mdx-syntax");
  assert.equal(diags[0]!.severity, "error");
});
