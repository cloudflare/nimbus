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
