/**
 * Tests for the admonition transform (`:::type … :::` → `<Aside>`).
 *
 * Regression focus: a directive nested inside indented JSX (e.g. `:::note`
 * inside a `<TabItem>` that itself sits inside a list item) must emit an
 * `<Aside>` at the SAME indentation. Emitting it flush-left at column 0
 * would dedent out of the enclosing element and orphan its closing tag,
 * making `@mdx-js/mdx` throw "Expected a closing tag for `<TabItem>`". The
 * e2e test below compiles the transformed output through the real MDX
 * compiler to prove this; the string tests pin the exact indentation
 * behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { compile } from "@mdx-js/mdx";

import { transformAdmonitions } from "../src/_internal/admonition-transform.js";

// The minimal source that reproduces the bug: a `:::note` inside an inner
// `<Tabs>/<TabItem>` that is indented inside a numbered-list item. (A
// non-indented Tabs does NOT reproduce it — the enclosing `listItem` context
// is what makes a dedented Aside orphan the TabItem.)
const NESTED_NOTE_IN_TAB = `<Tabs> <TabItem label="Dashboard">

1. Step one.
2. Nested tabs:

        <Tabs> <TabItem label="Add an IP">

        Body line.

        :::note

        Note body.
        :::

        </TabItem> </Tabs>

</TabItem> </Tabs>
`;

// ---------------------------------------------------------------------------
// E2E: output must compile through @mdx-js/mdx
// ---------------------------------------------------------------------------

test("e2e: nested note-in-tab output compiles through @mdx-js/mdx", async () => {
  const out = transformAdmonitions(NESTED_NOTE_IN_TAB);
  // Must not throw "Expected a closing tag for <TabItem>".
  await assert.doesNotReject(() => compile(out));
});

test("e2e: the OLD flush-left emit would fail to compile (proves the test is real)", async () => {
  // Reconstruct a flush-left emit: the Aside dedented to column 0 inside the
  // indented TabItem. This MUST throw, otherwise the e2e test above proves
  // nothing.
  const oldStyle = NESTED_NOTE_IN_TAB.replace(
    /[ \t]*:::note\n\n([\s\S]*?)\n[ \t]*:::/,
    '\n\n<Aside type="note">\n\n$1\n\n</Aside>\n\n',
  );
  await assert.rejects(() => compile(oldStyle), /Expected a closing tag/i);
});

// ---------------------------------------------------------------------------
// Indentation behavior (string-level)
// ---------------------------------------------------------------------------

test("indented note is re-indented to the directive's depth (fails on old code)", () => {
  const src = [
    '<Tabs> <TabItem label="A">',
    "",
    "        :::note",
    "",
    "        Inside note.",
    "        :::",
    "",
    "        </TabItem> </Tabs>",
    "",
  ].join("\n");
  const out = transformAdmonitions(src);
  // Aside + closing tag at the directive's 8-space indent.
  assert.match(out, /\n {8}<Aside type="note">/);
  assert.match(out, /\n {8}<\/Aside>/);
  // Body kept at exactly 8 spaces — not flush-left and not over-indented.
  assert.match(out, /\n {8}Inside note\./);
  // No column-0 Aside leaked out of the TabItem.
  assert.doesNotMatch(out, /\n<Aside/);
});

test("multi-line body preserves relative nesting without becoming a code block", () => {
  // Directive at 6 spaces; a child line 2 spaces deeper (8). The child must
  // end up exactly 2 spaces deeper than the Aside (8), NOT 4+ deeper (which
  // markdown would render as a code block).
  const src = [
    "      :::note",
    "",
    "      Lead line.",
    "        Nested two-space-deeper line.",
    "      :::",
    "",
  ].join("\n");
  const out = transformAdmonitions(src);
  assert.match(out, /\n {6}<Aside type="note">/);
  assert.match(out, /\n {6}Lead line\./);
  assert.match(out, /\n {8}Nested two-space-deeper line\./);
  // Not pushed to code-block depth (10 = 4 deeper than the Aside).
  assert.doesNotMatch(out, /\n {10}Nested two-space-deeper line\./);
});

// ---------------------------------------------------------------------------
// Line-anchoring behavior
// ---------------------------------------------------------------------------

test("a mid-line `:::` is not treated as an opener", () => {
  const src = "Prose with a stray :::note token mid-sentence ::: and more.\n";
  assert.equal(transformAdmonitions(src), src);
});

test("a closer with trailing text on its line does not close the directive", () => {
  // Closer not at line end → not a valid closer → left untouched.
  const src = ":::note\nbody\n::: trailing text\n";
  assert.equal(transformAdmonitions(src), src);
});

// ---------------------------------------------------------------------------
// Documented guarantees
// ---------------------------------------------------------------------------

test("transform is idempotent", () => {
  const once = transformAdmonitions(NESTED_NOTE_IN_TAB);
  const twice = transformAdmonitions(once);
  assert.equal(twice, once);
});

test("`:::` inside frontmatter is never rewritten (frontmatter is split off)", () => {
  // Block scalar containing the directive token: only a real `splitFrontmatter`
  // keeps this intact. (A `tip:` key with no `:::` would pass trivially even if
  // splitting were broken — so the value must carry a `:::` to be a true test.)
  const src =
    "---\ndescription: |\n  :::note\n  in frontmatter\n  :::\n---\n\n:::tip\nreal body\n:::\n";
  const out = transformAdmonitions(src);
  // The `:::` inside the YAML block scalar survives untouched...
  assert.match(out, /description: \|\n {2}:::note\n {2}in frontmatter\n {2}:::/);
  // ...while the real body below the frontmatter is still transformed.
  assert.match(out, /<Aside type="tip">/);
});

test("adjacent admonitions do not merge", () => {
  const out = transformAdmonitions(":::note\nfirst\n:::\n\n:::tip\nsecond\n:::\n");
  assert.match(out, /<Aside type="note">\n\nfirst/);
  assert.match(out, /<Aside type="tip">\n\nsecond/);
});

// ---------------------------------------------------------------------------
// Baseline behavior guards
// ---------------------------------------------------------------------------

test("flush-left block admonition still emits flush-left", () => {
  const out = transformAdmonitions("Intro.\n\n:::tip[Heads up]\nBody.\n:::\n");
  assert.match(out, /\n<Aside type="tip" title="Heads up">/);
});

test("inline single-line admonition is rewritten", () => {
  assert.match(transformAdmonitions(":::note Quick tip. :::\n"), /<Aside type="note">/);
});

test("MyST type aliases fold into the four Aside slots", () => {
  assert.match(transformAdmonitions(":::warning\nx\n:::\n"), /type="caution"/);
  assert.match(transformAdmonitions(":::info\nx\n:::\n"), /type="note"/);
});

test("unknown directive types are left untouched", () => {
  const src = ":::custom\nbody\n:::\n";
  assert.equal(transformAdmonitions(src), src);
});

test("`:::` inside a fenced code block is preserved verbatim", () => {
  const src = "```md\n:::note\nnot an admonition\n:::\n```\n";
  assert.equal(transformAdmonitions(src), src);
});
