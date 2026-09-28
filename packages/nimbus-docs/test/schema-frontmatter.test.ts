import assert from "node:assert/strict";
import { test } from "node:test";

import { docsSchema } from "../src/schemas.js";

test("the docs schema accepts Nimbus lint-disable frontmatter", () => {
  const result = docsSchema.safeParse({
    title: "Test",
    nimbusDisableRules: ["nimbus/single-h1"],
  });
  assert.equal(result.success, true);
});

test("the docs schema accepts Astro's slug override", () => {
  const result = docsSchema.safeParse({ title: "Test", slug: "1.2.3/encryption" });
  assert.equal(result.success, true);
  assert.equal(result.data?.slug, "1.2.3/encryption");
  assert.equal(docsSchema.safeParse({ title: "Test", slug: 1 }).success, false);
});
