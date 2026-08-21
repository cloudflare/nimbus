// Opt-in resilience gauntlet against the real-spec corpus (23 MB Cloudflare,
// Stripe, GitHub, OpenAI). Heavy — skipped by default so `pnpm test` stays fast
// and low-memory. Run with:
//   NIMBUS_API_GAUNTLET=1 node --max-old-space-size=6144 --import tsx --test test/api-production-gauntlet.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildApiModel,
  getApiNav,
  getApiPageProps,
  getApiPageSlugs,
  renderApiPageMarkdown,
} from "../src/api/index.js";

const enabled = process.env.NIMBUS_API_GAUNTLET === "1";

function fixture(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/api/production/${rel}`, import.meta.url));
}

function roundTrips(value: unknown): void {
  assert.deepEqual(
    JSON.parse(JSON.stringify(structuredClone(value))),
    JSON.parse(JSON.stringify(value)),
  );
}

const SPECS = [
  { collection: "cloudflare", file: "cloudflare.json" },
  { collection: "stripe", file: "stripe.json" },
  { collection: "github", file: "github.json" },
  { collection: "openai", file: "openai.yaml" },
];

describe("api production gauntlet", { skip: enabled ? false : "set NIMBUS_API_GAUNTLET=1" }, () => {
  for (const { collection, file } of SPECS) {
    test(`${collection}: nav builds + sampled pages serialize`, async () => {
      const path = fixture(file);
      assert.ok(existsSync(path), `missing fixture ${file}`);

      const model = await buildApiModel({
        collection,
        spec: readFileSync(path, "utf8"),
        label: file,
      });

      const nav = getApiNav(model);
      assert.equal(nav.apiSchemaVersion, 1);
      roundTrips(nav);

      const slugs = getApiPageSlugs(model);
      assert.ok(slugs.length > 0);

      const sample = slugs.filter((_, i) => i < 40 || i % 500 === 0);
      for (const { coordinate } of sample) {
        const props = getApiPageProps(model, coordinate);
        assert.equal(props.apiSchemaVersion, 1);
        roundTrips(props);
        const md = renderApiPageMarkdown(props);
        assert.ok(md.trim().length > 0, `empty markdown for ${coordinate}`);
        assert.doesNotMatch(md, /^# /m, `H1 leaked in ${coordinate}`);
        assert.doesNotMatch(md, /^=+\s*$/m, `setext H1 leaked in ${coordinate}`);
        assert.doesNotMatch(md, /^-+\s*$/m, `setext/thematic leaked in ${coordinate}`);
      }
    });
  }
});
