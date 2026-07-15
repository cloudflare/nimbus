import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  fixPaths,
  lintFile,
  lintPaths,
  parseSource,
} from "../../src/lint/index.js";
import type { Diagnostic, RuleCode } from "../../src/lint/index.js";

function parse(source: string, collection: string | null = null) {
  return parseSource(source, {
    path: "fixture.mdx",
    absPath: "/abs/fixture.mdx",
    collection,
  });
}

/** 1-based line a substring first appears on. */
function lineOf(source: string, needle: string): number {
  const idx = source.split("\n").findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`needle not found: ${needle}`);
  return idx + 1;
}

function codes(diags: Diagnostic[]): RuleCode[] {
  return diags.map((d) => d.code);
}

const VALID_FRONTMATTER = `---
title: Test
description: A valid description.
---
`;

test("authoring rules are off by default — opt-in posture", () => {
  // A file that would trip multiple rules if they were on (no description,
  // two H1s, no code-block language) must produce zero diagnostics under the
  // bare framework default. The project opts into what it wants in
  // `astro.config.ts`.
  const src = `---
title: Bare
---

# One

# Two

\`\`\`
no lang
\`\`\`
`;
  assert.deepEqual(lintFile(parse(src)), []);
});

test("--rule force-enables a rule that's off by default", () => {
  // The CLI's --rule=<code> flag would silently print nothing if it just
  // filtered: every authoring rule starts off. Engine compensates by
  // force-enabling the named rule at error when the user hasn't authored
  // an explicit setting (including "off").
  const src = `${VALID_FRONTMATTER}\n# One\n\n# Two\n`;
  const diags = lintFile(parse(src), { only: "nimbus/single-h1" });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/single-h1");
});

test("--rule respects an explicit off — user config wins over the CLI shortcut", () => {
  const src = `${VALID_FRONTMATTER}\n# One\n\n# Two\n`;
  const diags = lintFile(parse(src), {
    only: "nimbus/single-h1",
    rules: { "nimbus/single-h1": "off" },
  });
  assert.deepEqual(diags, []);
});

test("--rule overrides a per-collection off — silent-zero-coverage is the failure mode --rule exists to prevent", () => {
  // User has no top-level setting for single-h1 (force-enable kicks in)
  // but has set it to "off" for the docs collection. Without the
  // collection-aware force-enable, `--rule=nimbus/single-h1` would silently
  // print nothing for docs files. The CLI flag wins.
  const src = `${VALID_FRONTMATTER}\n# One\n\n# Two\n`;
  const diags = lintFile(parse(src, "docs"), {
    only: "nimbus/single-h1",
    collections: { docs: { rules: { "nimbus/single-h1": "off" } } },
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/single-h1");
});


test("a clean file produces no diagnostics", () => {
  const src = `${VALID_FRONTMATTER}
# Title

Some prose.

## Section

\`\`\`ts
const a = 1;
\`\`\`
`;
  assert.deepEqual(lintFile(parse(src)), []);
});

test("single-h1 flags every H1 after the first, at the right line", () => {
  const src = `${VALID_FRONTMATTER}
# First

text

# Second
`;
  const diags = lintFile(parse(src), { only: "nimbus/single-h1" });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/single-h1");
  assert.equal(diags[0]!.line, lineOf(src, "# Second"));
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.source, "docs-compiler");
});

test("heading-hierarchy flags a skipped level", () => {
  const src = `${VALID_FRONTMATTER}
# Title

## Section

#### Skipped H3
`;
  const diags = lintFile(parse(src), { only: "nimbus/heading-hierarchy" });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.line, lineOf(src, "#### Skipped H3"));
  assert.match(diags[0]!.message, /h2 to h4/);
});

test("code-block-lang flags a fence with no language", () => {
  const src = `${VALID_FRONTMATTER}
# Title

\`\`\`
no lang here
\`\`\`
`;
  const diags = lintFile(parse(src), { only: "nimbus/code-block-lang" });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/code-block-lang");
});

