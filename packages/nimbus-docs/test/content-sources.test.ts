// The `sources` config: validation messages that never echo a credential, the
// `{ source, path }` form of `api[].spec`, URL redaction, and `check`'s
// build-free read of a templated ref.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applySourceSpecs,
  collectSourceSpecs,
  redactRepo,
  redactText,
  sourceCollectionsFor,
  type SourceCheckout,
} from "../src/_internal/content-sources.ts";
import { partitionCheckoutFiles } from "../src/cli/lint.ts";
import { __resetLastUpdatedForTests, getLastUpdatedFromGit, getLastUpdatedStats } from "../src/_internal/git-last-updated.ts";
import { parseContentSourcePath } from "../src/_internal/source-paths.ts";
import { validateNimbusConfig } from "../src/_internal/validate.ts";
import { virtualConfigPlugin } from "../src/_internal/virtual-config.ts";
import { probeSources } from "../src/check/sources.ts";

const COMMIT = "4f2c1e9a0b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
const TOKEN = "ghp_secret_abc123";
const base = { site: "https://docs.example.test", title: "Docs", search: false };

function invalid(config: unknown): string {
  try {
    validateNimbusConfig(config);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
}

test("a valid sources map normalises path and accepts a commit, a branch, and a tag", () => {
  const config = validateNimbusConfig({
    ...base,
    sources: {
      sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "./docs/" },
      cli: { repo: "git@github.com:acme/cli.git", ref: "main" },
      "api-v2": { repo: "/srv/git/api.git", ref: "v2.1.0", path: "" },
    },
  });
  assert.deepEqual(config.sources, {
    sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" },
    cli: { repo: "git@github.com:acme/cli.git", ref: "main", path: "" },
    "api-v2": { repo: "/srv/git/api.git", ref: "v2.1.0", path: "" },
  });
});

test("an abbreviated commit, a bad ref, a bad name, a parent path, and an unknown key are rejected", () => {
  assert.match(
    invalid({ ...base, sources: { sdk: { repo: "x", ref: COMMIT.slice(0, 12) } } }),
    /sources\.sdk\.ref: "sources\.<name>\.ref" looks like an abbreviated commit — use the full 40-character commit/,
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

test("a rejected sources entry never echoes the repository URL", () => {
  const repo = `https://x-access-token:${TOKEN}@github.com/acme/sdk.git`;
  for (const message of [
    invalid({ ...base, sources: { sdk: { repo, ref: "-x" } } }),
    invalid({ ...base, sources: { sdk: { repo, ref: "main", extra: 1 } } }),
    invalid({ ...base, sources: { Sdk: { repo, ref: "main" } } }),
    invalid({ ...base, sources: { sdk: { repo: 42, ref: "main" } } }),
  ]) {
    assert.ok(!message.includes(TOKEN), message);
  }
});

test("api[].spec: { source, path } names a declared source and a file inside its path", () => {
  const sources = { sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" } };
  const ok = validateNimbusConfig({
    ...base,
    sources,
    api: [{ collection: "api", spec: { source: "sdk", path: "docs/openapi.json" } }],
  });
  assert.deepEqual(ok.api?.[0]?.spec, { source: "sdk", path: "docs/openapi.json" });
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "cli", path: "openapi.json" } }] }),
    /api\.0\.spec\.source: api collection "api" reads its spec from source "cli", which "sources" doesn't declare — declared: "sdk"/,
  );
  assert.match(
    invalid({ ...base, api: [{ collection: "api", spec: { source: "sdk", path: "openapi.json" } }] }),
    /add sources: \{ "sdk": \{ repo, ref, path \} \} to the config/,
  );
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk", path: "openapi.json" } }] }),
    /reads "openapi\.json" from source "sdk", but that source checks out only "docs\/" — widen sources\.sdk\.path/,
  );
  assert.match(
    invalid({ ...base, sources, api: [{ collection: "api", spec: { source: "sdk" } }] }),
    /names no file — set path to the spec's path inside the repository/,
  );
  assert.match(
    invalid({ ...base, sources, versions: undefined, api: [{ collection: "api", versions: [{ version: "v1", spec: { source: "sdk", path: "docs/../x.json" } }] }] }),
    /api\.0\.versions\.0\.spec\.path: .*must not contain a "\.\." segment/,
  );
  // An inline document is still an inline document.
  const inline = validateNimbusConfig({ ...base, api: [{ collection: "api", spec: { openapi: "3.1.0", source: "x" } }] });
  assert.equal((inline.api?.[0]?.spec as { openapi: string }).openapi, "3.1.0");
});

