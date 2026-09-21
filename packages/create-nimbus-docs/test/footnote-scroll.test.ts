import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { generateTemplates } from "../scripts/copy-template.mjs";

test("every generated variant keeps footnote jumps below the sticky header", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-gen-"));
  try {
    const dirs = generateTemplates(out);
    for (const dir of dirs) {
      const prose = fs.readFileSync(
        path.join(dir, "src/styles/prose.css"),
        "utf8",
      );
      assert.match(
        prose,
        /\.docs-content\s+:where\(\[data-footnote-ref\]\[id\],\s*\[data-footnotes\]\s+li\[id\]\)\s*\{[^}]*scroll-margin-top:\s*8rem;/s,
        `${path.basename(dir)} does not offset both footnote jump targets`,
      );
      assert.match(
        prose,
        /@media\s*\(min-width:\s*80rem\)\s*\{\s*\.docs-content\s+:where\(\[data-footnote-ref\]\[id\],\s*\[data-footnotes\]\s+li\[id\]\)\s*\{[^}]*scroll-margin-top:\s*5rem;/s,
        `${path.basename(dir)} does not restore the desktop offset`,
      );
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