test("description-required fires when description is missing", () => {
  const src = `---
title: No Description
---

# Title
`;
  const diags = lintFile(parse(src), { only: "nimbus/description-required" });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.code, "nimbus/description-required");
});

test("description-required is collection-agnostic — partials are exempted via config, not a hardcoded skip", () => {
  // Projects that don't want partials to require a description opt out
  // via the per-collection override below. Without that override, the rule
  // fires on partials too — explicit > implicit, in line with the
  // collections.<name>.rules contract.
  const src = `---
params: ["name"]
---

Some shared fragment.
`;
  // Baseline: rule opted in, no per-collection override → fires on partials.
  const baselineDiags = lintFile(parse(src, "partials"), {
    rules: { "nimbus/description-required": "error" },
  }).filter((d) => d.code === "nimbus/description-required");
  assert.equal(baselineDiags.length, 1);

  // With the documented per-collection override: silenced.
  const exemptedDiags = lintFile(parse(src, "partials"), {
    rules: { "nimbus/description-required": "error" },
    collections: {
      partials: { rules: { "nimbus/description-required": "off" } },
    },
  }).filter((d) => d.code === "nimbus/description-required");
  assert.deepEqual(exemptedDiags, []);
});

test('severity "off" silences a rule', () => {
  const src = `${VALID_FRONTMATTER}
# One

# Two
`;
  const diags = lintFile(parse(src), {
    rules: { "nimbus/single-h1": "off" },
  });
  assert.ok(!codes(diags).includes("nimbus/single-h1"));
});

