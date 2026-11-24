// The `sources` config: validation, the credential refusal (no message ever
// echoes one), the `{ source, path }` form of `api[].spec`, log redaction,
// `check`'s build-free read of a templated ref and its deferral when the map
// is computed, the page bundle, and snapshot paths at runtime.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  applySourceSpecs,
  collectSourceSpecs,
  describeSourceReaders,
  resolveContentSources,
  type SourceSnapshot,
  unavailableSourceWarning,
} from "../src/_internal/content-sources.ts";
import { parsePageCollectionSources, placeStaticCollections } from "../src/_internal/parse-content-collections.ts";
import { __resetLastUpdatedForTests, getLastUpdatedFromGit, getLastUpdatedStats } from "../src/_internal/git-last-updated.ts";
import { parseContentSourcePath } from "../src/_internal/source-paths.ts";
import { redactRepo, redactUrlUserinfo, repoCredentialFault } from "../src/_internal/source-repo.ts";
import { validateNimbusConfig } from "../src/_internal/validate.ts";
import { virtualConfigPlugin } from "../src/_internal/virtual-config.ts";
import { runChecks } from "../src/check/run.ts";
import { probeSources } from "../src/check/sources.ts";
import { TEST_TMP } from "./fixtures/temp-root.ts";

const COMMIT = "4f2c1e9a0b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
const IDENTITY = "0123456789abcdef";
const TOKEN = "ghp_secret_abc123XYZ";
const base = { site: "https://docs.example.test", title: "Docs", search: false };

function invalid(config: unknown): string {
  try {
    validateNimbusConfig(config);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
}

test("a valid sources map normalises path and accepts a commit, a branch, a tag and ssh usernames", () => {
  const config = validateNimbusConfig({
    ...base,
    sources: {
      sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "./docs/" },
      cli: { repo: "git@github.com:acme/cli.git", ref: "main" },
      ssh: { repo: "ssh://git@github.com/acme/ssh.git", ref: "main" },
      "api-v2": { repo: "../api", ref: "v2.1.0", path: "" },
    },
  });
  assert.deepEqual(config.sources, {
    sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" },
    cli: { repo: "git@github.com:acme/cli.git", ref: "main", path: "" },
    ssh: { repo: "ssh://git@github.com/acme/ssh.git", ref: "main", path: "" },
    "api-v2": { repo: "../api", ref: "v2.1.0", path: "" },
  });
});

test("an abbreviated commit, a bad ref, a bad name, a parent path, and an unknown key are rejected", () => {
  assert.match(
    invalid({ ...base, sources: { sdk: { repo: "x", ref: COMMIT.slice(0, 12) } } }),
    /sources\.sdk\.ref: "sources\.<name>\.ref" looks like an abbreviated commit\. Use the full 40-character commit/,
  );
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "-rf" } } }), /must be a 40-character commit or a branch or tag name/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "feature..x" } } }), /must be a 40-character commit or a branch or tag name/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "" } } }), /must not be empty/);
  assert.match(invalid({ ...base, sources: { SDK: { repo: "x", ref: "main" } } }), /source name "SDK" must be lowercase letters, digits, and dashes/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "main", path: "../docs" } } }), /must not contain a "\.\." segment/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "main", path: "/docs" } } }), /must be relative to the repository root/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "x", ref: "main", branch: "main" } } }), /sources field "branch"/);
  assert.match(invalid({ ...base, sources: { sdk: { ref: "main" } } }), /sources\.sdk\.repo/);
  assert.match(invalid({ ...base, sources: { sdk: { repo: "--upload-pack=x", ref: "main" } } }), /must not start with "-"/);
});

