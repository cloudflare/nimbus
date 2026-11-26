import { mkdtemp, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import nimbus from "../../src/index.js";
import { runningNimbusVersion } from "../../src/_internal/upgrades.js";
import { TEST_TMP } from "./temp-root.js";
import { writeFileAtomic } from "./write-file.js";

export async function discoveryFixture(
  rootContent?: string,
  collection = "docs",
  withApi: boolean | { collections: string[]; api: unknown[] } = false,
  skills?: Record<string, string>,
  nimbusOverrides: Record<string, unknown> = {},
) {
  const apiCollections =
    withApi === true ? ["pets"] : withApi ? withApi.collections : [];
  const apiConfig =
    withApi === true
      ? [{ collection: "pets", spec: path.resolve(import.meta.dirname, "api/smallco.yaml") }]
      : withApi
        ? withApi.api
        : [];
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-discovery-"));
  const write = async (file: string, body: string) => {
    await writeFileAtomic(path.join(root, file), body);
  };
  const content = pathToFileURL(
    path.resolve(import.meta.dirname, "../../src/content.ts"),
  ).href;
  const endpoints = pathToFileURL(
    path.resolve(import.meta.dirname, "../../src/agent-endpoints.ts"),
  ).href;
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await write("package.json", '{"type":"module"}');
  await write(
    "nimbus.json",
    JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
  );
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content"; import { docsCollection, apiCollection } from ${JSON.stringify(content)};\nexport const collections = { ${collection}: defineCollection(docsCollection({ base: "${collection}" }))${apiCollections.map((name) => `, "${name}": defineCollection(apiCollection())`).join("")} };`,
  );
  await write(
    `src/content/${collection}/guide.mdx`,
    "---\ntitle: Guide\n---\n## Start\nHello discovery.",
  );
  if (rootContent)
    await write(`src/content/${collection}/index.mdx`, rootContent);
  for (const [file, body] of Object.entries(skills ?? {}))
    await write(`skills/${file}`, body);
  await write(
    "src/pages/index.astro",
    '---\nAstro.response.headers.set("Link", \'<https://example.net/help>; rel="help"\');\n---\n<html><head><title>Home</title></head><body>Owner homepage</body></html>',
  );
  await write(
    "src/pages/llms.txt.ts",
    // Astro reads `export const prerender` only at the start of a line.
    `import { llmsRoute } from ${JSON.stringify(endpoints)};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${JSON.stringify(endpoints)};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
  );
  await write(
    "public/_headers",
    '/custom\n  X-Owner: unchanged\n/docs/\n  Link: <https://example.net/help>; rel="help"',
  );
  const config = {
    root: pathToFileURL(root + path.sep),
    configFile: false as const,
    cacheDir: path.join(root, ".astro"),
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: "silent" as const,
    base: "/docs",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Example",
          search: false,
          ...(apiConfig.length ? { api: apiConfig as never } : {}),
          ...nimbusOverrides,
        },
        { sitemap: false, icons: false, validateMdx: false },
      ),
    ],
  };
  return {
    root,
    config,
    write,
    read: (file: string) => readFile(path.join(root, file), "utf8"),
    readBytes: (file: string) => readFile(path.join(root, file)),
  };
}
