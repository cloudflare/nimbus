// The coordinate-citation resolver — the pure core. Citations become URLs and
// their grammar is frozen the moment the first guide ships, so this suite pins
// the token grammar (sentinel, @version, first-colon split), the two failure
// modes (author = build-error, derived = "#"), path-only value validation, and
// code protection. If this goes red, a frozen citation contract moved.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CITATION_SENTINEL,
  citationKey,
  parseCitation,
  resolveCitation,
  resolveCitations,
  isSafeCitationPath,
  hasCitation,
  type CitationIndex,
} from "../src/_internal/api/citations.ts";
import { setTrailingSlash } from "../src/_internal/url.ts";

const index: CitationIndex = new Map([
  ["zones:createZone", "/zones/create"],
  ["zones@v2:createZone", "/zones/create"],
  ["zones@v1:createZone", "/zones/v1/create"],
  ["accounts:list", "/accounts/list"],
  // a spaced-tag section coordinate stays opaque (`tags.<label>`) but routes to
  // a slugified URL — a real space-bearing citation key, reachable only via the
  // angle-bracket destination form.
  ["zones:tags.User Management", "/zones/tags/User-Management"],
]);

describe("parseCitation: the token grammar", () => {
  test("a non-sentinel target is not a citation", () => {
    assert.equal(parseCitation("/zones/create"), null);
    assert.equal(parseCitation("https://example.com"), null);
    assert.equal(parseCitation("mailto:x@y.z"), null);
  });

  test("bare collection:coordinate", () => {
    assert.deepEqual(parseCitation("api.ref:zones:createZone"), {
      collection: "zones",
      coordinate: "createZone",
    });
  });

  test("versioned collection@version:coordinate", () => {
    assert.deepEqual(parseCitation("api.ref:zones@v2:createZone"), {
      collection: "zones",
      version: "v2",
      coordinate: "createZone",
    });
  });

  test("the coordinate is never re-split — dots and later colons survive", () => {
    assert.deepEqual(parseCitation("api.ref:zones:createZone.amount"), {
      collection: "zones",
      coordinate: "createZone.amount",
    });
    // a colon inside the coordinate belongs to the coordinate (first-colon split)
    assert.deepEqual(parseCitation("api.ref:zones:a.b:c"), {
      collection: "zones",
      coordinate: "a.b:c",
    });
  });

  test("malformed tokens are faults, not passthroughs", () => {
    assert.ok("fault" in (parseCitation("api.ref:zonesCreateZone") as object)); // no colon
    assert.ok("fault" in (parseCitation("api.ref:zones:") as object)); // empty coordinate
    assert.ok("fault" in (parseCitation("api.ref:Zones:x") as object)); // uppercase collection
    assert.ok("fault" in (parseCitation("api.ref:zones@v2@v3:x") as object)); // two @
    assert.ok("fault" in (parseCitation("api.ref:zones@v_2:x") as object)); // bad version char
    assert.ok("fault" in (parseCitation("api.ref:zones@v2.:x") as object)); // trailing dot
  });

  test("realistic versions parse", () => {
    for (const v of ["v1", "v2", "2024-01-01", "1.0.0", "v2-beta"]) {
      assert.deepEqual(parseCitation(`api.ref:zones@${v}:createZone`), {
        collection: "zones",
        version: v,
        coordinate: "createZone",
      });
    }
  });
});

describe("citationKey + resolveCitation", () => {
  test("unversioned key resolves the family default", () => {
    assert.equal(resolveCitation({ collection: "zones", coordinate: "createZone" }, index), "/zones/create/");
  });
  test("versioned key resolves that version", () => {
    assert.equal(
      resolveCitation({ collection: "zones", version: "v1", coordinate: "createZone" }, index),
      "/zones/v1/create/",
    );
  });
  test("unknown resolves to undefined", () => {
    assert.equal(resolveCitation({ collection: "zones", coordinate: "nope" }, index), undefined);
  });
  test("resolved URLs follow Astro's trailingSlash like other page links", (t) => {
    t.after(() => setTrailingSlash("ignore"));
    setTrailingSlash("never");
    assert.equal(resolveCitation({ collection: "zones", coordinate: "createZone" }, index), "/zones/create");
    assert.equal(
      resolveCitations("[a](api.ref:zones:createZone)", { mode: "author", citationIndex: index }).code,
      "[a](/zones/create)",
    );
    setTrailingSlash("always");
    assert.equal(resolveCitation({ collection: "zones", coordinate: "createZone" }, index), "/zones/create/");
  });
  test("key shape", () => {
    assert.equal(citationKey("zones", undefined, "createZone"), "zones:createZone");
    assert.equal(citationKey("zones", "v1", "createZone"), "zones@v1:createZone");
  });
});

describe("isSafeCitationPath: value validation on ingest", () => {
  test("accepts single-slash site-absolute paths", () => {
    assert.ok(isSafeCitationPath("/zones/create"));
    assert.ok(isSafeCitationPath("/"));
  });
  test("rejects schemes, protocol-relative, non-absolute, and unsafe chars", () => {
    assert.equal(isSafeCitationPath("javascript:alert(1)"), false);
    assert.equal(isSafeCitationPath("data:text/html,x"), false);
    assert.equal(isSafeCitationPath("//evil.example.com"), false);
    assert.equal(isSafeCitationPath("https://evil.example.com/x"), false);
    assert.equal(isSafeCitationPath("zones/create"), false);
    assert.equal(isSafeCitationPath("/has space"), false);
    assert.equal(isSafeCitationPath("/has\\backslash"), false);
  });
});