test('severity "warn" downgrades a rule', () => {
  const src = `${VALID_FRONTMATTER}
# One

# Two
`;
  const diags = lintFile(parse(src), {
    rules: { "nimbus/single-h1": "warn" },
    only: "nimbus/single-h1",
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.severity, "warn");
});

test('tuple form round-trips options to the rule', () => {
  const src = `${VALID_FRONTMATTER}
# Title

\`\`\`
no lang
\`\`\`
`;
  // The allow option is accepted; the rule still flags the empty-lang case.
  const diags = lintFile(parse(src), {
    rules: { "nimbus/code-block-lang": ["error", { allow: ["mermaid"] }] },
    only: "nimbus/code-block-lang",
  });
  assert.equal(diags.length, 1);
});

test("frontmatter nimbusDisableRules suppresses a rule file-wide", () => {
  const src = `---
title: Test
description: ok
nimbusDisableRules: ["nimbus/single-h1"]
---

# One

# Two
`;
  // Opt single-h1 in so we can verify the disable actually suppresses it
  // (rather than the rule being off by default for unrelated reasons).
  const diags = lintFile(parse(src), {
    rules: { "nimbus/single-h1": "error" },
  });
  assert.ok(!codes(diags).includes("nimbus/single-h1"));
});

test("an inline disable comment suppresses the next line", () => {
  const src = `${VALID_FRONTMATTER}
# One

{/* nimbus-rule-disable-next-line nimbus/single-h1 */}
# Two
`;
  const diags = lintFile(parse(src), { only: "nimbus/single-h1" });
  assert.deepEqual(diags, []);
});

test("a typo'd code in nimbusDisableRules is surfaced, not silently ignored", () => {
  const src = `---
title: Test
description: ok
nimbusDisableRules: ["nimbus/single-h2"]
---

# One

# Two
`;
  // Authoring rules are opt-in — explicitly enable the rule the typo was
  // trying to silence so we can confirm the typo didn't actually silence it.
  const diags = lintFile(parse(src), {
    rules: { "nimbus/single-h1": "error" },
  });
  const fm = diags.find((d) => d.code === "nimbus/frontmatter-shape");
  assert.ok(fm, "expected a frontmatter-shape diagnostic for the unknown code");
  assert.match(fm!.message, /nimbus\/single-h2/);
  // And the typo did NOT silently disable anything — single-h1 still fires.
  assert.ok(diags.some((d) => d.code === "nimbus/single-h1"));
});

test("a typo'd inline disable code is surfaced, not silently ignored", () => {
  const src = `${VALID_FRONTMATTER}
# One

{/* nimbus-rule-disable-next-line nimbus/sigle-h1 */}
# Two
`;
  const diags = lintFile(parse(src), {
    rules: { "nimbus/single-h1": "error" },
  });
  const fm = diags.find((d) => d.code === "nimbus/frontmatter-shape");
  assert.ok(fm, "expected a frontmatter-shape diagnostic for the typo");
  assert.match(fm!.message, /nimbus\/sigle-h1/);
  // And the typo'd disable did NOT actually suppress the real rule.
  assert.ok(diags.some((d) => d.code === "nimbus/single-h1"));
});

test("an empty nimbusDisableRules array is itself an error", () => {
  const src = `---
title: Test
description: ok
nimbusDisableRules: []
---

# Title
`;
  const diags = lintFile(parse(src));
  const fm = diags.find((d) => d.code === "nimbus/frontmatter-shape");
  assert.ok(fm, "expected a frontmatter-shape diagnostic");
  assert.equal(fm!.severity, "error");
  assert.match(fm!.message, /empty/);
  assert.equal(fm!.line, lineOf(src, "nimbusDisableRules"));
});

// ---------------------------------------------------------------------------
// Path-level resilience (lintPaths / fixPaths)
// ---------------------------------------------------------------------------

function withTmpProject(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-eng-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("lintPaths skips a missing file and continues with the rest", () => {
  const { root, cleanup } = withTmpProject();
  try {
    const good = path.join(root, "good.mdx");
    fs.writeFileSync(
      good,
      `${VALID_FRONTMATTER}\n# One\n\n# Two\n`,
    );
    const missing = path.join(root, "ghost.mdx");
    // capture stderr so the test output stays clean
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((s: string | Uint8Array) => {
      captured.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const diags = lintPaths([missing, good], root, {
        rules: { "nimbus/single-h1": "error" },
      });
      // Good file's single-h1 still fires.
      assert.ok(diags.some((d) => d.code === "nimbus/single-h1"));
      assert.ok(
        captured.some((s) => s.includes("ghost.mdx")),
        "should have warned about the missing file",
      );
    } finally {
      process.stderr.write = original;
    }
  } finally {
    cleanup();
  }
});

test("fixPaths writes atomically and rewrites the file on disk", () => {
  const { root, cleanup } = withTmpProject();
  try {
    const file = path.join(root, "src", "content", "docs", "page.mdx");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${VALID_FRONTMATTER}\n## Title:\n\n* one\n`);
    const before = fs.readFileSync(file, "utf8");

    const result = fixPaths([file], root, {
      rules: {
        "nimbus/heading-punctuation": "error",
        "nimbus/list-marker-style": "error",
      },
    });
    assert.ok(result.fixed >= 2, "expected at least 2 fixes");
    assert.equal(result.filesChanged, 1);

    const after = fs.readFileSync(file, "utf8");
    assert.notEqual(after, before);
    assert.ok(after.includes("## Title\n"), "trailing colon removed");
    assert.ok(after.includes("- one"), "bullet normalized");

    // No stray tmp file lingering after a successful write.
    const stray = fs
      .readdirSync(path.dirname(file))
      .filter((n) => n.includes(".nimbus-tmp"));
    assert.deepEqual(stray, []);
  } finally {
    cleanup();
  }
});

test("fixPaths skips a missing file and continues fixing the rest", () => {
  const { root, cleanup } = withTmpProject();
  try {
    const good = path.join(root, "good.mdx");
    fs.writeFileSync(good, `${VALID_FRONTMATTER}\n## Title:\n`);
    const missing = path.join(root, "ghost.mdx");

    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const result = fixPaths([missing, good], root, {
        rules: { "nimbus/heading-punctuation": "error" },
      });
      // good.mdx still got fixed even though ghost.mdx failed.
      assert.equal(result.filesChanged, 1);
      const after = fs.readFileSync(good, "utf8");
      assert.ok(after.includes("## Title\n"));
    } finally {
      process.stderr.write = original;
    }
  } finally {
    cleanup();
  }
});

test("fixPaths honors an already-aborted signal and writes nothing", () => {
  const { root, cleanup } = withTmpProject();
  try {
    const file = path.join(root, "x.mdx");
    const original = `${VALID_FRONTMATTER}\n## Title:\n`;
    fs.writeFileSync(file, original);
    const ac = new AbortController();
    ac.abort();
    const result = fixPaths([file], root, {
      signal: ac.signal,
      rules: { "nimbus/heading-punctuation": "error" },
    });
    assert.equal(result.filesChanged, 0);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Per-collection rules — the 4-layer precedence contract
// ---------------------------------------------------------------------------

test("per-collection rules override top-level for files in that collection", () => {
  // Top-level enables single-h1 at error; partials collection turns it off.
  // A partial with multiple H1s should NOT fire single-h1.
  const src = `${VALID_FRONTMATTER}\n# One\n\n# Two\n`;
  const diags = lintFile(parse(src, "partials"), {
    rules: { "nimbus/single-h1": "error" },
    collections: {
      partials: { rules: { "nimbus/single-h1": "off" } },
    },
  });
  assert.ok(!codes(diags).includes("nimbus/single-h1"));
});

test("per-collection rules do not affect a different collection", () => {
  // Same config, but the file is in `docs` not `partials` — single-h1 fires.
  const src = `${VALID_FRONTMATTER}\n# One\n\n# Two\n`;
  const diags = lintFile(parse(src, "docs"), {
    rules: { "nimbus/single-h1": "error" },
    collections: {
      partials: { rules: { "nimbus/single-h1": "off" } },
    },
  });
  assert.ok(codes(diags).includes("nimbus/single-h1"));
});

test("4-layer precedence: per-file nimbusDisableRules beats per-collection rules", () => {
  // Top-level: single-h1 error. Collection: single-h1 warn. Per-file: disabled.
  // Expected: no single-h1 diagnostic (per-file disable wins).
  const src = `---
title: Test
description: ok
nimbusDisableRules: ["nimbus/single-h1"]
---

# One

# Two
`;
  const diags = lintFile(parse(src, "docs"), {
    rules: { "nimbus/single-h1": "error" },
    collections: {
      docs: { rules: { "nimbus/single-h1": "warn" } },
    },
  });
  assert.ok(!codes(diags).includes("nimbus/single-h1"));
});

test("4-layer precedence: per-line inline disable beats per-collection rules", () => {
  const src = `${VALID_FRONTMATTER}
# One

{/* nimbus-rule-disable-next-line nimbus/single-h1 */}
# Two
`;
  const diags = lintFile(parse(src, "docs"), {
    rules: { "nimbus/single-h1": "error" },
    collections: { docs: { rules: { "nimbus/single-h1": "warn" } } },
  });
  assert.deepEqual(diags.filter((d) => d.code === "nimbus/single-h1"), []);
});

test("diagnostics are sorted by position", () => {
  const src = `---
title: Test
---

#### Skip

\`\`\`
nolang
\`\`\`
`;
  // Opt every rule in so we exercise multi-rule ordering.
  const diags = lintFile(parse(src), {
    rules: {
      "nimbus/description-required": "error",
      "nimbus/heading-hierarchy": "error",
      "nimbus/code-block-lang": "error",
    },
  });
  for (let i = 1; i < diags.length; i++) {
    const prev = diags[i - 1]!;
    const cur = diags[i]!;
    assert.ok(
      prev.line < cur.line ||
        (prev.line === cur.line && prev.column <= cur.column),
      "diagnostics should be ordered by line then column",
    );
  }
});
