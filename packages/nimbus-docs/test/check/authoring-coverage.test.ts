import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkAuthoring } from "../../src/check/authoring.js";
import { _resetInternalLinkCacheForTests } from "../../src/lint/rules/internal-link.js";
import { computeRouteSourceFingerprint } from "../../src/_internal/route-manifest.js";

interface ProjectOpts {
  body?: string;
  lintJson?: Record<string, unknown>;
  routesJson?: Record<string, unknown>;
}

function project(opts: ProjectOpts = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-authoring-"));
  const docs = path.join(dir, "src", "content", "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(
    path.join(docs, "page.mdx"),
    `---\ntitle: Page\n---\n\n${opts.body ?? "See [x](/nope-broken)."}\n`,
  );
  if (opts.lintJson || opts.routesJson) {
    fs.mkdirSync(path.join(dir, ".nimbus"), { recursive: true });
  }
  if (opts.lintJson) {
    fs.writeFileSync(
      path.join(dir, ".nimbus", "lint.json"),
      JSON.stringify({ version: 1, ...opts.lintJson }),
    );
  }
  if (opts.routesJson) {
    fs.writeFileSync(
      path.join(dir, ".nimbus", "routes.json"),
      JSON.stringify({
        version: 2,
        sourceFingerprint: {
          version: 1,
          algorithm: "sha256",
          digest: computeRouteSourceFingerprint(dir),
        },
        ...opts.routesJson,
      }),
    );
  }
  return dir;
}

const INTERNAL_LINK_ON = {
  rules: { "nimbus/internal-link": "error" },
  collections: {},
  site: "https://docs.example.com",
};

const INTERNAL_LINK_ON_COLLECTION = {
  rules: {},
  collections: { docs: { rules: { "nimbus/internal-link": "error" } } },
  site: "https://docs.example.com",
};

const hasFinding = (r: { findings: { code: string }[] }, code: string) =>
  r.findings.some((f) => f.code === code);
const note = (r: { notes: { code: string }[] }, code: string) =>
  r.notes.find((n) => n.code === code);

test("no .nimbus → authoring-optin-skipped note, evaluated true, never in findings (renamed code)", () => {
  _resetInternalLinkCacheForTests();
  const dir = project();
  try {
    const r = checkAuthoring(dir);
    assert.equal(r.scope, "authoring");
    assert.equal(r.evaluated, true, "core rules ran — the scope is evaluated");
    const skip = note(r, "nimbus/authoring-optin-skipped");
    assert.ok(skip, "opt-in skip is surfaced as a note");
    assert.equal(skip.requiresBuild, true);
    assert.ok(
      !hasFinding(r, "nimbus/authoring-optin-skipped"),
      "never a finding",
    );
    assert.ok(
      !hasFinding(r, "nimbus/authoring-not-evaluated"),
      "old code is gone",
    );
    assert.ok(!hasFinding(r, "nimbus/internal-link"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint.json enables internal-link but no routes.json → internal-link-skipped note (not a false pass)", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({ lintJson: INTERNAL_LINK_ON });
  try {
    const r = checkAuthoring(dir);
    const skipped = note(r, "nimbus/internal-link-skipped");
    assert.ok(skipped, "link checking skip is a note");
    assert.equal(skipped.requiresBuild, true);
    assert.ok(!hasFinding(r, "nimbus/internal-link-skipped"));
    assert.ok(!hasFinding(r, "nimbus/internal-link"));
    assert.ok(
      !note(r, "nimbus/authoring-optin-skipped"),
      "opt-in ran, so no opt-in note",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lint.json + routes.json present → broken link is actually caught", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({
    lintJson: INTERNAL_LINK_ON,
    routesJson: { base: "/", knownRoutes: ["/"], opaqueNamespaces: [] },
  });
  try {
    const r = checkAuthoring(dir);
    const broken = r.findings.find((f) => f.code === "nimbus/internal-link");
    assert.ok(
      broken,
      "the broken link must be flagged when route truth exists",
    );
    assert.equal(broken.severity, "error");
    assert.ok(!note(r, "nimbus/internal-link-skipped"));
    assert.ok(!note(r, "nimbus/authoring-optin-skipped"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale route truth produces one structured coverage note and no broken-link findings", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({
    lintJson: INTERNAL_LINK_ON,
    routesJson: { base: "/", knownRoutes: ["/"], opaqueNamespaces: [] },
  });
  try {
    fs.appendFileSync(
      path.join(dir, "src/content/docs/page.mdx"),
      "\nroute change\n",
    );
    const r = checkAuthoring(dir);
    const skipped = r.notes.filter(
      (item) => item.code === "nimbus/internal-link-skipped",
    );
    assert.equal(skipped.length, 1);
    assert.match(
      skipped[0]!.reason,
      /does not match the current route-producing sources/,
    );
    assert.ok(!hasFinding(r, "nimbus/internal-link"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy and malformed route truth each produce one coverage note", () => {
  for (const body of [JSON.stringify({ version: 1 }), "{"]) {
    _resetInternalLinkCacheForTests();
    const dir = project({ lintJson: INTERNAL_LINK_ON });
    try {
      fs.mkdirSync(path.join(dir, ".nimbus"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".nimbus/routes.json"), body);
      const r = checkAuthoring(dir);
      assert.equal(
        r.notes.filter((item) => item.code === "nimbus/internal-link-skipped")
          .length,
        1,
      );
      assert.ok(!hasFinding(r, "nimbus/internal-link"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("internal-link disabled + no routes.json → no skip note (nothing to skip)", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({
    lintJson: { rules: {}, collections: {}, site: "https://docs.example.com" },
  });
  try {
    const r = checkAuthoring(dir);
    assert.ok(!note(r, "nimbus/internal-link-skipped"));
    assert.ok(!note(r, "nimbus/authoring-optin-skipped"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("always-on validators still fire without a lint.json (mdx-syntax not skipped)", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({ body: "Broken expression {" });
  try {
    const r = checkAuthoring(dir);
    assert.ok(
      r.findings.some(
        (f) => f.code === "nimbus/mdx-syntax" && f.severity === "error",
      ),
      "mdx-syntax must fire even when no lint config is materialized",
    );
    assert.ok(
      note(r, "nimbus/authoring-optin-skipped"),
      "opt-in skip still noted",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("internal-link skip is noted structurally, never leaked to stderr", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({ lintJson: INTERNAL_LINK_ON });
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const r = checkAuthoring(dir);
    assert.ok(
      note(r, "nimbus/internal-link-skipped"),
      "the skip is a structured note",
    );
    assert.doesNotMatch(captured, /nimbus\/internal-link: skipped/);
  } finally {
    process.stderr.write = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("internal-link enabled via a collection override + no routes.json → noted and disabled", () => {
  _resetInternalLinkCacheForTests();
  const dir = project({ lintJson: INTERNAL_LINK_ON_COLLECTION });
  try {
    const r = checkAuthoring(dir);
    assert.ok(note(r, "nimbus/internal-link-skipped"));
    assert.ok(!hasFinding(r, "nimbus/internal-link"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("zero .mdx project → evaluated true, no notes (a config-only check still passes)", () => {
  _resetInternalLinkCacheForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-authoring-empty-"));
  try {
    const r = checkAuthoring(dir);
    assert.equal(r.evaluated, true);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
