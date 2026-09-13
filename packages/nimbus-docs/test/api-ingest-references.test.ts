// The build-time I/O orchestrator over the pure `ingestRemoteManifest` fold.
// Its contract is best-effort: a missing, unparseable, or wrong-shaped manifest
// is warned and skipped so a remote reference can never wedge the build.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ingestApiReferences } from "../src/_internal/api/ingest-references.js";
import type { ApiReference } from "../src/types.js";

function collectWarnings() {
  const messages: string[] = [];
  return { logger: { warn: (m: string) => messages.push(m) }, messages };
}

const root = mkdtempSync(path.join(tmpdir(), "nimbus-refs-"));

function writeManifest(name: string, value: unknown): string {
  writeFileSync(path.join(root, name), JSON.stringify(value), "utf8");
  return name;
}

describe("ingestApiReferences", () => {
  test("folds a local manifest into the citation index, prefixing origin", async () => {
    const manifestFile = writeManifest("good.json", {
      version: 2,
      collections: {
        billing: { defaultVersion: null, pages: [{ url: "/billing/get-invoice", entries: { getInvoice: null } }] },
      },
    });
    const index = new Map<string, string>();
    const refs: ApiReference[] = [
      { collection: "billing", manifest: manifestFile, origin: "https://api.example.com" },
    ];
    const { logger, messages } = collectWarnings();

    await ingestApiReferences(refs, index, root, logger);

    assert.equal(index.get("billing:getInvoice"), "https://api.example.com/billing/get-invoice");
    assert.equal(messages.length, 0);
  });

  test("a missing LOCAL manifest fails loud (author mistake)", async () => {
    const index = new Map<string, string>();
    const { logger } = collectWarnings();

    await assert.rejects(
      () =>
        ingestApiReferences(
          [{ collection: "gone", manifest: "does-not-exist.json" }],
          index,
          root,
          logger,
        ),
      /could not read local apiReferences manifest for "gone"/,
    );
    assert.equal(index.size, 0);
  });

  test("a wrong-shaped LOCAL manifest fails loud", async () => {
    const bad = writeManifest("bad.json", { version: 99, notCollections: {} });
    const index = new Map<string, string>();
    const { logger } = collectWarnings();

    await assert.rejects(
      () => ingestApiReferences([{ collection: "weird", manifest: bad }], index, root, logger),
      /not a valid coordinates\.json/,
    );
    assert.equal(index.size, 0);
  });

  test("an unreachable REMOTE manifest is best-effort: warned and skipped", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const index = new Map<string, string>();
      const { logger, messages } = collectWarnings();
      await ingestApiReferences(
        [{ collection: "remote", manifest: "https://down.example.com/coordinates.json" }],
        index,
        root,
        logger,
      );
      assert.equal(index.size, 0);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, /could not fetch .* "remote"/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a non-ok REMOTE response is best-effort: warned and skipped", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("nope", { status: 404, statusText: "Not Found" });
    try {
      const index = new Map<string, string>();
      const { logger, messages } = collectWarnings();
      await ingestApiReferences(
        [{ collection: "remote", manifest: "https://x.example.com/coordinates.json" }],
        index,
        root,
        logger,
      );
      assert.equal(index.size, 0);
      assert.match(messages[0]!, /HTTP 404/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("undefined references is a no-op", async () => {
    const index = new Map<string, string>();
    const { logger, messages } = collectWarnings();
    await ingestApiReferences(undefined, index, root, logger);
    assert.equal(index.size, 0);
    assert.equal(messages.length, 0);
  });
});
