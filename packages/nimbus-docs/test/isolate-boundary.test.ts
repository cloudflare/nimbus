/**
 * isolate.boundaries: descend a section-scoped tree to a module
 * sub-rail. Module/indexEntryId ctx is exercised via getSidebar
 * elsewhere; here we test the pure isolation primitive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSidebarTree,
  scopeToCurrentSection,
  isolateToBoundary,
  flattenSidebar,
} from "../src/_internal/sidebar.js";
import { lpEntries, lpConfig } from "./fixtures/nav.js";

function hrefs(items: any): string[] {
  return flattenSidebar(items).map((l) => l.href);
}

test("isolates to the current module's sub-rail", () => {
  const slug = "/learning-paths/workers/series/intro";
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const scoped = scopeToCurrentSection(tree, slug);
  const isolated = isolateToBoundary(scoped, slug, ["learning-paths/*"]);
  const hs = hrefs(isolated);
  assert.ok(hs.length > 0);
  assert.ok(hs.every((h) => h.startsWith("/learning-paths/workers/")), hs.join(", "));
  // DNS module's pages must be gone
  assert.equal(hs.some((h) => h.startsWith("/learning-paths/dns/")), false);
});

test("a non-matching path is unchanged", () => {
  const slug = "/learning-paths/workers/series/intro";
  const tree = buildSidebarTree({ docs: lpEntries } as any, "docs", slug, lpConfig as any);
  const scoped = scopeToCurrentSection(tree, slug);
  const isolated = isolateToBoundary(scoped, "/something/else/", ["learning-paths/*"]);
  assert.deepEqual(isolated, scoped);
});

test("prefix boundary does not collide with a sibling sharing a prefix", () => {
  const entries = [
    { id: "lp/workers/a", data: { title: "A", sidebar: { order: 1 } } },
    { id: "lp/workers-foo/b", data: { title: "B", sidebar: { order: 1 } } },
  ];
  const config = { items: [{ label: "LP", items: [{ autogenerate: { directory: "lp" } }] }], scope: "section" };
  const slug = "/lp/workers/a";
  const tree = buildSidebarTree({ docs: entries } as any, "docs", slug, config as any);
  const scoped = scopeToCurrentSection(tree, slug);
  const isolated = isolateToBoundary(scoped, slug, ["lp/*"]);
  const hs = hrefs(isolated);
  assert.ok(hs.every((h) => h.startsWith("/lp/workers/")), hs.join(", "));
  assert.equal(hs.some((h) => h.startsWith("/lp/workers-foo/")), false);
});

// Regression suite for `sidebar-isolate-boundary`: a descendant link pointing
// OUT of the boundary subtree must not drop its module from selection. Each
// case below (except shape 6) fails on `main` and passes after the fix.

function isolatedHrefs(
  entries: any[],
  config: any,
  slug: string,
  boundaries: string[],
): string[] {
  const tree = buildSidebarTree({ docs: entries } as any, "docs", slug, config as any);
  const scoped = scopeToCurrentSection(tree, slug);
  return hrefs(isolateToBoundary(scoped, slug, boundaries));
}

const lpWrapper = (dir: string) => ({
  items: [{ label: "LP", items: [{ autogenerate: { directory: dir } }] }],
  scope: "section",
});

test("shape 1 — relative external_link leaf keeps the current module and its sibling", () => {
  // `account/audit` links OUT of the boundary subtree (a relative
  // external_link → `_neverActive` link with an out-of-prefix href).
  const entries = [
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/account/audit", data: { title: "Audit", external_link: "/fundamentals/audit/", sidebar: { order: 2 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
    { id: "lp/appsec/traffic/ssl", data: { title: "SSL", sidebar: { order: 2 } } },
  ];
  const hs = isolatedHrefs(entries, lpWrapper("lp"), "/lp/appsec/account/twofa", ["lp/*"]);
  // Current module retained…
  assert.ok(hs.includes("/lp/appsec/account/twofa/"), hs.join(", "));
  // …and the sibling module too — not collapsed to `traffic` alone.
  assert.ok(hs.includes("/lp/appsec/traffic/ddos/"), hs.join(", "));
});

test("shape 2 — module whose own index is a relative external_link is retained", () => {
  // `account`'s directory index redirects cross-section → the group carries
  // `_indexNeverActive`, and flattenSidebar pushes an unflagged synthetic
  // landing whose href is out of prefix. The `_neverActive`-filter fix would
  // still miss this; the containment check does not.
  const entries = [
    { id: "lp/appsec/account", data: { title: "Account", external_link: "/fundamentals/account/" } },
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
    { id: "lp/appsec/traffic/ssl", data: { title: "SSL", sidebar: { order: 2 } } },
  ];
  const hs = isolatedHrefs(entries, lpWrapper("lp"), "/lp/appsec/account/twofa", ["lp/*"]);
  assert.ok(hs.includes("/lp/appsec/account/twofa/"), hs.join(", "));
  assert.ok(hs.includes("/lp/appsec/traffic/ddos/"), hs.join(", "));
});

test("shape 3 — manual cross-section { link } inside the boundary group does not collapse the rail", () => {
  // A labeled `segment` group whose `items` splice an inline `{ autogenerate }`
  // with a manual cross-section `{ link }` (no `_neverActive` flag — only
  // positive identification, not a descendant test, keeps the rail). The
  // sibling path stops section-scoping from collapsing onto the boundary group
  // itself, so selection is genuinely exercised.
  const entries = [
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
    { id: "lp/platform/build/ci", data: { title: "CI", sidebar: { order: 1 } } },
  ];
  const config = {
    items: [
      {
        label: "Learning paths",
        items: [
          {
            label: "AppSec",
            segment: "lp/appsec",
            items: [
              { autogenerate: { directory: "lp/appsec" } },
              { label: "Audit logs", link: "/fundamentals/audit/" },
            ],
          },
          {
            label: "Platform",
            segment: "lp/platform",
            items: [{ autogenerate: { directory: "lp/platform" } }],
          },
        ],
      },
    ],
    scope: "section",
  };
  const hs = isolatedHrefs(entries, config, "/lp/appsec/account/twofa", ["lp/*"]);
  assert.ok(hs.includes("/lp/appsec/account/twofa/"), hs.join(", "));
  assert.ok(hs.includes("/lp/appsec/traffic/ddos/"), hs.join(", "));
  // Isolated to the AppSec path — the sibling learning path is gone.
  assert.equal(hs.some((h) => h.startsWith("/lp/platform/")), false, hs.join(", "));
});

test("shape 3b — labeled { label, autogenerate: { directory } } section is a selectable boundary (no silent passthrough)", () => {
  // The "autogenSections" shape: the boundary group is a labeled autogenerate
  // wrapper (neither an FS-autogen group nor a `segment` group). Without a
  // stamped route key here, selection finds nothing at the glob depth and
  // isolation silently no-ops, leaking the sibling path.
  const entries = [
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/account/audit", data: { title: "Audit", external_link: "/fundamentals/audit/", sidebar: { order: 2 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
    { id: "lp/platform/build/ci", data: { title: "CI", sidebar: { order: 1 } } },
  ];
  const config = {
    items: [
      {
        label: "Learning paths",
        items: [
          { label: "AppSec", autogenerate: { directory: "lp/appsec" } },
          { label: "Platform", autogenerate: { directory: "lp/platform" } },
        ],
      },
    ],
    scope: "section",
  };
  const hs = isolatedHrefs(entries, config, "/lp/appsec/account/twofa", ["lp/*"]);
  assert.ok(hs.includes("/lp/appsec/account/twofa/"), hs.join(", "));
  assert.ok(hs.includes("/lp/appsec/traffic/ddos/"), hs.join(", "));
  // Isolated to AppSec — the sibling path must not leak (main: leaks / this
  // fix without labeled-autogenerate stamping: leaks via passthrough).
  assert.equal(hs.some((h) => h.startsWith("/lp/platform/")), false, hs.join(", "));
});

test("shape 3c — nested mounted-collection section is a selectable boundary via its mount prefix", () => {
  // Locks the collection-mount `_routeKey` (`toBrowserHref(prefix)`). A
  // collection mounted at `/components`, nested under a wrapper so scoping
  // doesn't unwrap it, holds a cross-section `external_link` at its root. The
  // single-segment boundary `components` must select the collection group by
  // its mount, not collapse to the first clean module.
  const config = {
    items: [
      {
        label: "Docs area",
        items: [{ label: "Components", autogenerate: { collection: "comp", prefix: "/components" } }],
      },
    ],
    scope: "section",
  };
  const tree = buildSidebarTree(
    {
      docs: [{ id: "intro", data: { title: "Intro", sidebar: { order: 1 } } }],
      comp: [
        { id: "buttons/primary", data: { title: "Primary", sidebar: { order: 1 } } },
        { id: "buttons/ghost", data: { title: "Ghost", sidebar: { order: 2 } } },
        { id: "forms/input", data: { title: "Input", sidebar: { order: 1 } } },
        { id: "ext", data: { title: "Ext", external_link: "/other/x/", sidebar: { order: 3 } } },
      ],
    } as any,
    "docs",
    "/components/buttons/primary",
    config as any,
  );
  const scoped = scopeToCurrentSection(tree, "/components/buttons/primary");
  const hs = hrefs(isolateToBoundary(scoped, "/components/buttons/primary", ["components"]));
  assert.ok(hs.includes("/components/buttons/primary/"), hs.join(", "));
  // Sibling module present → not collapsed to `buttons` alone.
  assert.ok(hs.includes("/components/forms/input/"), hs.join(", "));
});

test("shape 4 — a clean nested subfolder inside the broken module does not become the rail", () => {
  // `account` holds both a clean `keys/` subfolder AND the bad audit link.
  // On `main`, DFS returns the fully-in-prefix `keys` subgroup as the whole
  // rail; the fix must return the learning path's modules instead.
  const entries = [
    { id: "lp/appsec/account/keys/k1", data: { title: "K1", sidebar: { order: 1 } } },
    { id: "lp/appsec/account/keys/k2", data: { title: "K2", sidebar: { order: 2 } } },
    { id: "lp/appsec/account/audit", data: { title: "Audit", external_link: "/fundamentals/audit/", sidebar: { order: 3 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
  ];
  const hs = isolatedHrefs(entries, lpWrapper("lp"), "/lp/appsec/account/keys/k1", ["lp/*"]);
  assert.ok(hs.includes("/lp/appsec/account/keys/k1/"), hs.join(", "));
  // The sibling module proves we did NOT collapse to the `keys` subgroup.
  assert.ok(hs.includes("/lp/appsec/traffic/ddos/"), hs.join(", "));
});

test("shape 5 — multi-segment glob with a bad link selects the module, not silent passthrough", () => {
  // `lp/appsec/*` points the prefix AT the module depth. The bad link lives in
  // the depth-implied module (`account`), so on `main` no group qualifies and
  // isolation no-ops (the rail stays unisolated — `traffic` still present).
  const entries = [
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/account/audit", data: { title: "Audit", external_link: "/fundamentals/audit/", sidebar: { order: 2 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
    { id: "lp/appsec/traffic/ssl", data: { title: "SSL", sidebar: { order: 2 } } },
  ];
  const hs = isolatedHrefs(entries, lpWrapper("lp"), "/lp/appsec/account/twofa", ["lp/appsec/*"]);
  assert.ok(hs.includes("/lp/appsec/account/twofa/"), hs.join(", "));
  // Isolated to `account` — `traffic` must be gone (on `main` it leaks through).
  assert.equal(hs.some((h) => h.startsWith("/lp/appsec/traffic/")), false, hs.join(", "));
});

test("shape 6 — absolute external_link (type external) is a no-op regression guard", () => {
  // Absolute externals become `type: "external"`, already excluded by
  // flattenSidebar, so they never triggered the bug. Confirm isolation is
  // unaffected (passes on `main` too).
  const entries = [
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/account/ext", data: { title: "Ext", external_link: "https://example.com/x", sidebar: { order: 2 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
  ];
  const hs = isolatedHrefs(entries, lpWrapper("lp"), "/lp/appsec/account/twofa", ["lp/*"]);
  assert.ok(hs.includes("/lp/appsec/account/twofa/"), hs.join(", "));
  assert.ok(hs.includes("/lp/appsec/traffic/ddos/"), hs.join(", "));
});

test("every non-redirect page of the learning path isolates to a rail containing its own module", () => {
  const entries = [
    { id: "lp/appsec/account/twofa", data: { title: "2FA", sidebar: { order: 1 } } },
    { id: "lp/appsec/account/audit", data: { title: "Audit", external_link: "/fundamentals/audit/", sidebar: { order: 2 } } },
    { id: "lp/appsec/traffic/ddos", data: { title: "DDoS", sidebar: { order: 1 } } },
    { id: "lp/appsec/traffic/ssl", data: { title: "SSL", sidebar: { order: 2 } } },
  ];
  // Every internal (non-redirect) page; the `_neverActive` audit redirect leaf
  // is out of scope (it has no rail of its own).
  for (const page of ["/lp/appsec/account/twofa", "/lp/appsec/traffic/ddos", "/lp/appsec/traffic/ssl"]) {
    const hs = isolatedHrefs(entries, lpWrapper("lp"), page, ["lp/*"]);
    assert.ok(hs.includes(page + "/"), `${page} missing from its own isolated rail: ${hs.join(", ")}`);
  }
});