describe("resolveCitations: rewriting link targets", () => {
  test("rewrites a markdown link to its resolved URL", () => {
    const { code, diagnostics } = resolveCitations(
      "See [create a zone](api.ref:zones:createZone) to start.",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "See [create a zone](/zones/create/) to start.");
    assert.equal(diagnostics.length, 0);
  });

  test("rewrites a JSX href", () => {
    const { code } = resolveCitations(
      `<a href="api.ref:accounts:list">list</a>`,
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, `<a href="/accounts/list/">list</a>`);
  });

  test("rewrites a versioned citation", () => {
    const { code } = resolveCitations(
      "[old](api.ref:zones@v1:createZone)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[old](/zones/v1/create/)");
  });

  test("author mode: unknown coordinate is a build error, no token leaks", () => {
    const { code, diagnostics } = resolveCitations(
      "[gone](api.ref:zones:deleteZone)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[gone](#)");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.level, "error");
  });

  test("author mode: an unknown collection is soft (warn + #), never wedges", () => {
    // a declared-but-unreachable remote, or a typo'd collection name: we are
    // not authoritative, so it must not fail the build.
    const { code, diagnostics } = resolveCitations(
      "[x](api.ref:widgets:makeWidget)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[x](#)");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.level, "warning");
    assert.match(diagnostics[0]?.message ?? "", /unknown collection "widgets"/);
  });

  test("derived mode: unknown coordinate warns and renders #", () => {
    const { code, diagnostics } = resolveCitations(
      "[x](api.ref:zones:deleteZone)",
      { mode: "derived", citationIndex: index },
    );
    assert.equal(code, "[x](#)");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.level, "warning");
  });

  test("a near-miss gets a Levenshtein hint", () => {
    const { diagnostics } = resolveCitations(
      "[x](api.ref:zones:createZon)",
      { mode: "author", citationIndex: index },
    );
    assert.match(diagnostics[0]?.message ?? "", /Did you mean "api\.ref:zones:createZone"/);
  });

  test("a malformed token is always an error, both modes", () => {
    for (const mode of ["author", "derived"] as const) {
      const { code, diagnostics } = resolveCitations("[x](api.ref:zones:)", { mode, citationIndex: index });
      assert.equal(code, "[x](#)");
      assert.equal(diagnostics[0]?.level, "error");
    }
  });

  test("citations inside code are never rewritten or reported", () => {
    const src = "Write `api.ref:zones:createZone` in a link.\n\n```md\n[x](api.ref:zones:deleteZone)\n```\n";
    const { code, diagnostics } = resolveCitations(src, { mode: "author", citationIndex: index });
    assert.equal(code, src);
    assert.equal(diagnostics.length, 0);
  });

  test("multiple citations in one source all resolve", () => {
    const { code } = resolveCitations(
      "[a](api.ref:zones:createZone) and [b](api.ref:accounts:list)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[a](/zones/create/) and [b](/accounts/list/)");
  });

  test("angle-bracket destination cites a space-bearing coordinate; brackets are dropped", () => {
    const { code, diagnostics } = resolveCitations(
      "[section](<api.ref:zones:tags.User Management>)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[section](/zones/tags/User-Management/)");
    assert.equal(diagnostics.length, 0);
  });

  test("angle-bracket destination also works for an ordinary coordinate", () => {
    const { code } = resolveCitations(
      "[c](<api.ref:zones:createZone>)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[c](/zones/create/)");
  });

  test("interior padding inside the angle brackets is tolerated and trimmed", () => {
    for (const src of [
      "[a](< api.ref:zones:tags.User Management>)",
      "[b](<api.ref:zones:tags.User Management >)",
      "[c](<  api.ref:zones:tags.User Management  >)",
    ]) {
      const { code, diagnostics } = resolveCitations(src, { mode: "author", citationIndex: index });
      assert.match(code, /\]\(\/zones\/tags\/User-Management\/\)/);
      assert.equal(diagnostics.length, 0);
    }
  });

  test("a JSX href with a space-bearing coordinate resolves (quote-delimited, not whitespace-truncated)", () => {
    const { code, diagnostics } = resolveCitations(
      `<a href="api.ref:zones:tags.User Management">section</a>`,
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, `<a href="/zones/tags/User-Management/">section</a>`);
    assert.equal(diagnostics.length, 0);
  });

  test("an unresolved space-bearing coordinate still fails in author mode", () => {
    const { code, diagnostics } = resolveCitations(
      "[x](<api.ref:zones:GET /widgets>)",
      { mode: "author", citationIndex: index },
    );
    assert.equal(code, "[x](#)");
    assert.equal(diagnostics[0]?.level, "error");
  });
});

describe("hasCitation: the fail-loud pre-filter", () => {
  test("true when a citation link is present outside code", () => {
    assert.ok(hasCitation("[x](api.ref:zones:createZone)"));
  });
  test("true for an angle-bracket destination", () => {
    assert.ok(hasCitation("[x](<api.ref:zones:GET /zones>)"));
  });
  test("true for an angle destination with interior padding (no silent leak)", () => {
    assert.ok(hasCitation("[x](< api.ref:zones:GET /zones >)"));
  });
  test("false when the only occurrence is inside code", () => {
    assert.equal(hasCitation("`api.ref:zones:createZone`"), false);
  });
  test("false when the sentinel is mentioned in prose, not linked", () => {
    assert.equal(hasCitation("Cite an op with the api.ref: link scheme."), false);
  });
  test("false for ordinary prose", () => {
    assert.equal(hasCitation("no citations here"), false);
  });
  test("the sentinel export is stable", () => {
    assert.equal(CITATION_SENTINEL, "api.ref:");
  });
});
