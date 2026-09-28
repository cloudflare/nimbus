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
import { STARTER_ROUTE_INVENTORY } from "../../nimbus-docs/src/_internal/route-ownership.js";

function routeEntrypoints(root: string): string[] {
  const pages = path.join(root, "src/pages");
  const routes: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (
        !entry.name.startsWith("_") &&
        /\.(?:astro|mdx?|[cm]?[jt]sx?)$/.test(entry.name)
      ) {
        routes.push(path.relative(path.join(root, "src"), absolute).replaceAll("\\", "/"));
      }
    }
  };
  walk(pages);
  return routes.sort();
}

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
      const gitignore = fs.readFileSync(path.join(dir, "gitignore"), "utf8");
      assert.match(gitignore, /^\.nimbus\/$/m);
      const nimbusVersion = JSON.parse(
        fs.readFileSync(new URL("../../nimbus-docs/package.json", import.meta.url), "utf8"),
      ).version;
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, "nimbus.json"), "utf8")),
        {
          $schema: "https://nimbus-docs.com/schema/nimbus.json",
          lastReviewedNimbusVersion: nimbusVersion,
        },
        `${path.basename(dir)} must carry the reviewed baseline of its pinned framework`,
      );

      assert.deepEqual(
        routeEntrypoints(dir),
        STARTER_ROUTE_INVENTORY.map((route) => route.entrypoint).sort(),
        `${path.basename(dir)} has an unclassified or missing route entrypoint`,
      );
      assert.deepEqual(
        STARTER_ROUTE_INVENTORY.filter(
          (route) => route.role === "canonical",
        ).map(({ pattern, entrypoint }) => ({ pattern, entrypoint })),
        [{ pattern: "/[...slug]", entrypoint: "pages/[...slug].astro" }],
      );
      assert.deepEqual(
        STARTER_ROUTE_INVENTORY.filter(
          (route) => route.role === "user-owned",
        ).map(({ pattern, entrypoint }) => ({ pattern, entrypoint })),
        STARTER_ROUTE_INVENTORY.filter(
          (route) => route.role !== "canonical",
        ).map(({ pattern, entrypoint }) => ({ pattern, entrypoint })),
      );
      assert.deepEqual(
        STARTER_ROUTE_INVENTORY.filter((route) => route.allowsContentShadow).map(
          ({ pattern, entrypoint }) => ({ pattern, entrypoint }),
        ),
        [{ pattern: "/", entrypoint: "pages/index.astro" }],
      );
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