test("source-backed specs are found once and pointed at the checkout of each run", () => {
  const api = [
    { collection: "api", spec: { source: "sdk", path: "./docs/openapi.json" } },
    { collection: "local", spec: "./specs/local.yaml" },
    { collection: "family", versions: [{ version: "v1", spec: { source: "sdk", path: "v1.json" } }] },
  ];
  const specs = collectSourceSpecs(api);
  assert.deepEqual(specs.map((spec) => [spec.source, spec.path]), [["sdk", "docs/openapi.json"], ["sdk", "v1.json"]]);
  const checkout = (commit: string): SourceCheckout => ({
    name: "sdk", commit, path: "", dir: "/x", contentDir: "/x", fromCache: false, floating: false,
  });
  applySourceSpecs(specs, new Map([["sdk", checkout(COMMIT)]]));
  assert.equal(api[0]!.spec, `.nimbus/sources/sdk/${COMMIT}/docs/openapi.json`);
  assert.equal(api[2]!.versions![0]!.spec, `.nimbus/sources/sdk/${COMMIT}/v1.json`);
  assert.equal(api[1]!.spec, "./specs/local.yaml");
  const next = "a".repeat(40);
  applySourceSpecs(specs, new Map([["sdk", checkout(next)]]));
  assert.equal(api[0]!.spec, `.nimbus/sources/sdk/${next}/docs/openapi.json`);
  assert.throws(() => applySourceSpecs(specs, new Map()), /reads its spec from source "sdk", which the Nimbus config doesn't declare/);
});

test("redaction drops the password, or the username when it stands alone, in URLs git accepts", () => {
  assert.equal(redactRepo(`https://x-access-token:${TOKEN}@github.com/acme/sdk.git`), "https://x-access-token@github.com/acme/sdk.git");
  assert.equal(redactRepo(`https://${TOKEN}@github.com/acme/sdk.git`), "https://github.com/acme/sdk.git");
  assert.equal(redactRepo(`file://x-access-token:${TOKEN}@/srv/git/sdk.git`), "file:///srv/git/sdk.git");
  assert.equal(redactRepo("https://github.com/acme/sdk.git"), "https://github.com/acme/sdk.git");
  assert.equal(redactRepo("git@github.com:acme/sdk.git"), "git@github.com:acme/sdk.git");
  assert.equal(redactRepo("ssh://git@github.com/acme/sdk.git"), "ssh://git@github.com/acme/sdk.git", "a short username is a login, not a token");
  assert.equal(redactText("fatal: git@host: denied", "ssh://git@host/r.git"), "fatal: git@host: denied");
  assert.equal(redactRepo("/srv/git/sdk.git"), "/srv/git/sdk.git");
  assert.equal(
    redactText(`fatal: Authentication failed for 'https://x:${TOKEN}@host/r.git/' (${TOKEN})`, `https://x:${TOKEN}@host/r.git`),
    "fatal: Authentication failed for 'https://x:***@host/r.git/' (***)",
  );
  assert.equal(redactText(`token ${TOKEN}`, `file://x:${TOKEN}@/srv/r.git`), "token ***");
  assert.equal(redactText("token a%20b", "https://u:a%20b@host/r"), "token ***");
});

test("check reads a sources literal whose refs are templated, and gives up on anything else computed", () => {
  const templated = probeSources(`{
    sdk: { repo: "https://github.com/acme/sdk.git", ref: process.env.SDK_DOCS_REF ?? "${COMMIT}", path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: (process.env.CLI_REF || "main") },
    pinned: { repo: "https://github.com/acme/api.git", ref: "${COMMIT}" },
    bare: { repo: "https://github.com/acme/x.git", ref: process.env.X_REF },
  }`);
  assert.deepEqual(templated?.probe, {
    sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, path: "docs" },
    cli: { repo: "https://github.com/acme/cli.git", ref: "main" },
    pinned: { repo: "https://github.com/acme/api.git", ref: COMMIT },
    bare: { repo: "https://github.com/acme/x.git", ref: "0".repeat(40) },
  });
  assert.deepEqual([...templated!.templated].sort(), ["bare", "cli", "sdk"]);
  assert.equal(probeSources(`{ sdk: { repo: process.env.SDK_REPO, ref: "main" } }`), null);
  assert.equal(probeSources(`{ ...shared }`), null);
  assert.equal(probeSources(`{ sdk: makeSource() }`), null);
  assert.equal(probeSources(`sources`), null);
});

