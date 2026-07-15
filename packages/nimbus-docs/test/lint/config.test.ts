import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMPLEMENTED_CODES,
  resolveRule,
  resolveRuleForCollection,
  validateLintOptions,
} from "../../src/lint/index.js";

test("validateLintOptions accepts a valid rules object", () => {
  const { rules } = validateLintOptions({
    rules: {
      "nimbus/single-h1": "warn",
      "nimbus/code-block-lang": ["error", { allow: ["mermaid"] }],
    },
  });
  assert.equal(rules["nimbus/single-h1"], "warn");
});

test("validateLintOptions accepts a collections block with per-collection rules", () => {
  const { collections } = validateLintOptions({
    collections: {
      partials: {
        rules: {
          "nimbus/single-h1": "off",
          "nimbus/heading-hierarchy": "off",
        },
      },
    },
  });
  assert.equal(collections.partials?.rules?.["nimbus/single-h1"], "off");
});

test("validateLintOptions rejects a non-object collections value", () => {
  assert.throws(
    () => validateLintOptions({ collections: "wat" as unknown as never }),
    /collections.*must be an object/,
  );
});

test("validateLintOptions rejects a non-object collection entry", () => {
  assert.throws(
    () =>
      validateLintOptions({
        collections: { partials: "off" as unknown as never },
      }),
    /collections\.partials.*must be an object/,
  );
});

test("validateLintOptions rejects a build validator inside a collection's rules", () => {
  assert.throws(
    () =>
      validateLintOptions({
        collections: {
          partials: {
            rules: { "nimbus/duplicate-slug": "off" } as Record<string, unknown>,
          },
        },
      }),
    /build validator.*collections\.partials\.rules/,
  );
});

test("validateLintOptions rejects an unknown rule code inside a collection's rules", () => {
  assert.throws(
    () =>
      validateLintOptions({
        collections: {
          partials: {
            rules: { "nimbus/single-h2": "off" } as Record<string, unknown>,
          },
        },
      }),
    /unknown rule code.*collections\.partials\.rules/,
  );
});

test("validateLintOptions rejects a severity on a build validator", () => {
  assert.throws(
    () =>
      validateLintOptions({
        rules: { "nimbus/partial-exists": "warn" } as never,
      }),
    /build validator/,
  );
});

test("validateLintOptions rejects an unknown rule code", () => {
  assert.throws(
    () => validateLintOptions({ rules: { "nimbus/not-a-rule": "error" } as never }),
    /unknown rule code/i,
  );
});

test("validateLintOptions rejects an invalid severity", () => {
  assert.throws(
    () =>
      validateLintOptions({
        rules: { "nimbus/single-h1": "loud" } as never,
      }),
    /invalid severity/i,
  );
});

test("resolveRule defaults unconfigured authoring rules to off — opt-in posture", () => {
  // Nimbus ships rules off by default; the scaffolded starter opts into the
  // ones it cares about in its astro.config.ts. A bare framework install
  // with `rules: {}` runs zero authoring rules.
  const resolved = resolveRule("nimbus/single-h1", {});
  assert.equal(resolved.severity, "off");
  assert.deepEqual(resolved.options, {});
});

test("resolveRule reads the tuple form", () => {
  const resolved = resolveRule("nimbus/code-block-lang", {
    "nimbus/code-block-lang": ["warn", { allow: ["d2"] }],
  });
  assert.equal(resolved.severity, "warn");
  assert.deepEqual(resolved.options, { allow: ["d2"] });
});

test("resolveRule honors off", () => {
  assert.equal(
    resolveRule("nimbus/single-h1", { "nimbus/single-h1": "off" }).severity,
    "off",
  );
});

test("resolveRuleForCollection falls back to top-level when collection has no entry for the code", () => {
  const resolved = resolveRuleForCollection(
    "nimbus/single-h1",
    { "nimbus/single-h1": "warn" },
    { partials: { rules: { "nimbus/heading-hierarchy": "off" } } },
    "partials",
  );
  assert.equal(resolved.severity, "warn");
});

test("resolveRuleForCollection prefers per-collection severity over top-level", () => {
  const resolved = resolveRuleForCollection(
    "nimbus/single-h1",
    { "nimbus/single-h1": "error" },
    { partials: { rules: { "nimbus/single-h1": "off" } } },
    "partials",
  );
  assert.equal(resolved.severity, "off");
});

test("resolveRuleForCollection per-collection options fully replace top-level options (no deep merge)", () => {
  // Shallow merge per rule code is the documented contract — collection-
  // level setting wins for the whole rule, options bag included. A
  // partial deep-merge would silently drop defaults the user can't see.
  const resolved = resolveRuleForCollection(
    "nimbus/code-block-lang",
    { "nimbus/code-block-lang": ["error", { allow: ["mermaid"] }] },
    {
      partials: {
        rules: { "nimbus/code-block-lang": ["warn", { allow: ["d2"] }] },
      },
    },
    "partials",
  );
  assert.equal(resolved.severity, "warn");
  assert.deepEqual(resolved.options, { allow: ["d2"] });
});

test("resolveRuleForCollection ignores per-collection block for a different collection", () => {
  const resolved = resolveRuleForCollection(
    "nimbus/single-h1",
    { "nimbus/single-h1": "error" },
    { partials: { rules: { "nimbus/single-h1": "off" } } },
    "docs",
  );
  assert.equal(resolved.severity, "error");
});

test("resolveRuleForCollection with null collection acts like resolveRule", () => {
  const resolved = resolveRuleForCollection(
    "nimbus/single-h1",
    { "nimbus/single-h1": "warn" },
    { partials: { rules: { "nimbus/single-h1": "off" } } },
    null,
  );
  assert.equal(resolved.severity, "warn");
});

test("validateLintOptions rejects configuring an unimplemented rule (when implementedCodes is supplied)", () => {
  // `nimbus/orphan-page` is registered in RULE_CODES but no rule module
  // ships it yet. Configuring it would silently do nothing — the
  // integration passes IMPLEMENTED_CODES so this surfaces as a typed error.
  assert.throws(
    () =>
      validateLintOptions(
        { rules: { "nimbus/orphan-page": "error" } },
        IMPLEMENTED_CODES,
      ),
    /registered but not yet implemented/,
  );
});

test("validateLintOptions accepts `off` for an unimplemented rule (forward-config)", () => {
  // A project that wants to forward-configure a planned rule can opt out
  // ahead of time without tripping the implementation check.
  const { rules } = validateLintOptions(
    { rules: { "nimbus/orphan-page": "off" } },
    IMPLEMENTED_CODES,
  );
  assert.equal(rules["nimbus/orphan-page"], "off");
});

test("validateLintOptions skips the implementation check when implementedCodes is omitted", () => {
  // Standalone CLI uses the materialized config which has already been
  // validated; calling without the set should accept any registered code.
  assert.doesNotThrow(() =>
    validateLintOptions({ rules: { "nimbus/orphan-page": "error" } }),
  );
});
