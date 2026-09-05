import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { glob, type LoaderContext } from "astro/loaders";

import {
  NIMBUS_MARKDOWN_META_KEY,
  prepareMarkdownLoader,
} from "../src/_internal/markdown-loader.ts";
import { registerAuthoredLinkNormalizer } from "../src/_internal/authored-link-normalizer.ts";
import { normalizeAuthoredLinks } from "../src/_internal/authored-links.ts";
import {
  beginPreparedMarkdownSession,
  clearPreparedMarkdownRegistry,
  getPreparedMarkdownSnapshot,
} from "../src/_internal/prepared-markdown-registry.ts";
import {
  componentsCollection,
  docsCollection,
  partialsCollection,
  withNimbusMarkdown,
} from "../src/content.ts";

interface StoredEntry {
  id: string;
  data: Record<string, unknown>;
  body?: string;
  filePath?: string;
  digest?: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function createHarness(root: string) {
  const entries = new Map<string, StoredEntry>();
  const metadata = new Map<string, string>();
  const handlers = new Map<string, Array<(file: string) => unknown>>();
  let clearCount = 0;
  let parseCount = 0;
  const store = {
    get: (id: string) => entries.get(id),
    entries: () => entries.entries(),
    values: () => entries.values(),
    keys: () => entries.keys(),
    set: (entry: StoredEntry) => {
      if (entry.digest && entries.get(entry.id)?.digest === entry.digest)
        return false;
      entries.set(entry.id, entry);
      return true;
    },
    delete: (id: string) => entries.delete(id),
    clear: () => {
      clearCount += 1;
      entries.clear();
    },
    has: (id: string) => entries.has(id),
    addAssetImport: () => undefined,
    addAssetImports: () => undefined,
    addModuleImport: () => undefined,
  };
  const watcher = {
    add: () => undefined,
    on(event: string, handler: (file: string) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return this;
    },
  };
  const rootUrl = pathToFileURL(`${root}${path.sep}`);
  const context = {
    collection: "docs",
    store,
    meta: {
      get: (key: string) => metadata.get(key),
      set: (key: string, value: string) => metadata.set(key, value),
      has: (key: string) => metadata.has(key),
      delete: (key: string) => metadata.delete(key),
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      fork() {
        return this;
      },
    },
    config: { root: rootUrl, srcDir: new URL("src/", rootUrl), base: "/docs" },
    async parseData({ data }: { data: Record<string, unknown> }) {
      parseCount += 1;
      return { ...data, parsed: true };
    },
    async renderMarkdown(source: string) {
      return { html: source, metadata: { headings: [], imagePaths: [] } };
    },
    generateDigest(source: string | Record<string, unknown>) {
      return JSON.stringify(source);
    },
    watcher,
    entryTypes: new Map([
      [
        ".md",
        {
          async getEntryInfo({ contents }: { contents: string }) {
            return { body: contents, data: { title: contents.trim() } };
          },
          contentModuleTypes: [],
        },
      ],
    ]),
  } as unknown as LoaderContext;

  return {
    context,
    entries,
    metadata,
    get clearCount() {
      return clearCount;
    },
    get parseCount() {
      return parseCount;
    },
    async emit(event: string, file: string) {
      await Promise.all(
        (handlers.get(event) ?? []).map((handler) => handler(file)),
      );
    },
  };
}

describe("Markdown loader preparation", () => {
  test("public wrapper and built-in collections prepare retained bodies", async () => {
    registerAuthoredLinkNormalizer(normalizeAuthoredLinks);
    const harness = createHarness(process.cwd());
    const wrapped = withNimbusMarkdown({
      name: "custom",
      async load(context) {
        context.store.set({ id: "guide", body: "[Guide](/guide)", data: {} });
      },
    });

    await wrapped.load(harness.context);
    assert.equal(harness.entries.get("guide")?.body, "[Guide](/docs/guide)");
    assert.equal(withNimbusMarkdown(wrapped), wrapped);
    assert.equal(withNimbusMarkdown(wrapped), withNimbusMarkdown(wrapped));
    for (const collection of [
      docsCollection(),
      partialsCollection(),
      componentsCollection(),
    ]) {
      assert.equal(collection.loader.name, "glob-loader");
    }

    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-built-in-loader-"),
    );
    temporaryRoots.push(root);
    const docs = path.join(root, "src/content/docs");
    await mkdir(docs, { recursive: true });
    await writeFile(
      path.join(docs, "built-in.md"),
      "[Built in](/guide)",
      "utf8",
    );
    const builtInHarness = createHarness(root);
    await docsCollection().loader.load(builtInHarness.context);
    assert.equal(
      builtInHarness.entries.get("built-in")?.body,
      "[Built in](/docs/guide)",
    );
  });

  test("preserves a custom loader's prototype, descriptors, and receivers", async () => {
    const schema = {} as never;
    class CustomLoader {
      #name = "custom";
      schema = schema;

      get name() {
        return this.#name;
      }

      async load() {
        assert.equal(this.#name, "custom");
      }
    }
    const loader = Object.freeze(new CustomLoader());
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    });
    const harness = createHarness(process.cwd());

    assert.equal(wrapped.name, "custom");
    assert.equal(wrapped.schema, schema);
    assert.equal(Object.getPrototypeOf(wrapped), CustomLoader.prototype);
    assert.equal(
      Object.getOwnPropertyDescriptor(wrapped, "schema")?.writable,
      Object.getOwnPropertyDescriptor(loader, "schema")?.writable,
    );
    assert.equal(Object.isFrozen(wrapped), true);
    assert.equal(wrapped.constructor, CustomLoader);
    await wrapped.load(harness.context);
  });

