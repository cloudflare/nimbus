/**
 * Tests for `nimbus/image-ref`.
 *
 * The rule's truth is the filesystem — each test stages a tmpdir project
 * root (inferred from the parsed file's absolute path, `<root>/src/...`),
 * writes image files under `public/` / `src/assets/` / next to the page,
 * and asserts the diagnostics.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lintFile } from "../../src/lint/engine.js";
import { parseSource } from "../../src/lint/parse.js";

interface Setup {
  root: string;
  pagePath: string;
}

function setupProject(files: string[] = []): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-ir-"));
  fs.mkdirSync(path.join(root, "src/content/docs"), { recursive: true });
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
  }
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

function lint(setup: Setup, mdx: string, options?: Record<string, unknown>) {
  const parsed = parseSource(mdx, {
    path: "src/content/docs/page.mdx",
    absPath: setup.pagePath,
    collection: "docs",
  });
  return lintFile(parsed, {
    rules: {
      "nimbus/image-ref": options ? ["error", options] : "error",
    },
  }).filter((d) => d.code === "nimbus/image-ref");
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

test("image-ref is silent on resolvable refs", () => {
  const setup = setupProject([
    "public/images/d1/concept.png",
    "src/content/docs/local.png",
  ]);
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

![Concept](/images/d1/concept.png)
![Local](./local.png)
<img src="/images/d1/concept.png" alt="again" />
`,
    );
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref skips external, data, and dynamic refs", () => {
  const setup = setupProject();
  try {
    const diags = lint(
      setup,
      `${FM}
# Title

![Remote](https://example.com/x.png)
![Proto-relative](//example.com/x.png)
![Data](data:image/png;base64,AAAA)
<img src={imageUrl} alt="dynamic" />
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

test("image-ref flags a missing site-absolute image", () => {
  const setup = setupProject();
  try {
    const diags = lint(setup, `${FM}\n![Gone](/images/d1/gone.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /missing image "\/images\/d1\/gone\.png"/);
    assert.match(diags[0]!.message, /public\/images\/d1\/gone\.png/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref flags a missing relative image", () => {
  const setup = setupProject();
  try {
    const diags = lint(setup, `${FM}\n![Gone](./shot.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /missing image "\.\/shot\.png"/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref flags missing <img src> and reference-style images", () => {
  const setup = setupProject();
  try {
    const diags = lint(
      setup,
      `${FM}
<img src="/missing.png" alt="x" />

![Ref][shot]

[shot]: /also-missing.png
`,
    );
    assert.equal(diags.length, 2);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref suggests a sibling near-match", () => {
  const setup = setupProject(["public/images/concept.png"]);
  try {
    const diags = lint(setup, `${FM}\n![X](/images/concpt.png)\n`);
    assert.equal(diags.length, 1);
    assert.match(diags[0]!.message, /did you mean "concept\.png"/);
  } finally {
    cleanup(setup.root);
  }
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("image-ref resolves configured alias prefixes", () => {
  const setup = setupProject(["src/assets/logo.svg"]);
  try {
    const options = { aliases: { "~/assets/": "src/assets/" } };
    const clean = lint(setup, `${FM}\n![Logo](~/assets/logo.svg)\n`, options);
    assert.deepEqual(clean, []);

    const broken = lint(setup, `${FM}\n![Logo](~/assets/nope.svg)\n`, options);
    assert.equal(broken.length, 1);
    assert.match(broken[0]!.message, /src\/assets\/nope\.svg/);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref honors ignore globs", () => {
  const setup = setupProject();
  try {
    const diags = lint(setup, `${FM}\n![Gen](/images/generated/chart.png)\n`, {
      ignore: ["/images/generated/**"],
    });
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref ignore supports a leading any-depth wildcard and brace expansion", () => {
  const setup = setupProject();
  try {
    const clean = lint(
      setup,
      `${FM}
![thumb](/products/workers/thumbnail.webp)
![thumb2](/products/r2/thumbnail2.webp)
`,
      { ignore: ["**/thumbnail.webp", "**/thumbnail2.webp"] },
    );
    assert.deepEqual(clean, []);

    const broken = lint(setup, `${FM}\n![missing](/other/missing.png)\n`, {
      ignore: ["**/thumbnail.webp", "**/thumbnail2.webp"],
    });
    assert.equal(broken.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref ignore tolerates a stray empty-string pattern (no rule-wide crash)", () => {
  const setup = setupProject();
  try {
    const broken = lint(setup, `${FM}\n![missing](/other/missing.png)\n`, {
      ignore: ["**/thumbnail.webp", ""],
    });
    assert.equal(broken.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref checks opt-in components", () => {
  const setup = setupProject(["public/frames/ok.png"]);
  try {
    const options = { components: [{ name: "Frame", attr: "src" }] };
    const clean = lint(
      setup,
      `${FM}\n<Frame src="/frames/ok.png" />\n`,
      options,
    );
    assert.deepEqual(clean, []);

    const broken = lint(
      setup,
      `${FM}\n<Frame src="/frames/missing.png" />\n`,
      options,
    );
    assert.equal(broken.length, 1);
  } finally {
    cleanup(setup.root);
  }
});

test("image-ref ignores unrecognised url shapes", () => {
  const setup = setupProject();
  try {
    // `~/assets/` without a configured alias is unrecognised — silent.
    const diags = lint(setup, `${FM}\n![X](~/assets/logo.svg)\n`);
    assert.deepEqual(diags, []);
  } finally {
    cleanup(setup.root);
  }
});
