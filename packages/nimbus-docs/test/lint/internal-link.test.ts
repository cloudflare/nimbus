/**
 * Tests for `nimbus/internal-link`.
 *
 * The rule reads `.nimbus/routes.json` from the project root inferred via
 * the parsed file's absolute path (`<root>/src/content/.../page.mdx`). Each
 * test stages a tmpdir, writes a `routes.json`, parses an MDX source
 * against an `absPath` under that root, and asserts the diagnostics.
 *
 * Tests reset the rule's process-level cache between cases via the
 * test-only `_resetInternalLinkCacheForTests` export.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lintFile } from "../../src/lint/engine.js";
import { parseSource } from "../../src/lint/parse.js";
import { _resetInternalLinkCacheForTests } from "../../src/lint/rules/internal-link.js";
import type { RouteTruth } from "../../src/lint/site-model.js";

interface Setup {
  root: string;
  pagePath: string;
}

function setupProject(truth: RouteTruth): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-il-"));
  fs.mkdirSync(path.join(root, ".nimbus"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".nimbus", "routes.json"),
    JSON.stringify(truth),
  );
  fs.mkdirSync(path.join(root, "src/content/docs"), { recursive: true });
  return { root, pagePath: path.join(root, "src/content/docs/page.mdx") };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

const FM = `---
title: Test
description: A description for the test page.
---
`;

function lint(setup: Setup, mdx: string) {
  _resetInternalLinkCacheForTests();
  const parsed = parseSource(mdx, {
    path: "src/content/docs/page.mdx",
    absPath: setup.pagePath,
    collection: "docs",
  });
  // Authoring rules are opt-in; this helper exercises internal-link
  // specifically, so we enable it here.
  return lintFile(parsed, {
    rules: { "nimbus/internal-link": "error" },
  }).filter((d) => d.code === "nimbus/internal-link");
}

function baseTruth(overrides: Partial<RouteTruth> = {}): RouteTruth {
  return {
    version: 1,
    base: "",
    knownRoutes: ["/", "/workers", "/r2", "/guides/setup", "/search"],
    opaqueNamespaces: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

test("internal-link is silent on resolvable links", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

A good link to [Workers](/workers/) and [R2](/r2) and [Setup](/guides/setup).
The [search](/search) page is a static route.
A link to [home](/) resolves.
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link skips external and anchor-only links", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

- [Cloudflare](https://cloudflare.com)
- [Email](mailto:hi@example.com)
- [Protocol-relative](//example.com/foo)
- [Section](#a-heading)
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Broken
// ---------------------------------------------------------------------------

test("internal-link flags a broken link and suggests a near-match", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

Read about [Workers](/worker) — typo.
`,
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/worker"/);
    assert.match(diags[0]!.message, /did you mean "\/workers"/);
    assert.ok(diags[0]!.fix, "did-you-mean should populate a fix");
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link flags a broken link with no near-match plainly", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

Read about [Something](/totally-unrelated-page).
`,
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /no page resolves to this path/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link flags <a href> JSX too", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

<a href="/workers">Workers</a> — resolves.

<a href="/nope">Broken</a> — doesn't.
`,
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/nope"/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link resolves linkReference via definition", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

See [Workers][wk] for details. See [Broken][bk] for nothing.

[wk]: /workers
[bk]: /not-a-page
`,
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/not-a-page"/);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Relative links
// ---------------------------------------------------------------------------

test("internal-link errors on relative links by default", () => {
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

See [./other](./other) and [../up](../up).
`,
    );
    assert.equal(diags.length, 2);
    assert.match(diags[0]!.message, /relative link/);
    assert.match(diags[1]!.message, /relative link/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link tolerates relative links when allowRelative is on", () => {
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(
      `${FM}
# Title

See [./other](./other).
`,
      {
        path: "src/content/docs/page.mdx",
        absPath: setup.pagePath,
        collection: "docs",
      },
    );
    const diags = lintFile(parsed, {
      rules: { "nimbus/internal-link": ["error", { allowRelative: true }] },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Opacity (catch-all stays silent)
// ---------------------------------------------------------------------------

test("internal-link stays silent under an opaque namespace", () => {
  // A non-framework dynamic route under `/dashboard/**` makes the namespace
  // opaque. Links into it must NOT be flagged.
  const setup = setupProject(
    baseTruth({ opaqueNamespaces: ["/dashboard"] }),
  );
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

See [the dashboard](/dashboard/anything/at/all).
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link still checks links outside an opaque namespace", () => {
  const setup = setupProject(
    baseTruth({ opaqueNamespaces: ["/dashboard"] }),
  );
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

[Dashboard ok](/dashboard/x) and [broken](/nope).
`,
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/nope"/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link only resolves links that appear in knownRoutes", () => {
  // A URL not in knownRoutes and not under an opaque namespace is broken,
  // regardless of how the truth got populated.
  const setup = setupProject(
    baseTruth({ knownRoutes: ["/workers"] }),
  );
  try {
    const diags = lint(setup, `${FM}\n# x\n\n[broken](/missing)`);
    assert.equal(diags.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// base
// ---------------------------------------------------------------------------

test("internal-link honors the Astro base prefix", () => {
  const setup = setupProject(baseTruth({ base: "/docs" }));
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

Without base: [Workers](/workers) resolves.
With base prefix: [Workers](/docs/workers) also resolves.
Broken either way: [missing](/docs/missing).
`,
    );
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/docs\/missing"/);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// ignore option
// ---------------------------------------------------------------------------

test("internal-link respects the ignore glob list", () => {
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(
      `${FM}
# Title

[api/foo](/api/foo) ignored, [api root](/api) ignored, [nope](/nope) flagged.
`,
      {
        path: "src/content/docs/page.mdx",
        absPath: setup.pagePath,
        collection: "docs",
      },
    );
    const diags = lintFile(parsed, {
      rules: {
        "nimbus/internal-link": [
          "error",
          { ignore: ["/api/**", "/api"] },
        ],
      },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/nope"/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link applies ignore against the post-base form (not the raw URL)", () => {
  const setup = setupProject(baseTruth({ base: "/docs" }));
  try {
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(
      `${FM}
# Title

[full path](/docs/api/anything) and [bare path](/api/anything) — both ignored.
`,
      {
        path: "src/content/docs/page.mdx",
        absPath: setup.pagePath,
        collection: "docs",
      },
    );
    const diags = lintFile(parsed, {
      rules: { "nimbus/internal-link": ["error", { ignore: ["/api/**"] }] },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link ignore supports a leading any-depth wildcard", () => {
  // Matches "llms.txt" at any depth — the exact shape the old
  // exact-match-or-`prefix/**` matcher couldn't express.
  const leadingWildcard = "**/llms.txt";
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(
      `${FM}
# Title

[root](/llms.txt) and [nested](/workers/llms.txt) both ignored,
[flagged](/workers/llms-full.txt) is not.
`,
      {
        path: "src/content/docs/page.mdx",
        absPath: setup.pagePath,
        collection: "docs",
      },
    );
    const diags = lintFile(parsed, {
      rules: {
        "nimbus/internal-link": ["error", { ignore: [leadingWildcard] }],
      },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/workers\/llms-full\.txt"/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link ignore supports mid-segment wildcards and brace expansion", () => {
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(
      `${FM}
# Title

[mid](/rules/snippets/examples) and [brace](/videos/en/intro) both ignored,
[flagged](/rules/other/thing) is not.
`,
      {
        path: "src/content/docs/page.mdx",
        absPath: setup.pagePath,
        collection: "docs",
      },
    );
    const diags = lintFile(parsed, {
      rules: {
        "nimbus/internal-link": [
          "error",
          { ignore: ["/rules/{snippets,transform}/examples", "/videos/**"] },
        ],
      },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /broken link "\/rules\/other\/thing"/);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link ignore compiles a given pattern list once across files (cache correctness)", () => {
  // Regression guard: `matchesAnyIgnore` caches its compiled matcher keyed
  // on the *raw* `ignore` array's identity. Passing the exact same array
  // reference across two separate `lintFile` calls (as the resolved rule
  // config does across every file in a real run) must hit the cache and
  // still produce correct results the second time, not a stale/empty one.
  const setup = setupProject(baseTruth());
  const ignore = ["/api/**"];
  const rules = { "nimbus/internal-link": ["error", { ignore }] as const };
  try {
    _resetInternalLinkCacheForTests();
    const first = parseSource(`${FM}\n[a](/api/foo) [b](/nope)\n`, {
      path: "src/content/docs/page.mdx",
      absPath: setup.pagePath,
      collection: "docs",
    });
    const firstDiags = lintFile(first, { rules }).filter(
      (d) => d.code === "nimbus/internal-link",
    );
    assert.equal(firstDiags.length, 1);
    assert.match(firstDiags[0]!.message, /broken link "\/nope"/);

    const second = parseSource(`${FM}\n[c](/api/bar) [d](/also-nope)\n`, {
      path: "src/content/docs/page.mdx",
      absPath: setup.pagePath,
      collection: "docs",
    });
    const secondDiags = lintFile(second, { rules }).filter(
      (d) => d.code === "nimbus/internal-link",
    );
    assert.equal(secondDiags.length, 1);
    assert.match(secondDiags[0]!.message, /broken link "\/also-nope"/);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Missing route truth → silent skip
// ---------------------------------------------------------------------------

test("internal-link skips silently when routes.json is missing", () => {
  // Set up a project root WITHOUT writing routes.json.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-il-skip-"));
  try {
    fs.mkdirSync(path.join(root, "src/content/docs"), { recursive: true });
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(`${FM}\n# x\n\n[anything](/nope)`, {
      path: "src/content/docs/page.mdx",
      absPath: path.join(root, "src/content/docs/page.mdx"),
      collection: "docs",
    });
    const diags = lintFile(parsed, {
      rules: { "nimbus/internal-link": "error" },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.deepEqual(diags, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("internal-link skips draft sources entirely — frontmatter draft: true short-circuits the rule", () => {
  // Drafts are excluded from `routes.json` (Nimbus filters them from
  // content queries, sidebar, alternates). Linting a draft would surface
  // false positives every time it links to another draft. The trade-off:
  // a published-page → draft link is missed, but published → draft only
  // happens after a draft graduates, at which point it's published too.
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const src = `---
title: WIP
description: A work-in-progress page.
draft: true
---

# WIP

This page links somewhere that doesn't exist yet: [planning](/not-a-real-route).
And to another draft: [the other one](/other-wip-page).
`;
    const parsed = parseSource(src, {
      path: "src/content/docs/wip.mdx",
      absPath: setup.pagePath,
      collection: "docs",
    });
    const diags = lintFile(parsed, {
      rules: { "nimbus/internal-link": "error" },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.deepEqual(
      diags,
      [],
      "drafts get a free pass — their links are in-flight",
    );
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link still fires on a non-draft page even if the link target is broken", () => {
  // Sanity check that the draft skip is gated on draft: true specifically,
  // not just on the frontmatter field existing.
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const src = `---
title: Published
description: A published page.
draft: false
---

# Published

[broken](/nope)
`;
    const parsed = parseSource(src, {
      path: "src/content/docs/published.mdx",
      absPath: setup.pagePath,
      collection: "docs",
    });
    const diags = lintFile(parsed, {
      rules: { "nimbus/internal-link": "error" },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.equal(diags.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link percent-decodes URLs before lookup", () => {
  const setup = setupProject(
    baseTruth({ knownRoutes: ["/", "/guides/setup notes"] }),
  );
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

See [setup](/guides/setup%20notes).
`,
    );
    assert.deepEqual(
      diags,
      [],
      "an encoded URL should match its decoded route",
    );
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link does not check unconfigured JSX components", () => {
  // Custom components belong to the user — we don't presume any specific
  // ones exist. Without configuration, only `<a href>` is checked.
  const setup = setupProject(baseTruth());
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

<LinkCard href="/missing-card" />
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link components option extends <a href> with extra JSX checks", () => {
  const setup = setupProject(baseTruth());
  try {
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(
      `${FM}
# Title

<a href="/nope" />
<MyLink to="/also-nope" />
`,
      {
        path: "src/content/docs/page.mdx",
        absPath: setup.pagePath,
        collection: "docs",
      },
    );
    const diags = lintFile(parsed, {
      rules: {
        "nimbus/internal-link": [
          "error",
          { components: [{ name: "MyLink", attr: "to" }] },
        ],
      },
    }).filter((d) => d.code === "nimbus/internal-link");
    // Both fire: <a href> is always checked, MyLink:to opts in.
    assert.equal(diags.length, 2);
    assert.ok(diags.some((d) => d.message.includes("/nope")));
    assert.ok(diags.some((d) => d.message.includes("/also-nope")));
  } finally {
    cleanup(setup.root);
  }
});

test("internal-link infers the project root from the last /src/ in the path", () => {
  // Simulate a developer whose project lives at a path that *itself* contains
  // `/src/` — e.g. `/Users/me/src/projects/my-docs/src/content/docs/page.mdx`.
  // Using indexOf would point at `/Users/me`; lastIndexOf points at `my-docs`.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-il-src-outer-"));
  try {
    const root = path.join(outer, "src", "projects", "my-docs");
    fs.mkdirSync(path.join(root, ".nimbus"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".nimbus", "routes.json"),
      JSON.stringify(baseTruth()),
    );
    fs.mkdirSync(path.join(root, "src/content/docs"), { recursive: true });
    _resetInternalLinkCacheForTests();
    const parsed = parseSource(`${FM}\n# x\n\n[good](/workers)`, {
      path: "src/content/docs/page.mdx",
      absPath: path.join(root, "src/content/docs/page.mdx"),
      collection: "docs",
    });
    const diags = lintFile(parsed, {
      rules: { "nimbus/internal-link": "error" },
    }).filter((d) => d.code === "nimbus/internal-link");
    assert.deepEqual(
      diags,
      [],
      "with the correct root inferred, /workers resolves",
    );
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