test("a source editPattern needs {path}, and the page bundle gets only ref and editPattern", async () => {
  assert.match(
    invalid({ ...base, sources: { sdk: { repo: "https://github.com/acme/sdk.git", ref: COMMIT, editPattern: "https://github.com/acme/sdk/edit/main/docs" } } }),
    /"sources\.<name>\.editPattern" must contain the "\{path\}" placeholder/,
  );
  const config = validateNimbusConfig({
    ...base,
    sources: {
      sdk: { repo: `https://${TOKEN}@github.com/acme/sdk.git`, ref: "main", path: "docs", editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}" },
      cli: { repo: `https://${TOKEN}@github.com/acme/cli.git`, ref: COMMIT },
    },
  });
  assert.equal(config.sources?.sdk?.editPattern, "https://github.com/acme/sdk/edit/{ref}/{path}");

  const plugin = virtualConfigPlugin(config, {
    getIndexedCollections: async () => ["docs"],
    requestRenderingCollections: [],
    versionAlternates: {},
    apiCollections: [],
    headDefaults: {
      favicon: { file: "/favicon.ico", type: "image/x-icon" },
      socialImage: "/opengraph.png",
      ogCard: { sitePath: "/og.png", pagePrefix: "/og/", size: { width: 1200, height: 630 } },
      imageSizes: {},
    },
  });
  const bundle = (await plugin.load("\0virtual:nimbus/config")) ?? "";
  const runtime = JSON.parse(/export const config = (.*);/.exec(bundle)![1]!) as { sources?: Record<string, unknown> };
  assert.deepEqual(runtime.sources, { sdk: { ref: "main", editPattern: "https://github.com/acme/sdk/edit/{ref}/{path}" } });
  assert.ok(!bundle.includes(TOKEN) && !bundle.includes("acme/cli"), "repo never reaches the bundle");
});

test("a checkout path splits into source, commit and repository path, and gets no git date", async () => {
  assert.deepEqual(parseContentSourcePath(`.nimbus/sources/sdk/${COMMIT}/docs/guides/install.md`), {
    name: "sdk",
    commit: COMMIT,
    path: "docs/guides/install.md",
  });
  assert.deepEqual(parseContentSourcePath(`./.nimbus\\sources\\sdk\\${COMMIT}\\README.md`)?.path, "README.md");
  assert.equal(parseContentSourcePath("src/content/docs/guide.md"), undefined);
  assert.equal(parseContentSourcePath(`.nimbus/sources/sdk/${COMMIT.slice(0, 12)}/docs/a.md`), undefined);

  __resetLastUpdatedForTests();
  try {
    for (let i = 0; i < 60; i++) {
      assert.equal(await getLastUpdatedFromGit(`.nimbus/sources/sdk/${COMMIT}/docs/page-${i}.md`), undefined);
    }
    // Never indexed, never a miss: the 50-miss warning can't fire.
    assert.deepEqual(getLastUpdatedStats(), { bulkLoaded: false, isShallow: false, bulkCount: 0, missCount: 0, cached: 0 });
  } finally {
    __resetLastUpdatedForTests();
  }
});

test("lint --fix leaves checkout files aside, and a checkout file takes its collection's rules", () => {
  const cwd = path.join(os.tmpdir(), "site");
  const local = path.join(cwd, "src/content/docs/guide.mdx");
  const remote = path.join(cwd, ".nimbus/sources/sdk", COMMIT, "docs/guide.mdx");
  assert.deepEqual(partitionCheckoutFiles([local, remote], cwd), { local: [local], checkout: [remote] });

  const dir = mkdtempSync(path.join(os.tmpdir(), "nimbus-sources-"));
  try {
    assert.deepEqual(sourceCollectionsFor(dir), {}, "no content config");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "src/content.config.ts"),
      `export const collections = {
  docs: defineCollection(docsCollection()),
  sdk: defineCollection(docsCollection({ source: "sdk" })),
  "sdk-mirror": defineCollection(docsCollection({ source: "sdk" })),
};
`,
    );
    assert.deepEqual(sourceCollectionsFor(dir), { sdk: "sdk" }, "the first collection reading a source wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