  test("prepares a real glob loader through cold load and watcher lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-loader-"));
    temporaryRoots.push(root);
    const docs = path.join(root, "src/content/docs");
    await mkdir(docs, { recursive: true });
    const first = path.join(docs, "first.md");
    await writeFile(first, "one", "utf8");

    const loader = glob({ base: "./src/content/docs", pattern: "**/*.md" });
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => `/docs:${source}`,
    });
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    assert.equal(harness.entries.get("first")?.body, "/docs:one");
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("first")?.body,
      "/docs:one",
    );
    assert.equal(harness.entries.get("first")?.data.parsed, true);
    assert.equal(harness.parseCount, 1);
    assert.ok(harness.metadata.has(NIMBUS_MARKDOWN_META_KEY));
    const metadata = JSON.parse(
      harness.metadata.get(NIMBUS_MARKDOWN_META_KEY)!,
    );
    assert.equal(metadata.version, 2);
    assert.equal(metadata.generation, 1);
    assert.equal(metadata.base, "/docs");
    assert.match(metadata.digest, /^sha256:[a-f0-9]{64}$/u);

    await writeFile(first, "two", "utf8");
    await harness.emit("change", first);
    assert.equal(harness.entries.get("first")?.body, "/docs:two");

    const second = path.join(docs, "second.md");
    await writeFile(second, "three", "utf8");
    await harness.emit("add", second);
    assert.equal(harness.entries.get("second")?.body, "/docs:three");
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("second")?.body,
      "/docs:three",
    );

    await unlink(first);
    await harness.emit("unlink", first);
    assert.equal(harness.entries.has("first"), false);
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.has("first"),
      false,
    );

    const renamed = path.join(docs, "renamed.md");
    await rename(second, renamed);
    await harness.emit("unlink", second);
    await harness.emit("add", renamed);
    assert.equal(harness.entries.has("second"), false);
    assert.equal(harness.entries.get("renamed")?.body, "/docs:three");

    const serialized = JSON.stringify([...harness.entries]);
    assert.deepEqual(JSON.parse(serialized), [...harness.entries]);

    const parseCount = harness.parseCount;
    await wrapped.load(harness.context);
    assert.equal(harness.clearCount, 1);
    assert.equal(harness.parseCount, parseCount);

    harness.entries.get("renamed")!.body = "tampered";
    await wrapped.load(harness.context);
    assert.equal(harness.clearCount, 2);
    assert.equal(harness.entries.get("renamed")?.body, "/docs:three");

    const rebased = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/new",
      transform: (source) => `/new:${source}`,
    });
    await rebased.load(harness.context);
    assert.equal(harness.clearCount, 3);
    assert.equal(harness.entries.get("renamed")?.body, "/new:three");

    const regenerated = prepareMarkdownLoader(loader, {
      generation: 2,
      base: "/new",
      transform: (source) => `/new:${source}`,
    });
    await regenerated.load(harness.context);
    assert.equal(harness.clearCount, 4);
    assert.equal(await readFile(renamed, "utf8"), "three");
  });

  test("seals prepared collections without decorating entry data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-loader-strip-"));
    temporaryRoots.push(root);
    const loader = {
      name: "strip-loader",
      load(context: LoaderContext) {
        context.store.set({ id: "entry", body: "body", data: {} });
      },
    };
    const harness = createHarness(root);
    await prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    }).load(harness.context);

    assert.deepEqual(harness.entries.get("entry")?.data, {});
    const prepared = getPreparedMarkdownSnapshot(root)?.collections.get("docs");
    assert.deepEqual(prepared?.entries.get("entry")?.data, {});
    assert.match(prepared?.capability.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
  });

  test("commits authoritative digest no-ops and isolated registry snapshots", async () => {
    let body = "one";
    const loader = {
      name: "digest-loader",
      async load(context: LoaderContext) {
        context.store.set({
          id: "entry",
          body,
          data: { nested: { value: body } },
          digest: "fixed",
        });
        context.watcher?.on("change", () => undefined);
      },
    };
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    });
    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-digest-"),
    );
    temporaryRoots.push(root);
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    const revision = getPreparedMarkdownSnapshot(root)?.revision;
    body = "two";
    await wrapped.load(harness.context);
    const snapshot = getPreparedMarkdownSnapshot(root);
    assert.equal(snapshot?.revision, revision);
    await harness.emit("change", "ignored.md");
    assert.equal(getPreparedMarkdownSnapshot(root)?.revision, revision);
    const entry = snapshot?.collections.get("docs")?.entries.get("entry");
    assert.equal(entry?.body, "one");
    (entry?.data.nested as { value: string }).value = "mutated";
    assert.deepEqual(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("entry")?.data.nested,
      { value: "one" },
    );
  });

  test("publishes watcher changes atomically and ignores obsolete handlers", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    let watcherCalls = 0;
    let stagedKeysAreArrays = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const loader = {
      name: "watch-loader",
      async load(context: LoaderContext) {
        if (!context.store.has("old")) {
          context.store.set({ id: "old", body: "old", data: {} });
        }
        context.watcher?.on("change", async () => {
          watcherCalls += 1;
          stagedKeysAreArrays = Array.isArray(context.store.keys());
          context.store.delete("old");
          entered?.();
          await gate;
          context.store.set({ id: "new", body: "new", data: {} });
        });
      },
    };
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    });
    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-watch-"),
    );
    temporaryRoots.push(root);
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    await wrapped.load(harness.context);
    const update = harness.emit("change", "ignored.md");
    await started;
    assert.deepEqual([...harness.entries.keys()], ["old"]);
    assert.deepEqual(
      [
        ...(getPreparedMarkdownSnapshot(root)
          ?.collections.get("docs")
          ?.entries.keys() ?? []),
      ],
      ["old"],
    );
    release?.();
    await update;
    assert.equal(watcherCalls, 1);
    assert.equal(stagedKeysAreArrays, true);
    assert.deepEqual(
      [
        ...(getPreparedMarkdownSnapshot(root)
          ?.collections.get("docs")
          ?.entries.keys() ?? []),
      ],
      ["new"],
    );
  });

  test("invalidates a reusable snapshot when replacement loading fails", async () => {
    let fail = false;
    const wrapped = prepareMarkdownLoader(
      {
        name: "reusable-failure-loader",
        load(context: LoaderContext) {
          context.store.set({ id: "entry", body: "body", data: {} });
          if (fail) throw new Error("replacement failed");
        },
      },
      {
        generation: 1,
        base: "/docs",
        transform: (source) => source,
      },
    );
    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-reusable-failure-"),
    );
    temporaryRoots.push(root);
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    assert.ok(getPreparedMarkdownSnapshot(root)?.collections.has("docs"));
    fail = true;
    await assert.rejects(wrapped.load(harness.context), /replacement failed/);
    assert.equal(harness.entries.size, 0);
    assert.equal(harness.metadata.has(NIMBUS_MARKDOWN_META_KEY), false);
    assert.equal(
      getPreparedMarkdownSnapshot(root)?.collections.has("docs"),
      false,
    );
  });

  test("retains the last valid snapshot after a watcher failure", async () => {
    let calls = 0;
    let fail = true;
    const wrapped = prepareMarkdownLoader(
      {
        name: "failing-watch-loader",
        async load(context: LoaderContext) {
          context.store.set({ id: "stable", body: "stable", data: {} });
          context.store.set({ id: "sibling", body: "sibling", data: {} });
          context.watcher?.on("change", () => {
            calls += 1;
            if (fail) {
              fail = false;
              context.store.delete("stable");
              context.store.delete("sibling");
              context.logger.error("watch failed");
              return;
            }
            context.store.delete("stable");
            context.store.set({ id: "stable", body: "fixed", data: {} });
          });
        },
      },
      { generation: 1, base: "/docs", transform: (source) => source },
    );
    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-failure-"),
    );
    temporaryRoots.push(root);
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    await harness.emit("change", "ignored.md");
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("stable")?.body,
      "stable",
    );
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("sibling")?.body,
      "sibling",
    );
    await harness.emit("change", "ignored.md");
    assert.equal(calls, 2);
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("stable")?.body,
      "fixed",
    );
    assert.equal(
      getPreparedMarkdownSnapshot(root)
        ?.collections.get("docs")
        ?.entries.get("sibling")?.body,
      "sibling",
    );
  });

  test("serializes overlapping watcher callbacks", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wrapped = prepareMarkdownLoader(
      {
        name: "overlap-loader",
        async load(context: LoaderContext) {
          context.store.set({ id: "a", body: "a", data: {} });
          context.store.set({ id: "b", body: "b", data: {} });
          context.watcher?.on("change", async (file) => {
            const id = path.basename(file, ".md");
            context.store.delete(id);
            if (id === "a") {
              entered?.();
              await gate;
            }
            context.store.set({ id, body: `${id}-new`, data: {} });
          });
        },
      },
      { generation: 1, base: "/docs", transform: (source) => source },
    );
    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-overlap-"),
    );
    temporaryRoots.push(root);
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    const first = harness.emit("change", "a.md");
    await started;
    const second = harness.emit("change", "b.md");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      [
        ...(getPreparedMarkdownSnapshot(root)
          ?.collections.get("docs")
          ?.entries.keys() ?? []),
      ],
      ["a", "b"],
    );
    release?.();
    await Promise.all([first, second]);
    assert.deepEqual(
      [
        ...(getPreparedMarkdownSnapshot(root)
          ?.collections.get("docs")
          ?.entries.values() ?? []),
      ]
        .map((entry) => entry.body)
        .sort(),
      ["a-new", "b-new"],
    );
  });

  test("queues a new session behind an in-flight obsolete callback", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    let loadCount = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wrapped = prepareMarkdownLoader(
      {
        name: "session-loader",
        async load(context: LoaderContext) {
          loadCount += 1;
          context.store.clear();
          context.store.set({
            id: "current",
            body: `session-${loadCount}`,
            data: {},
          });
          context.watcher?.on("change", async () => {
            context.store.delete("current");
            entered?.();
            await gate;
            context.store.set({ id: "stale", body: "stale", data: {} });
          });
        },
      },
      { generation: 1, base: "/docs", transform: (source) => source },
    );
    const root = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-session-"),
    );
    temporaryRoots.push(root);
    const harness = createHarness(root);

    await wrapped.load(harness.context);
    const staleUpdate = harness.emit("change", "ignored.md");
    await started;
    beginPreparedMarkdownSession(root);
    release?.();
    await staleUpdate;
    assert.deepEqual(
      [...harness.entries.values()].map((entry) => [entry.id, entry.body]),
      [["current", "session-1"]],
    );
    const nextLoad = wrapped.load(harness.context);
    await nextLoad;
    const entries =
      getPreparedMarkdownSnapshot(root)?.collections.get("docs")?.entries;
    assert.deepEqual(
      [...(entries?.values() ?? [])].map((entry) => [entry.id, entry.body]),
      [["current", "session-2"]],
    );
  });

  test("resets root sessions and resolves symlink aliases across module instances", async () => {
    const parent = await mkdtemp(
      path.join(os.tmpdir(), "nimbus-registry-root-"),
    );
    temporaryRoots.push(parent);
    const root = path.join(parent, "real");
    const alias = path.join(parent, "alias");
    await mkdir(root);
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const wrapped = prepareMarkdownLoader(
      {
        name: "root-loader",
        async load(context: LoaderContext) {
          context.store.set({ id: "entry", body: "body", data: {} });
        },
      },
      { generation: 1, base: "/docs", transform: (source) => source },
    );

    await wrapped.load(createHarness(root).context);
    assert.equal(
      getPreparedMarkdownSnapshot(alias)
        ?.collections.get("docs")
        ?.entries.get("entry")?.body,
      "body",
    );
    const duplicate = (await import(
      `${new URL("../src/_internal/prepared-markdown-registry.ts", import.meta.url).href}?copy=1`
    )) as typeof import("../src/_internal/prepared-markdown-registry.ts");
    assert.equal(
      duplicate
        .getPreparedMarkdownSnapshot(alias)
        ?.collections.get("docs")
        ?.entries.has("entry"),
      true,
    );
    beginPreparedMarkdownSession(alias);
    assert.equal(getPreparedMarkdownSnapshot(root)?.collections.size, 0);
  });

  test("prepares renderMarkdown without reserving user data fields", async () => {
    const calls: string[] = [];
    const loader = {
      name: "custom",
      async load(context: LoaderContext) {
        calls.push((await context.renderMarkdown("source")).html);
        context.store.set({ id: "prepared", body: "source", data: {} });
        context.store.set({
          id: "collision",
          body: "source",
          data: { __nimbusMarkdown: "user-owned" },
        });
      },
    };
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => `prepared:${source}`,
    });
    const harness = createHarness(process.cwd());

    await wrapped.load(harness.context);
    assert.deepEqual(calls, ["prepared:source"]);
    assert.equal(
      harness.entries.get("collision")?.data.__nimbusMarkdown,
      "user-owned",
    );
    assert.equal(
      getPreparedMarkdownSnapshot(process.cwd())
        ?.collections.get("docs")
        ?.entries.get("collision")?.data.__nimbusMarkdown,
      "user-owned",
    );
    assert.equal(harness.metadata.has(NIMBUS_MARKDOWN_META_KEY), true);
  });

  test("supports a non-configurable own load method", async () => {
    let called = false;
    const loader = {
      name: "frozen",
      load: async () => {
        called = true;
      },
    };
    Object.defineProperty(loader, "load", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: loader.load,
    });
    Object.preventExtensions(loader);
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    });

    await wrapped.load(createHarness(process.cwd()).context);
    assert.equal(called, true);
    assert.equal(
      Object.getOwnPropertyDescriptor(wrapped, "load")?.configurable,
      false,
    );
    assert.equal(Object.isExtensible(wrapped), false);
  });

  test("supports freezing a mutable wrapped loader", () => {
    const loader = { name: "mutable", async load() {} };
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    });

    Object.defineProperty(wrapped, "load", { enumerable: false });
    assert.equal(
      Object.getOwnPropertyDescriptor(wrapped, "load")?.enumerable,
      false,
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(loader, "load")?.enumerable,
      false,
    );
    Object.freeze(wrapped);
    assert.equal(Object.isFrozen(wrapped), true);
    assert.equal(Object.isFrozen(loader), true);
  });

  test("reflects direct source shape and prototype changes", () => {
    const loader = { name: "mutable", async load() {} };
    const wrapped = prepareMarkdownLoader(loader, {
      generation: 1,
      base: "/docs",
      transform: (source) => source,
    });
    const prototype = { kind: "loader" };

    Object.assign(loader, { added: true });
    Object.setPrototypeOf(loader, prototype);
    assert.equal("added" in wrapped, true);
    assert.equal(Object.getPrototypeOf(wrapped), prototype);
  });

  test("rejects ambiguous capability generations", () => {
    const loader = { name: "custom", async load() {} };
    for (const generation of [0, NaN, Infinity, 1.5]) {
      assert.throws(
        () =>
          prepareMarkdownLoader(loader, {
            generation,
            base: "/docs",
            transform: (source) => source,
          }),
        /positive safe integer/,
      );
    }
  });
});
