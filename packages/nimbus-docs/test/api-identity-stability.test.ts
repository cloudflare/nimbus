// Coordinate + URL identity is stable across builds. Coordinates and the
// hrefs derived from them are the one thing that cannot be refactored later:
// they are permalinks, deep-link anchors, and the citation target guides bind
// to. This suite pins that identity three ways:
//
//   1. Frozen snapshot — the smallco fixture's full (coordinate → slug, href)
//      set, captured verbatim. A silent rename of any coordinate or URL trips
//      this. Regenerate ONLY with an intentional identity change (and record a
//      changeset when you do).
//   2. Determinism — parsing the same bytes twice yields byte-identical identity.
//   3. Namespace isolation — a collection's identity is independent of whether a
//      second collection is also built (collection-as-namespace).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildApiModel,
  clearApiModelCache,
  getApiPageSlugs,
  getApiPageProps,
  type ApiModel,
} from "../src/api/index.js";

function fixtureText(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url)), "utf8");
}

interface IdentityRow {
  coordinate: string;
  slug: string;
  href: string;
}

/** Coordinate → (slug, href) for every page, sorted by coordinate. The stable
 *  identity projection this suite guards. */
function identity(model: ApiModel): IdentityRow[] {
  return getApiPageSlugs(model)
    .map(({ coordinate, slug }) => ({
      coordinate,
      slug,
      href: getApiPageProps(model, coordinate).href,
    }))
    .sort((a, b) => a.coordinate.localeCompare(b.coordinate));
}

// The frozen contract. Captured from the pinned smallco fixture under the `api`
// collection. Do not edit to make a test pass — a diff here means a permalink moved.
const SMALLCO_IDENTITY: IdentityRow[] = [
  { coordinate: "AliasUnion", slug: "schemas/AliasUnion", href: "/api/schemas/AliasUnion" },
  { coordinate: "AllOfCurrency", slug: "schemas/AllOfCurrency", href: "/api/schemas/AllOfCurrency" },
  { coordinate: "api", slug: "", href: "/api" },
  { coordinate: "BankAccount", slug: "schemas/BankAccount", href: "/api/schemas/BankAccount" },
  { coordinate: "Card", slug: "schemas/Card", href: "/api/schemas/Card" },
  { coordinate: "Charge", slug: "schemas/Charge", href: "/api/schemas/Charge" },
  { coordinate: "ColorList", slug: "schemas/ColorList", href: "/api/schemas/ColorList" },
  { coordinate: "create", slug: "charges/create", href: "/api/charges/create" },
  { coordinate: "Currency", slug: "schemas/Currency", href: "/api/schemas/Currency" },
  { coordinate: "Dispute", slug: "schemas/Dispute", href: "/api/schemas/Dispute" },
  { coordinate: "DisputeDuplicate", slug: "schemas/DisputeDuplicate", href: "/api/schemas/DisputeDuplicate" },
  { coordinate: "DisputeFraud", slug: "schemas/DisputeFraud", href: "/api/schemas/DisputeFraud" },
  { coordinate: "DisputeNotReceived", slug: "schemas/DisputeNotReceived", href: "/api/schemas/DisputeNotReceived" },
  { coordinate: "EitherAccount", slug: "schemas/EitherAccount", href: "/api/schemas/EitherAccount" },
  { coordinate: "Error", slug: "schemas/Error", href: "/api/schemas/Error" },
  { coordinate: "list", slug: "charges/list", href: "/api/charges/list" },
  { coordinate: "Mixed", slug: "schemas/Mixed", href: "/api/schemas/Mixed" },
  { coordinate: "openDispute", slug: "disputes/openDispute", href: "/api/disputes/openDispute" },
  { coordinate: "payment.succeeded", slug: "webhooks/payment.succeeded", href: "/api/webhooks/payment.succeeded" },
  { coordinate: "search", slug: "search/search", href: "/api/search/search" },
  { coordinate: "TaggedCharge", slug: "schemas/TaggedCharge", href: "/api/schemas/TaggedCharge" },
  { coordinate: "tags.charges", slug: "tags/charges", href: "/api/tags/charges" },
  { coordinate: "tags.disputes", slug: "tags/disputes", href: "/api/tags/disputes" },
  { coordinate: "tags.search", slug: "tags/search", href: "/api/tags/search" },
  { coordinate: "upload", slug: "charges/upload", href: "/api/charges/upload" },
];

let smallco: ApiModel;
before(async () => {
  smallco = await buildApiModel({ collection: "api", spec: fixtureText("smallco.yaml") });
});

describe("api identity stability", () => {
  test("smallco identity matches the frozen snapshot", () => {
    assert.deepEqual(identity(smallco), SMALLCO_IDENTITY);
  });

  test("identity is deterministic across independent builds of the same bytes", async () => {
    // buildApiModel is content-addressed, so a same-(collection,bytes) call is a
    // cache hit that never reparses — evict first to force a genuine second parse,
    // else this compares the frozen handle to itself and can't fail.
    clearApiModelCache("api");
    const rebuilt = await buildApiModel({ collection: "api", spec: fixtureText("smallco.yaml") });
    assert.deepEqual(identity(rebuilt), identity(smallco));
  });

  test("a collection's identity is independent of other collections in the build", async () => {
    // Capture the first collection's identity, then parse an unrelated second
    // collection, then evict and re-parse the first from scratch. If any
    // coordinate/URL state were shared across collections, the neighbour's parse
    // would perturb the first's fresh reparse. It must not — adding/removing a
    // neighbour never moves a permalink (collection-as-namespace).
    const before = identity(await buildApiModel({ collection: "solo", spec: fixtureText("smallco.yaml") }));
    await buildApiModel({ collection: "neighbour", spec: fixtureText("deviant.yaml") });
    clearApiModelCache("solo");
    const after = identity(await buildApiModel({ collection: "solo", spec: fixtureText("smallco.yaml") }));
    assert.deepEqual(after, before);
  });
});