test("a credential in repo fails validation in every shape, and no message carries any part of it", () => {
  const shapes = [
    `https://x-access-token:${TOKEN}@github.com/acme/sdk.git`, // token as password
    `https://${TOKEN}@github.com/acme/sdk.git`, // token as username
    `https://${TOKEN}:x-oauth-basic@github.com/acme/sdk.git`,
    "https://user:ab@github.com/acme/sdk.git", // a two-character password
    `https://user:${encodeURIComponent(`${TOKEN}/+=`)}@github.com/acme/sdk.git`, // percent-encoded
    `ssh://git:${TOKEN}@github.com/acme/sdk.git`,
    `git:${TOKEN}@github.com:acme/sdk.git`,
  ];
  for (const repo of shapes) {
    const message = invalid({ ...base, sources: { sdk: { repo, ref: "main" } } });
    assert.match(message, /sources\.sdk\.repo: "sources\.<name>\.repo" has (a username or token|a password) in the URL/, repo);
    assert.match(message, /\*\*\*@/);
    assert.match(message, /credential helper/);
    for (const part of [TOKEN, encodeURIComponent(`${TOKEN}/+=`), "user:ab", ":ab@"]) {
      assert.ok(!message.includes(part), `${repo}: ${message}`);
    }
  }
  // Other faults in the same entry never echo the URL either.
  const repo = `https://x-access-token:${TOKEN}@github.com/acme/sdk.git`;
  for (const message of [
    invalid({ ...base, sources: { sdk: { repo, ref: "-x" } } }),
    invalid({ ...base, sources: { sdk: { repo, ref: "main", extra: 1 } } }),
    invalid({ ...base, sources: { Sdk: { repo, ref: "main" } } }),
  ]) {
    assert.ok(!message.includes(TOKEN), message);
  }
  assert.equal(repoCredentialFault("git@github.com:acme/sdk.git"), undefined);
  assert.equal(repoCredentialFault("ssh://git@github.com/acme/sdk.git"), undefined);
  assert.equal(repoCredentialFault("/srv/git/sdk.git"), undefined);
});

test("git's output loses every URL's userinfo, raw or percent-encoded, at any length", () => {
  assert.equal(
    redactUrlUserinfo(`fatal: Authentication failed for 'https://x:${TOKEN}@host/r.git/'`),
    "fatal: Authentication failed for 'https://***@host/r.git/'",
  );
  assert.equal(redactUrlUserinfo("remote: https://a@h/x and https://h/y"), "remote: https://***@h/x and https://h/y");
  assert.equal(redactUrlUserinfo(`url=https%3A%2F%2F${TOKEN}%40host%2Fr`), "url=https%3A%2F%2F***@host%2Fr");
  assert.equal(redactUrlUserinfo("fatal: git@host: denied"), "fatal: git@host: denied");
  assert.equal(redactRepo(`https://${TOKEN}@github.com/acme/sdk.git`), "https://***@github.com/acme/sdk.git");
});

test("api[].spec: { source, path } names a declared source and a file inside its path", () => {
  const sources = { sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" } };
  const ok = validateNimbusConfig({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }] });
  assert.deepEqual(ok.api?.[0]?.spec, { source: "sdk", path: "docs/openapi.json" });
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "cli", path: "openapi.json" } }] }),
    /api\.0\.spec\.source: api collection "api" reads its spec from source "cli", which "sources" doesn't declare\. Declared: "sdk"/,
  );
  assert.match(
    invalid({ ...base, api: [{ collection: "api", spec: { source: "sdk", path: "openapi.json" } }] }),
    /Add sources: \{ "sdk": \{ repo, ref, path \} \} to the config/,
  );
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk", path: "openapi.json" } }] }),
    /reads "openapi\.json" from source "sdk", but that source checks out only "docs\/"\. Widen sources\.sdk\.path/,
  );
  assert.match(invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk" } }] }), /names no file/);
  // Deferred when `check` can't read the map: everything else still validates.
  assert.doesNotThrow(() =>
    validateNimbusConfig({ ...base, api: [{ collection: "api", spec: { source: "sdk", path: "x.json" } }] }, { deferSources: true }),
  );
  const inline = validateNimbusConfig({ ...base, api: [{ collection: "api", spec: { openapi: "3.1.0", source: "x" } }] });
  assert.equal((inline.api?.[0]?.spec as { openapi: string }).openapi, "3.1.0");
});

