// Guards zero-argument `apiCollection()`: it reads its entry from the
// root-keyed registry the integration fills, and two projects in one process
// never see each other's entries.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { apiCollection } from "../src/content.js";
import {
  apiCollectionIndexError,
  clearApiCollectionRegistry,
  misplacedApiCollectionMessage,
  missingApiCollectionMessage,
  nonApiCollectionMessage,
  registerApiCollections,
} from "../src/_internal/api-collection-registry.js";

function inlineSpec(title: string, summary: string) {
  return {
    openapi: "3.1.0",
    info: { title, version: "1.0.0" },
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          summary,
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function makeProject(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "nimbus-api-registry-")));
}

function makeContext(root: string, collection: string) {
  const map = new Map<string, { id: string; data: Record<string, unknown> }>();
  const store = {
    set: (entry: { id: string; data: Record<string, unknown> }) =>
      void map.set(entry.id, entry),
    get: (id: string) => map.get(id),
    keys: () => [...map.keys()],
    values: () => [...map.values()],
    has: (id: string) => map.has(id),
    delete: (id: string) => void map.delete(id),
    clear: () => map.clear(),
    addModuleImport() {},
  };
  const noop = () => {};
  return {
    map,
    context: {
      collection,
      store: store as never,
      meta: { get: () => undefined, set() {}, has: () => false, delete() {} },
      logger: {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        label: "t",
        fork: () => undefined,
      } as never,
      config: { root: pathToFileURL(`${root}/`), output: "static" } as never,
      parseData: async <T>({ data }: { data: T }) => data,
      renderMarkdown: async () => ({ html: "" }),
      generateDigest: (v: unknown) => JSON.stringify(v).length.toString(36),
      watcher: undefined,
    } as import("astro/loaders").LoaderContext,
  };
}

const projects: string[] = [];
afterEach(() => {
  clearApiCollectionRegistry();
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("apiCollection() without arguments", () => {
  test("two projects in one process index only their own entries", async () => {
    const first = makeProject();
    const second = makeProject();
    projects.push(first, second);
    writeFileSync(
      path.join(first, "spec.json"),
      JSON.stringify(inlineSpec("First API", "Ping first")),
    );
    registerApiCollections(first, [{ collection: "api", spec: "./spec.json" }]);
    registerApiCollections(second, [
      { collection: "api", spec: inlineSpec("Second API", "Ping second") },
      { collection: "extra", spec: inlineSpec("Extra API", "Ping extra") },
    ]);

    const { loader } = apiCollection();
    const a = makeContext(first, "api");
    const b = makeContext(second, "api");
    const c = makeContext(second, "extra");
    await Promise.all([
      loader.load(a.context),
      loader.load(b.context),
      loader.load(c.context),
    ]);

    assert.equal(a.map.get("ping")?.data.title, "Ping first");
    assert.equal(b.map.get("ping")?.data.title, "Ping second");
    assert.equal(c.map.get("ping")?.data.title, "Ping extra");
    assert.equal(a.map.get("index")?.data.title, "First API");
    assert.equal(b.map.get("index")?.data.title, "Second API");

    // The first project has no "extra" entry, even though the second does.
    await assert.rejects(
      loader.load(makeContext(first, "extra").context),
      /src\/content\.config\.ts registers "extra" with apiCollection\(\), but the Nimbus config \(astro\.config\.\*\) has no `api` entry for it\. Configured api collections: "api"\./,
    );
  });

  test("a later registration for the same root replaces the entries", async () => {
    const root = makeProject();
    projects.push(root);
    registerApiCollections(root, [
      { collection: "api", spec: inlineSpec("Before", "Before edit") },
    ]);
    registerApiCollections(root, [
      { collection: "api", spec: inlineSpec("After", "After edit") },
    ]);
    const run = makeContext(root, "api");
    await apiCollection().loader.load(run.context);
    assert.equal(run.map.get("ping")?.data.title, "After edit");
  });

  test("fails clearly when the integration never configured the project", async () => {
    const root = makeProject();
    projects.push(root);
    await assert.rejects(
      apiCollection().loader.load(makeContext(root, "api").context),
      /Nimbus integration has not run for this project/,
    );
  });

  test("explicit options ignore the registry", async () => {
    const root = makeProject();
    projects.push(root);
    registerApiCollections(root, [
      { collection: "api", spec: inlineSpec("Registry", "From registry") },
    ]);
    const run = makeContext(root, "api");
    await apiCollection({
      collection: "api",
      spec: inlineSpec("Explicit", "From options"),
    }).loader.load(run.context);
    assert.equal(run.map.get("ping")?.data.title, "From options");
  });

  test("an api entry counts as indexed only after apiCollection() ran under its key", async () => {
    const root = makeProject();
    projects.push(root);
    registerApiCollections(root, [
      { collection: "api", spec: inlineSpec("Api", "Ping") },
      { collection: "partner-api", spec: inlineSpec("Partner", "Ping") },
      { collection: "billing", spec: inlineSpec("Billing", "Ping") },
    ]);

    // No collection with the key at all.
    assert.equal(
      apiCollectionIndexError(root, "partner-api", false),
      missingApiCollectionMessage("partner-api"),
    );
    assert.match(
      missingApiCollectionMessage("partner-api"),
      /the Nimbus config \(astro\.config\.\*\) declares the API collection "partner-api".*Add "partner-api": defineCollection\(apiCollection\(\)\) to the collections in src\/content\.config\.ts\./,
    );
    assert.match(missingApiCollectionMessage("api"), /Add api: defineCollection/);

    // A prepared collection under the key, from another loader (docsCollection()).
    assert.equal(
      apiCollectionIndexError(root, "billing", true),
      nonApiCollectionMessage("billing"),
    );
    assert.match(
      nonApiCollectionMessage("billing"),
      /the Nimbus config \(astro\.config\.\*\) declares the API collection "billing".*src\/content\.config\.ts registers billing with a loader other than apiCollection\(\)/,
    );

    // An explicit entry registered under a different key doesn't index "billing".
    await apiCollection({
      collection: "billing",
      spec: inlineSpec("Billing", "Ping"),
    }).loader.load(makeContext(root, "payments").context);
    assert.equal(
      apiCollectionIndexError(root, "billing", true),
      misplacedApiCollectionMessage("billing", "payments"),
    );
    assert.match(
      misplacedApiCollectionMessage("billing", "payments"),
      /declares the API collection "billing".*src\/content\.config\.ts registers it under the key payments\. Register it as billing: defineCollection\(apiCollection\(\)\)\./,
    );

    // The loader ran under the key and prepared it: indexed.
    await apiCollection().loader.load(makeContext(root, "api").context);
    assert.equal(apiCollectionIndexError(root, "api", true), null);
    // Ran but prepared nothing: the load failed.
    assert.match(
      apiCollectionIndexError(root, "api", false) ?? "",
      /"api" failed to index during content sync/,
    );
    // A new registration (a dev restart) forgets earlier loads.
    registerApiCollections(root, [{ collection: "api", spec: inlineSpec("Api", "Ping") }]);
    assert.equal(
      apiCollectionIndexError(root, "api", false),
      missingApiCollectionMessage("api"),
    );
  });
});
