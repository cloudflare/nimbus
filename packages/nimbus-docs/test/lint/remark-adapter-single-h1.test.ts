/**
 * remark-lint adapter parity — detect-only.
 *
 * Compares the hand-rolled `nimbus/single-h1` rule against
 * `remark-lint-no-multiple-toplevel-headings` run through the
 * remark-lint adapter. Both are fed the same Sätteri-parsed mdast tree.
 *
 * Asserts:
 * - Both rules detect the same set of violations on each fixture.
 * - Reported positions (line/column) match within 1 column.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import remarkLintNoMultipleTopLevelHeadings from "remark-lint-no-multiple-toplevel-headings";

import { parseSource } from "../../src/lint/parse.js";
import { runRemarkLintRule } from "../../src/lint/remark-lint-adapter.js";
import { singleH1 } from "../../src/lint/rules/single-h1.js";
import type { RuleReport } from "../../src/lint/rule.js";

const FM = `---
title: Test
description: A description.
---
`;

function parse(source: string) {
  return parseSource(source, {
    path: "x.mdx",
    absPath: "/x.mdx",
    collection: null,
  });
}

function runHandRolled(source: string): RuleReport[] {
  const file = parse(source);
  const reports: RuleReport[] = [];
  singleH1.run({
    file,
    options: {},
    report: (r) => reports.push(r),
  });
  return reports;
}

function runViaAdapter(source: string): RuleReport[] {
  const file = parse(source);
  return runRemarkLintRule(remarkLintNoMultipleTopLevelHeadings, file.tree, {
    path: file.path,
    source: file.source,
  });
}

type Fixture = {
  name: string;
  source: string;
  /** Expected violation count — both rules should detect this many. */
  expectedCount: number;
};

const FIXTURES: Fixture[] = [
  {
    name: "clean — single H1",
    source: `${FM}\n# Only title\n\nBody text.\n`,
    expectedCount: 0,
  },
  {
    name: "no H1 at all — fine (layout renders title from frontmatter)",
    source: `${FM}\n## Section\n\nBody.\n`,
    expectedCount: 0,
  },
  {
    name: "two H1s back to back",
    source: `${FM}\n# First\n\n# Second\n`,
    expectedCount: 1,
  },
  {
    name: "three H1s scattered through the page",
    source: `${FM}\n# First\n\n## Sub\n\n# Second\n\nBody.\n\n# Third\n`,
    expectedCount: 2,
  },
  {
    name: "H1 mixed with H2/H3",
    source: `${FM}\n# Title\n\n## A\n\n### A.1\n\n# Other\n\n## B\n`,
    expectedCount: 1,
  },
];

for (const fx of FIXTURES) {
  test(`Spike A — ${fx.name}`, () => {
    const hand = runHandRolled(fx.source);
    const remark = runViaAdapter(fx.source);

    // First: do they detect the same number of violations?
    assert.equal(
      hand.length,
      fx.expectedCount,
      `hand-rolled count drift on "${fx.name}": expected ${fx.expectedCount}, got ${hand.length}`,
    );
    assert.equal(
      remark.length,
      fx.expectedCount,
      `remark-lint count drift on "${fx.name}": expected ${fx.expectedCount}, got ${remark.length}`,
    );

    // Then: do their positions match within 1 column on each violation?
    for (let i = 0; i < hand.length; i++) {
      const h = hand[i]!;
      const r = remark[i]!;
      assert.equal(
        h.line,
        r.line,
        `line drift on violation ${i} in "${fx.name}": hand=${h.line}, remark=${r.line}`,
      );
      assert.ok(
        Math.abs(h.column - r.column) <= 1,
        `column drift > 1 on violation ${i} in "${fx.name}": hand=${h.column}, remark=${r.column}`,
      );
    }
  });
}

test("Spike A — adapter handles MDX-specific fixtures without crashing", () => {
  // MDX-flavored content: imports + components + JSX inside markdown.
  // remark-lint rules were written against remark-parse's mdast; this
  // verifies they tolerate Sätteri's parser on MDX inputs.
  const mdxSource = `${FM}
import { Card } from "~/components";

# Title

<Card title="Hello">
  Some content with **emphasis**.
</Card>

## Section

\`\`\`ts
const x = 1;
\`\`\`

# Second top-level
`;

  const hand = runHandRolled(mdxSource);
  const remark = runViaAdapter(mdxSource);

  assert.equal(hand.length, 1, "hand-rolled should flag the second H1");
  assert.equal(remark.length, 1, "remark-lint should flag the second H1");
  assert.equal(hand[0]!.line, remark[0]!.line, "line agreement on MDX fixture");
});