test("source-backed specs are found once and pointed at each run's snapshot", () => {
  const api = [
    { collection: "api", spec: { source: "sdk", path: "./docs/openapi.json" } },
    { collection: "local", spec: "./specs/local.yaml" },
    { collection: "family", versions: [{ version: "v1", spec: { source: "sdk", path: "v1.json" } }] },
  ];
  const specs = collectSourceSpecs(api as never);
  assert.deepEqual(specs.map((spec) => [spec.source, spec.path]), [["sdk", "docs/openapi.json"], ["sdk", "v1.json"]]);
  const root = "/site";
  const snapshot = (commit: string): SourceSnapshot => {
    const dir = path.join(root, ".nimbus/sources/sdk", IDENTITY, commit);
    return { name: "sdk", identity: IDENTITY, kind: "git", revision: commit, path: "", dir, contentDir: dir, floating: false };
  };
  applySourceSpecs(specs, new Map([["sdk", snapshot(COMMIT)]]), root);
  assert.equal(api[0]!.spec, `.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/docs/openapi.json`);
  assert.equal((api[2] as { versions: { spec: unknown }[] }).versions[0]!.spec, `.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/v1.json`);
  assert.equal(api[1]!.spec, "./specs/local.yaml");
  assert.throws(() => applySourceSpecs(specs, new Map(), root), /which the Nimbus config doesn't declare/);
});

test("check reads a sources literal whose refs are templated, and gives up on anything else computed", () => {
  const templated = probeSources(`{
    sdk: { repo: "https://github.com/acme/sdk.git", ref: process.env.SDK_DOCS_REF ?? "${COMMIT}", path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: (process.env.CLI_REF || "main") },
    pinned: { repo: "https://github.com/acme/api.git", ref: "${COMMIT}" },
  }`);
  assert.deepEqual(templated?.probe, {
    sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: "main" },
    pinned: { repo: "https://github.com/acme/api.git", ref: COMMIT },
  });
  assert.deepEqual([...templated!.templated].sort(), ["cli", "sdk"]);
  assert.equal(probeSources(`{ sdk: { repo: process.env.SDK_REPO, ref: "main" } }`), null);
  assert.equal(probeSources(`{ ...shared }`), null);
});

