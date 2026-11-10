// The ai-search recipe's switch, applied to the starter: its provider file
// type-checks and the dialog bundles it in place of Pagefind.
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
  const step = recipe.slice(recipe.indexOf(`Create \`${provider}\``));
  const code = step.match(/```ts\n([\s\S]*?)\n\s*```/)![1]!.replace(/^ {3}/gm, "");
  await writeFile(join(site, provider), `${code}\n`);

  const client = join(site, "src/components/ui/search/search.client.ts");
  const source = await readFile(client, "utf8");
  assert.ok(source.includes('from "./providers/pagefind"'));
  await writeFile(client, source.replace('from "./providers/pagefind"', 'from "./providers/ai-search"'));

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

test("the recipe's provider type-checks against the starter's dialog", () => {
  astro("check");
});

test("the build bundles the provider and no Pagefind index", async () => {
  astro("build");
  const dist = join(site, "dist");
  assert.ok(!existsSync(join(dist, "pagefind")));
  assert.ok(existsSync(join(dist, "_nimbus/search-corpus.json")));
  const scripts = (await readdir(join(dist, "_astro"))).filter((file) => file.endsWith(".js"));
  const bundled = await Promise.all(scripts.map((file) => readFile(join(dist, "_astro", file), "utf8")));
  assert.ok(bundled.some((js) => js.includes("in astro.config to use this provider")), "provider missing from the client bundle");
});
