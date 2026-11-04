// Nimbus serves /nimbus-api/coordinates.json itself, unless the project owns
// the path; an older starter's copy is recognised by `check`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build, type AstroIntegration } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";
import { runChecks } from "../src/check/run.ts";
import { coordinatesRouteOwner } from "../src/_internal/coordinates-route.ts";
import { TEST_TMP } from "./fixtures/temp-root.js";

const runtime = JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/runtime.ts")).href);
// The starter's route file, as it shipped (importing the workspace runtime).
const starterRoute = `import { getCoordinatesManifest } from ${runtime};

export const prerender = true;

export async function GET() {
  const manifest = await getCoordinatesManifest();
  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
`;
const OWNED = 'export const prerender = true;\nexport function GET() { return new Response("owned"); }\n';
const MANIFEST = "dist/nimbus-api/coordinates.json";

test("Nimbus serves the manifest on a site without api, and with one the same bytes as the starter's file", async () => {
  const empty = await fixture();
  const api = await fixture(undefined, "docs", true);
  try {
    await build(empty.config);
    assert.equal(await empty.read(MANIFEST), '{"version":2,"collections":{}}');
    assert.doesNotMatch(await empty.read("dist/.well-known/ard.json"), /coordinates/, "no discovery link");

    await build(api.config);
    const served = await api.read(MANIFEST);
    assert.match(served, /"pets"/);
    await api.write("src/pages/nimbus-api/coordinates.json.ts", starterRoute);
    await build(api.config);
    assert.equal(await api.read(MANIFEST), served, "byte-identical to the starter file's output");
  } finally {
    await rm(empty.root, { recursive: true, force: true });
    await rm(api.root, { recursive: true, force: true });
  }
});

test("each kind of owner keeps the path, and Nimbus doesn't serve it", async () => {
  const owners: Array<[string, (site: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>, (site: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
    ["endpoint", (site) => site.write("src/pages/nimbus-api/coordinates.json.ts", OWNED), async (site) => assert.equal(await site.read(MANIFEST), "owned")],
    ["index endpoint", (site) => site.write("src/pages/nimbus-api/coordinates.json/index.js", OWNED), async (site) => assert.equal(await site.read(MANIFEST), "owned")],
    ["public file", (site) => site.write("public/nimbus-api/coordinates.json", "public"), async (site) => assert.equal(await site.read(MANIFEST), "public")],
    [
      "page",
      (site) => site.write("src/pages/nimbus-api/coordinates.json.astro", "<p>owner page</p>"),
      async (site) => {
        const page = await site.read("dist/nimbus-api/coordinates.json/index.html").catch(() => site.read(MANIFEST));
        assert.match(page, /owner page/);
      },
    ],
  ];
  for (const [kind, own, verify] of owners) {
    const site = await fixture();
    try {
      await own(site);
      await build(site.config);
      await verify(site);
    } catch (error) {
      throw new Error(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

test("a file whose name differs only by case doesn't own the path", () => {
  const root = mkdtempSync(path.join(TEST_TMP, "nimbus-coordinates-case-"));
  try {
    const at = (file: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "x");
    };
    const owner = () =>
      coordinatesRouteOwner({ srcDir: path.join(root, "src"), publicDir: path.join(root, "public"), projectRoot: root });
    at("src/pages/nimbus-api/Coordinates.json.ts");
    at("public/nimbus-api/COORDINATES.json");
    assert.equal(owner(), undefined, "Astro and hosts match names by case");
    at("src/pages/nimbus-api/coordinates.json.TS");
    assert.equal(owner(), undefined, "extensions too");
    // Remove the miscased file first: a case-insensitive disk would reuse its name.
    rmSync(path.join(root, "public/nimbus-api/COORDINATES.json"));
    at("public/nimbus-api/coordinates.json");
    assert.equal(owner(), "public/nimbus-api/coordinates.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a redirect from the path owns it, and a custom srcDir's endpoint does too", async () => {
  const redirected = await fixture();
  const custom = await fixture();
  try {
    await build({ ...redirected.config, redirects: { "/nimbus-api/coordinates.json": "/elsewhere" } });
    assert.doesNotMatch(await redirected.read(MANIFEST).catch(() => ""), /"version":2/);

    // The fixture's pages move under app/, with its own manifest endpoint.
    const { cp } = await import("node:fs/promises");
    await cp(path.join(custom.root, "src"), path.join(custom.root, "app"), { recursive: true });
    await custom.write("app/pages/nimbus-api/coordinates.json.ts", OWNED);
    await build({ ...custom.config, srcDir: "./app" });
    assert.equal(await custom.read(MANIFEST), "owned");
  } finally {
    await rm(redirected.root, { recursive: true, force: true });
    await rm(custom.root, { recursive: true, force: true });
  }
});

test("an owner under a page extension Nimbus can't see fails the build with the fix, in either integration order", async () => {
  const extension: AstroIntegration = {
    name: "test:page-extension",
    hooks: { "astro:config:setup": ({ addPageExtension }) => addPageExtension(".page") },
  };
  for (const order of ["before", "after"] as const) {
    const site = await fixture();
    try {
      await site.write("src/pages/nimbus-api/coordinates.json.page", "owner");
      const integrations = order === "before" ? [extension, ...site.config.integrations] : [...site.config.integrations, extension];
      await assert.rejects(
        build({ ...site.config, integrations }),
        /src\/pages\/nimbus-api\/coordinates\.json\.page and Nimbus both serve \/nimbus-api\/coordinates\.json\. Nimbus serves it itself now, so delete your file, or rename it to a `\.ts` endpoint/,
        order,
      );
    } finally {
      await rm(site.root, { recursive: true, force: true });
    }
  }
});

function project(route?: string) {
  const dir = mkdtempSync(path.join(TEST_TMP, "nimbus-coordinates-check-"));
  mkdirSync(path.join(dir, "src/pages/nimbus-api"), { recursive: true });
  writeFileSync(
    path.join(dir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
import nimbus from "@cloudflare/nimbus-docs";
export default defineConfig({ integrations: [nimbus({ site: "https://example.test", title: "Test", search: false })] });
`,
  );
  writeFileSync(
    path.join(dir, "src/content.config.ts"),
    'import { defineCollection } from "astro:content";\nimport { docsCollection } from "@cloudflare/nimbus-docs/content";\nexport const collections = { docs: defineCollection(docsCollection()) };\n',
  );
  if (route !== undefined) writeFileSync(path.join(dir, "src/pages/nimbus-api/coordinates.json.ts"), route);
  return dir;
}

const scopes = { env: false, structure: true, migrations: false, authoring: false, types: false };
const copies = [0, 1].map((n) =>
  readFileSync(path.join(import.meta.dirname, `fixtures/coordinates-route/starter-${n}.ts.txt`), "utf8"),
);

test("check: an unchanged starter copy (either release, either line ending) can be deleted; an edited one gets nothing", async () => {
  for (const source of [...copies, copies[1]!.replaceAll("\n", "\r\n"), `${copies[1]}// mine\n`, undefined]) {
    const dir = project(source);
    try {
      const result = await runChecks(dir, scopes);
      const found = result.findings.filter((finding) => finding.code === "nimbus/coordinates-route-copy");
      const unchanged = source !== undefined && !source.includes("// mine");
      assert.equal(found.length, unchanged ? 1 : 0, JSON.stringify(found));
      if (unchanged) {
        assert.equal(found[0]!.severity, "info");
        assert.match(found[0]!.message, /Nimbus serves \/nimbus-api\/coordinates\.json itself now.*can be deleted/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
