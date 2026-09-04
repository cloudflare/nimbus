/**
 * Guards the generator's *output* — the real templates users receive — rather
 * than a hand-built fixture. `scaffold.test.ts` proves the scaffold transforms
 * never strip the `// nimbus:adapter` marker, but it feeds them a fixture whose
 * marker is hard-coded; nothing there would notice if the canonical
 * `nimbus-starter-source/astro.config.ts` lost the marker. That line is the
 * anchor `nimbus-docs add adapter-*` rewrites to opt into server output, so its
 * loss silently breaks the adapter flow for every scaffolded project.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { generateTemplates, variantNames } from "../scripts/copy-template.mjs";

test("every generated variant ships the adapter marker and implicit build default", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-gen-"));
  try {
    const dirs = generateTemplates(out);
    assert.equal(dirs.length, variantNames().length);
    for (const dir of dirs) {
      const cfg = fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8");
      assert.equal(
        cfg.includes("// nimbus:adapter"),
        true,
        `${path.basename(dir)} lost the adapter marker`,
      );
      assert.doesNotMatch(cfg, /nimbus:rendering/);
      assert.doesNotMatch(cfg, /rendering:\s*\{\s*default:\s*["']request["']/);
      assert.doesNotMatch(cfg, /rendering:\s*\{/);
      assert.match(
        fs.readFileSync(path.join(dir, "gitignore"), "utf8"),
        /^\.nimbus\/$/m,
      );
      const agent = fs.readFileSync(path.join(dir, "AGENT.md"), "utf8");
      assert.match(agent, /@cloudflare\/nimbus-docs\/components\/Icon\.astro/);
      assert.doesNotMatch(agent, /astro-icon\/components/);
      assert.match(agent, /`nimbus-docs` CLI/);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
