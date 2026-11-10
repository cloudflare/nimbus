// The ai-search recipe's switch, applied to the starter from the recipe's own
// code: it type-checks, the dialog bundles the provider in place of Pagefind,
// and pages carry the search scope and the WebMCP meta.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const starter = join(here, "../../../packages/nimbus-starter-source");
const provider = "src/components/ui/search/providers/ai-search.ts";
const endpoint = "https://recipe-test.search.ai.cloudflare.com";
let site = "";

const astro = (...args: string[]) =>
  execFileSync(process.execPath, [join(starter, "node_modules/astro/bin/astro.mjs"), ...args], {
    cwd: site,
    stdio: "pipe",
    encoding: "utf8",
  });

before(async () => {
  // Inside the starter, so its dependencies resolve; removed after.
  site = await mkdtemp(join(starter, ".ai-search-recipe-"));
  for (const part of ["src", "public", "astro.config.ts", "tsconfig.json", "nimbus.json", "package.json"])
    await cp(join(starter, part), join(site, part), { recursive: true });
  // Each dependency linked, not the folder, so Vite's cache stays this site's.
  await mkdir(join(site, "node_modules"));
  for (const name of await readdir(join(starter, "node_modules")))
    if (!name.startsWith(".")) await symlink(join(starter, "node_modules", name), join(site, "node_modules", name));

  const recipe = await readFile(join(here, "features/ai-search.md"), "utf8");
  /** The code blocks of the switch step that names `file`, unindented. */
  const blocks = (file: string) => {
    const step = recipe.slice(recipe.indexOf(`\`${file}\``));
    const end = step.search(/\n\d\. /);
    return [...step.slice(0, end).matchAll(/```(?:ts|astro)\n([\s\S]*?)\n\s*```/g)].map((m) => m[1]!.replace(/^ {3}/gm, ""));
  };
  const edit = async (file: string, change: (source: string) => string) => {
    const before = await readFile(join(site, file), "utf8");
    const after = change(before);
    assert.notEqual(after, before, `${file} unchanged`);
    await writeFile(join(site, file), after);
  };

  await writeFile(join(site, provider), `${blocks(provider)[0]}\n`);

  const [scope, body] = blocks("src/layouts/BaseLayout.astro");
  await edit("src/layouts/BaseLayout.astro", (source) =>
    source
      .replace("  getVersionStatus,\n", "  getPageSearchScope,\n  getVersionStatus,\n")
      .replace("const isHiddenVersion", `${scope}\nconst isHiddenVersion`)
      .replace('<body class="min-h-screen bg-background text-foreground antialiased">', body!),
  );

  const [meta] = blocks("src/components/WebMCP.astro");
  await edit("src/components/WebMCP.astro", (source) =>
    source
      .replace('import { searchIndex } from "virtual:nimbus/config";', 'import { config, searchIndex, searchVersionChoices } from "virtual:nimbus/config";')
      .replace("\n)}\n", `\n)}\n${meta}\n`),
  );

  await edit("src/components/ui/search/search.client.ts", (source) =>
    source.replace('from "./providers/pagefind"', 'from "./providers/ai-search"'),
  );

  const config = join(site, "astro.config.ts");
  await writeFile(
    config,
    (await readFile(config, "utf8")).replace(
      "const nimbusConfig = defineNimbusConfig({\n",
      `const nimbusConfig = defineNimbusConfig({\n  search: { provider: "ai-search", endpoint: "${endpoint}", instance: "recipe-test" },\n`,
    ),
  );
});

after(async () => {
  if (site) await rm(site, { recursive: true, force: true });
});

test("the recipe's switch type-checks against the starter", () => {
  astro("check");
});

test("the build bundles the provider, writes the scope and the WebMCP meta, and no Pagefind index", async () => {
  astro("build");
  const dist = join(site, "dist");
  assert.ok(!existsSync(join(dist, "pagefind")));
  assert.ok(existsSync(join(dist, "_nimbus/search-corpus.json")));
  const scripts = (await readdir(join(dist, "_astro"))).filter((file) => file.endsWith(".js"));
  const bundled = await Promise.all(scripts.map((file) => readFile(join(dist, "_astro", file), "utf8")));
  assert.ok(bundled.some((js) => js.includes("in astro.config to use this provider")), "provider missing from the client bundle");

  const home = await readFile(join(dist, "index.html"), "utf8");
  assert.match(home, /<body[^>]*\sdata-nb-search-version="[^"]+"[^>]*\sdata-nb-search-deprecated="false"/);
  assert.match(home, /<meta name="nimbus-webmcp" content="[^"]*&quot;search&quot;:&quot;ai-search&quot;[^"]*&quot;endpoint&quot;/);
});
