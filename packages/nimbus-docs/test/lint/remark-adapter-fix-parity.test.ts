/**
 * remark-lint adapter parity — fixable rule with surgical fix.
 *
 * Compares the hand-rolled `nimbus/list-marker-style` (which walks
 * listItem nodes and reads their offsets) against
 * `remark-lint-unordered-list-marker-style` run through the adapter
 * (which reports line/col only). Verifies the character offset can be
 * recovered from line/col reliably enough to produce byte-identical
 * surgical fixes.
 *
 * Asserts:
 * - Both implementations report the same violation count + positions.
 * - The fix edits produce byte-identical output.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import remarkLintUnorderedListMarkerStyle from "remark-lint-unordered-list-marker-style";

import { parseSource } from "../../src/lint/parse.js";
import { runRemarkLintRule } from "../../src/lint/remark-lint-adapter.js";
import { listMarkerStyle } from "../../src/lint/rules/list-marker-style.js";
import type { DiagnosticFix } from "../../src/lint/diagnostic.js";
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

/** Convert a 1-based (line, column) into a 0-based character offset. */
function offsetAt(source: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;
  for (let i = 0; i < source.length; i++) {
    if (currentLine === line) {
      return offset + (column - 1);
    }
    if (source[i] === "\n") currentLine++;
    offset++;
  }
  return offset;
}

function runHandRolled(source: string): RuleReport[] {
  const file = parse(source);
  const reports: RuleReport[] = [];
  listMarkerStyle.run({
    file,
    options: { style: "dash" },
    report: (r) => reports.push(r),
  });
  return reports;
}

/**
 * Run the remark-lint rule and augment each report with a surgical fix.
 * The "wrapper" — this is what would replace the hand-rolled list-marker-style
 * rule body. Adapter handles the detection; this code handles offset → fix.
 */
function runViaAdapter(source: string): RuleReport[] {
  const file = parse(source);
  const reports = runRemarkLintRule(
    remarkLintUnorderedListMarkerStyle,
    file.tree,
    { path: file.path, source: file.source },
  );

  // Configure: we want dash style. The rule's default is "consistent" —
  // we'd pass options through the unified plugin call for the real
  // adapter; for the spike, the source's first marker is `-` so the rule
  // naturally enforces dashes.

  return reports.map((r) => {
    const offset = offsetAt(source, r.line, r.column);
    const found = source[offset];

    // The fix is identical to the hand-rolled rule's:
    // change the one-character marker at this offset to "-".
    const fix: DiagnosticFix = {
      description: `change "${found}" to "-"`,
      edits: [{ range: [offset, offset + 1], text: "-" }],
    };
    return { ...r, fix };
  });
}

/** Apply a fix to a source string (right-to-left so offsets stay valid). */
function applyFix(source: string, fix: DiagnosticFix): string {
  let out = source;
  const edits = [...fix.edits].sort((a, b) => b.range[0] - a.range[0]);
  for (const e of edits) {
    out = out.slice(0, e.range[0]) + e.text + out.slice(e.range[1]);
  }
  return out;
}

type Fixture = {
  name: string;
  source: string;
  expectedViolations: number;
};

const FIXTURES: Fixture[] = [
  {
    name: "clean — all dashes",
    source: `${FM}
- first
- second
- third
`,
    expectedViolations: 0,
  },
  {
    name: "single asterisk after dashes",
    source: `${FM}
- first
- second
* third
`,
    expectedViolations: 1,
  },
  {
    name: "mixed bullets",
    source: `${FM}
- a
* b
+ c
- d
`,
    expectedViolations: 2,
  },
];

for (const fx of FIXTURES) {
  test(`Spike B — ${fx.name}`, () => {
    const hand = runHandRolled(fx.source);
    const remark = runViaAdapter(fx.source);

    // Count agreement: both detect the same number of violations.
    assert.equal(
      hand.length,
      fx.expectedViolations,
      `hand-rolled count drift on "${fx.name}": expected ${fx.expectedViolations}, got ${hand.length}`,
    );
    assert.equal(
      remark.length,
      fx.expectedViolations,
      `remark-lint count drift on "${fx.name}": expected ${fx.expectedViolations}, got ${remark.length}`,
    );

    // Position agreement: line + column exact match, since both implementations
    // anchor on the same node start.
    for (let i = 0; i < hand.length; i++) {
      const h = hand[i]!;
      const r = remark[i]!;
      assert.equal(h.line, r.line, `line drift on violation ${i}`);
      assert.equal(h.column, r.column, `column drift on violation ${i}`);
    }

    // Fix agreement: applying both rule sets' fixes to the source produces
    // byte-identical output. This is the load-bearing claim — if it holds,
    // we can swap the implementation without breaking --fix.
    if (hand.length > 0) {
      let handFixed = fx.source;
      let remarkFixed = fx.source;
      for (const r of [...hand].reverse()) {
        if (r.fix) handFixed = applyFix(handFixed, r.fix);
      }
      for (const r of [...remark].reverse()) {
        if (r.fix) remarkFixed = applyFix(remarkFixed, r.fix);
      }
      assert.equal(
        handFixed,
        remarkFixed,
        `fix output drift on "${fx.name}":\n--- hand-rolled\n${handFixed}\n--- remark-lint\n${remarkFixed}`,
      );
    }
  });
}