function checkProject(sources: string, contentConfig: string, api = `[{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }]`) {
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-sources-check-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
const nimbusConfig = defineNimbusConfig({
  site: "https://example.test",
  title: "Test",
  search: false,
  sources: ${sources},
  api: ${api},
});
export default defineConfig({ integrations: [nimbus(nimbusConfig)] });
`,
  );
  writeFileSync(path.join(dir, "src/content.config.ts"), contentConfig);
  return dir;
}

const CONTENT = `import { defineCollection } from "astro:content";
export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ source: "sdk", base: "guides" })),
  api: defineCollection(apiCollection()),
};
`;

test("check: a templated ref keeps readiness, a branch floats, an unread source is reported", async () => {
  const dir = checkProject(
    `{
    sdk: { repo: "https://github.com/acme/sdk.git", ref: process.env.SDK_DOCS_REF ?? "${COMMIT}", path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: "main" },
  }`,
    CONTENT,
  );
  try {
    const result = await runChecks(dir, { env: false, structure: true, migrations: false, authoring: false, types: false });
    const codes = result.findings.map((finding) => finding.code).sort();
    assert.ok(!codes.includes("nimbus/config-invalid"), JSON.stringify(result.findings));
    assert.ok(!result.scopes[0]!.notes.some((note) => note.code === "nimbus/config-unresolved"), "templated ref stays readable");
    const floating = result.findings.filter((finding) => finding.code === "nimbus/source-floating-ref");
    assert.deepEqual(floating.map((finding) => finding.message.split(" ")[0]), ["sources.cli"]);
    const unread = result.findings.filter((finding) => finding.code === "nimbus/source-unreferenced");
    assert.deepEqual(unread.map((finding) => finding.message.split(" ")[0]), ["sources.cli"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check: a computed repo defers the source checks only; a literal map without the spec's source still fails", async () => {
  const computed = checkProject(`{ sdk: { repo: process.env.SDK_REPO, ref: "main", path: "docs" } }`, CONTENT);
  const missing = checkProject(`{ cli: { repo: "https://github.com/acme/cli.git", ref: "${COMMIT}" } }`, CONTENT);
  try {
    const scopes = { env: false, structure: true, migrations: false, authoring: false, types: false };
    const deferred = await runChecks(computed, scopes);
    assert.ok(!deferred.findings.some((finding) => finding.code === "nimbus/config-invalid"), JSON.stringify(deferred.findings));
    assert.ok(deferred.scopes[0]!.notes.some((note) => note.code === "nimbus/config-unresolved" && /`sources`/.test(note.reason)));
    const failed = await runChecks(missing, scopes);
    const invalidFinding = failed.findings.find((finding) => finding.code === "nimbus/config-invalid");
    assert.match(invalidFinding?.message ?? "", /reads its spec from source "sdk", which "sources" doesn't declare/);
  } finally {
    rmSync(computed, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("a source editPattern needs {path}, and the page bundle gets only ref and editPattern", async () => {
  assert.match(
    invalid({ ...base, sources: { sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, editPattern: "https://github.com/acme/sdk/edit/main/docs" } } }),
    /"sources\.<name>\.editPattern" must contain the "\{path\}" placeholder/,
  );
  const config = validateNimbusConfig({
    ...base,
    sources: {
      sdk: { repo: "https://github.com/acme/sdk.git", ref: "main", path: "docs", editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}" },
      cli: { repo: "https://github.com/acme/cli.git", ref: COMMIT },
    },
  });
  const plugin = virtualConfigPlugin(config, {
    getIndexedCollections: async () => ["docs"],
    requestRenderingCollections: [],
    base: "/",
    versionAlternates: {},
    apiCollections: [],
    collectionRoutes: new Map(),
    unreadCollectionRoutes: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
      ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
      imageSizes: {},
    },
  } as never);
  const bundle = String((await (plugin as { load: (id: string) => unknown }).load("\0virtual:nimbus/config")) ?? "");
  const runtime = JSON.parse(/export const config = (.*);/.exec(bundle)![1]!) as { sources?: Record<string, unknown> };
  assert.deepEqual(runtime.sources, { sdk: { ref: "main", editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}" } });
  assert.ok(!bundle.includes("acme/cli") && !bundle.includes("sdk.git"), "repo never reaches the bundle");
});

test("a snapshot path splits into source, identity, commit and repository path, and gets no git date", async () => {
  assert.deepEqual(parseContentSourcePath(`.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/docs/guides/install.md`), {
    name: "sdk",
    identity: IDENTITY,
    commit: COMMIT,
    path: "docs/guides/install.md",
  });
  assert.equal(parseContentSourcePath("src/content/docs/guide.md"), undefined);
  assert.equal(parseContentSourcePath(`.nimbus/sources/sdk/${COMMIT}/docs/a.md`), undefined);
  __resetLastUpdatedForTests();
  try {
    for (let i = 0; i < 60; i++) {
      assert.equal(await getLastUpdatedFromGit(`.nimbus/sources/sdk/${IDENTITY}/${COMMIT}/docs/page-${i}.md`), undefined);
    }
    assert.equal(getLastUpdatedStats().missCount, 0);
  } finally {
    __resetLastUpdatedForTests();
  }
});

test("a source that can't be fetched and has no snapshot fails with git's error, who reads it, and the credentials link", async () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-sources-message-"));
  try {
    const sdk = { repo: path.join(root, "missing.git"), ref: "main", path: "docs" };
    const failure = async (readBy?: string) => {
      try {
        await resolveContentSources({ sdk }, { projectRoot: root, log: () => {}, readBy: readBy === undefined ? undefined : () => readBy });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the source to fail");
    };
    const message = await failure(describeSourceReaders(["sdk"], [], false));
    assert.match(
      message,
      /^nimbus-docs: could not fetch source "sdk" \([^)]*missing\.git @ main\): [^\n]*(?:does not appear to be a git repository|not found|No such file)[\s\S]*\. No snapshot of this repo, ref and path exists under \.nimbus\/sources\/sdk\/\.\n {2}Read by: collection "sdk"\.\n {2}Give git a credential: https:\/\/nimbus-docs\.com\/content-sources\/git\/#private-repositories$/,
    );
    assert.doesNotMatch(message, /NIMBUS_BUILD_ONLY/);
    assert.match(
      await failure(describeSourceReaders(["sdk-guides"], ["widgets", "widgets"], true)),
      /\n {2}Read by: collection "sdk-guides" and api entry "widgets" and collections src\/content\.config\.ts doesn't show\.\n/,
    );
    assert.match(await failure(describeSourceReaders([], [], true)), /\n {2}Read by: collections src\/content\.config\.ts doesn't show\.\n/);
    assert.match(await failure(describeSourceReaders([], [], false)), /\n {2}Read by: nothing; remove it from sources\.\n/);
    assert.match(
      await failure(describeSourceReaders(["a", "b"], [], false)),
      /\n {2}Read by: collections "a", "b"\.\n/,
    );

    // The commands that start without it get the source back as unavailable.
    const { snapshots, unavailable } = await resolveContentSources({ sdk }, { projectRoot: root, log: () => {}, mode: "degrade" });
    assert.equal(snapshots.size, 0);
    const missing = unavailable.get("sdk")!;
    assert.match(
      unavailableSourceWarning(missing, ["sdk", "sdk-guides"], "dev"),
      /^nimbus: source "sdk" \([^)]+ @ main\) is unavailable; collections "sdk", "sdk-guides" are empty until it can be fetched \(restart to retry\)\. A full build fails until then\. git: \S/,
    );
    assert.match(unavailableSourceWarning(missing, null, "sync"), /the collections that read it are empty until it can be fetched/);
    // Preview runs no git: the source is unfetched, not unreachable.
    assert.equal(
      unavailableSourceWarning({ label: missing.label }, ["sdk"], "preview"),
      `nimbus: ${missing.label} has no snapshot yet; collection "sdk" is empty (run a build to fetch it).`,
    );
    // An api entry can't render without its spec: it never degrades.
    await assert.rejects(
      resolveContentSources({ sdk }, { projectRoot: root, log: () => {}, mode: "degrade", required: new Set(["sdk"]) }),
      /could not fetch source "sdk"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the content config shows which collections read a source, and what hides a read", () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-source-reads-"));
  try {
    const file = path.join(root, "content.config.ts");
    const reads = (body: string, head = "") => {
      writeFileSync(file, `${head}\nexport const collections = {\n${body}\n};\n`);
      const parsed = parsePageCollectionSources(root, file);
      return {
        readers: Object.fromEntries(parsed.readers),
        hidden: parsed.hidden,
        kinds: Object.fromEntries([...(parsed.places ?? [])].map(([key, place]) => [key, place.kind])),
      };
    };
    // A loader beside `docsCollection().schema` (the Notion guide's shape) reads no source.
    assert.deepEqual(
      reads(
        [
          `docs: defineCollection(docsCollection()),`,
          `"sdk-guides": defineCollection(docsCollection({ source: "sdk", base: "guides" })),`,
          `notion: defineCollection({ loader: withNimbusMarkdown(notionLoader({ database: "x" })), schema: docsCollection().schema }),`,
          `fielded: defineCollection(docsCollection({ base: "f", schemaFields: { origin: z.string() } })),`,
          `api: defineCollection(apiCollection()),`,
        ].join("\n"),
        `import { notionLoader } from "./loaders/notion";`,
      ),
      { readers: { sdk: ["sdk-guides"] }, hidden: [], kinds: { docs: "folder", "sdk-guides": "source", notion: "unplaced", fielded: "folder" } },
    );
    // A shorthand or variable source is unplaced, not a src/content folder.
    assert.deepEqual(reads(`sdk: defineCollection(docsCollection({ source }))`, `const source = "sdk";`).kinds, { sdk: "unplaced" });
    assert.deepEqual(reads(`sdk: defineCollection(docsCollection({ source: name }))`, `const name = "sdk";`).kinds, { sdk: "unplaced" });
    // A schema field named `source` is a possible read; the collection stays in its folder.
    assert.deepEqual(reads(`docs: defineCollection(docsCollection({ schemaFields: { source: z.string() } }))`), {
      readers: {},
      hidden: [`collection "docs"`],
      kinds: { docs: "folder" },
    });
    // A local declaration is followed; a helper outside every entry is named by its call.
    assert.deepEqual(reads(`sdk: sdkCollection`, `const sdkCollection = defineCollection(docsCollection({ source: "sdk" }));`).readers, { sdk: ["sdk"] });
    assert.deepEqual(
      reads(`docs: defineCollection(docsCollection())`, `const make = (name) => docsCollection({ source: name });`).hidden,
      ["`docsCollection({ source: name })`"],
    );
    assert.deepEqual(reads(`[key]: defineCollection(docsCollection())`).hidden, ["the entry `[key]`"]);
    // A collection the text doesn't show as a Nimbus one may read a source:
    // a helper or imported function, an aliased or namespaced factory, a
    // conditional, a wrapped loader. Nimbus's source-free factories and a
    // plain Astro collection read none.
    for (const [entry, head] of [
      [`sdk: makeSdk("sdk")`, `import { makeSdk } from "./sdk";`],
      [`sdk: dc({ source: "sdk" })`, `import { docsCollection as dc } from "@cloudflare/nimbus-docs/content";`],
      [`sdk: defineCollection({ loader: dc({ source: "sdk" }).loader })`, `import { docsCollection as dc } from "x";`],
      [`sdk: defineCollection({ loader: $dc({ source: "sdk" }).loader })`, `import { docsCollection as $dc } from "x";`],
      [`sdk: defineCollection(n.docsCollection({ source: "sdk" }))`, `import * as n from "x";`],
      [`sdk: defineCollection(flag ? docsCollection({ source: "sdk" }) : docsCollection())`, ""],
      [`sdk: defineCollection({ loader: withNimbusMarkdown(docsCollection({ source: "sdk" }).loader) })`, ""],
    ]) {
      assert.deepEqual(reads(entry, head).hidden, [`collection "sdk"`], entry);
    }
    assert.deepEqual(
      reads(
        [
          `api: defineCollection(apiCollection()),`,
          `partials: defineCollection(partialsCollection()),`,
          `data: defineCollection({ loader: glob({ base: "data" }) }),`,
        ].join("\n"),
      ).hidden,
      [],
    );
    assert.deepEqual(reads(`docs: imported.docs`, `import * as imported from "./x";`).hidden, [`collection "docs"`]);
    // `lint` and `check` place a source collection from `current.json`; with
    // no snapshot it stays unplaced, saying why it may be missing.
    writeFileSync(file, `export const collections = {\nsdk: defineCollection(docsCollection({ source: "sdk" })),\n};\n`);
    assert.deepEqual([...placeStaticCollections(parsePageCollectionSources(root, file).places, new Map()).values()], [
      {
        kind: "unplaced",
        reason:
          'source "sdk" has no snapshot: not fetched yet, or unreachable at the last start; run a build or start the dev server',
      },
    ]);
    // No content config reads nothing.
    rmSync(file);
    assert.deepEqual(parsePageCollectionSources(root, file), { places: null, readers: new Map(), hidden: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
