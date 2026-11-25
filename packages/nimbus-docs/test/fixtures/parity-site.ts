// A site whose page collections differ only in where their files come from,
// for the page-collection contract: `docs`, a glob under `src/content/docs`
// mounted at the root; `ext`, a hand-written `withNimbusMarkdown(glob())`
// over `external/ext` (outside `src/`, the shape of a git checkout) mounted
// at `/ext`; and `mem`, an in-memory loader through `withNimbusMarkdown()`
// mounted at `/mem`. Each test writes the pages it needs.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroInlineConfig } from "astro";

import nimbus from "../../src/index.ts";
import { runningNimbusVersion } from "../../src/_internal/upgrades.ts";
import { SMALLCO_SPEC } from "./agent-site.ts";
import { TEST_TMP } from "./temp-root.ts";

export const src = (relative: string) =>
  JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../src", relative)).href);

export interface MemoryPage {
  id: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface ParitySiteOptions {
  /** Pages of the in-memory collection, written into `content.config.ts`. */
  memory?: MemoryPage[];
  /** Extra collections, as `name: expression` lines of the collections object. */
  extraCollections?: string[];
  /** Extra import lines for `content.config.ts`. */
  contentImports?: string[];
  /** Nimbus integration options (callouts, MDX validation). */
  integration?: Record<string, unknown>;
  /** Nimbus config `sources`. */
  sources?: Record<string, unknown>;
  /** Extra Nimbus config fields. */
  nimbus?: Record<string, unknown>;
  /** Extra route files, `src/pages/...` → contents. */
  routes?: Record<string, string>;
  logLevel?: "silent" | "warn" | "info";
  /**
   * Write `src/components.ts` (a global `Aside` and `Badge`) and pass it to
   * every page's `<Content components>`, as the starter does.
   */
  components?: boolean;
}

export interface ParitySite {
  root: string;
  config: AstroInlineConfig;
  /** A fresh config with other `sources` or Nimbus fields (each build gets its own integration). */
  configure: (patch?: {
    sources?: Record<string, unknown>;
    nimbus?: Record<string, unknown>;
    integration?: Record<string, unknown>;
  }) => AstroInlineConfig;
  write: (file: string, body: string) => Promise<void>;
  read: (file: string) => Promise<string>;
  remove: () => Promise<void>;
}

export function pageRoute(collection: string, components = false): string {
  return [
    "---",
    ...(components ? [`import { components } from "../../components";`] : []),
    `import { getCollectionStaticPaths, getCollectionPage } from ${src("runtime.ts")};`,
    "export const prerender = true;",
    `export const getStaticPaths = getCollectionStaticPaths(${JSON.stringify(collection)});`,
    "const page = await getCollectionPage(Astro);",
    "if (page instanceof Response) return page;",
    "const { entry, Content } = page;",
    "---",
    `<html><head><title>{entry.data.title}</title></head><body><main data-collection=${JSON.stringify(collection)}><Content${components ? " components={components}" : ""} /></main></body></html>`,
  ].join("\n");
}

export async function paritySite(options: ParitySiteOptions = {}): Promise<ParitySite> {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, "nimbus-parity-")));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body, "utf8");
  };
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await write("package.json", '{"type":"module"}\n');
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await mkdir(path.join(root, "src/content/docs"), { recursive: true });
  await mkdir(path.join(root, "external/ext"), { recursive: true });
  await write(
    "src/content.config.ts",
    [
      `import { defineCollection } from "astro:content";`,
      `import { glob } from "astro/loaders";`,
      ...(options.contentImports ?? []),
      `import { apiCollection, docsCollection, withNimbusMarkdown } from ${src("content.ts")};`,
      `const MEMORY = ${JSON.stringify(options.memory ?? [])};`,
      `const memoryLoader = {`,
      `  name: "memory",`,
      `  async load({ store, parseData, renderMarkdown, generateDigest }) {`,
      `    store.clear();`,
      `    for (const page of MEMORY) {`,
      `      const data = await parseData({ id: page.id, data: { title: page.title, ...(page.draft ? { draft: true } : {}) } });`,
      `      store.set({ id: page.id, data, body: page.body, rendered: await renderMarkdown(page.body), digest: generateDigest(page.body) });`,
      `    }`,
      `  },`,
      `};`,
      `export const collections = {`,
      `  docs: defineCollection(docsCollection()),`,
      `  ext: defineCollection({ loader: withNimbusMarkdown(glob({ base: "./external/ext", pattern: "**/*.{md,mdx}" })), schema: docsCollection().schema }),`,
      `  mem: defineCollection({ loader: withNimbusMarkdown(memoryLoader), schema: docsCollection().schema }),`,
      ...(options.extraCollections ?? []).map((line) => `  ${line},`),
      `  api: defineCollection(apiCollection()),`,
      `};`,
      "",
    ].join("\n"),
  );
  await write(
    "src/pages/[...slug].astro",
    [
      "---",
      `import { getDocsStaticPaths, getDocsPageProps } from ${src("runtime.ts")};`,
      "export const prerender = true;",
      "export const getStaticPaths = getDocsStaticPaths;",
      ...(options.components ? [`import { components } from "../components";`] : []),
      "const { entry, Content } = await getDocsPageProps(Astro);",
      "---",
      `<html><head><title>{entry.data.title}</title></head><body><main data-collection="docs"><Content${options.components ? " components={components}" : ""} /></main></body></html>`,
    ].join("\n"),
  );
  await write("src/pages/ext/[...slug].astro", pageRoute("ext", options.components));
  await write("src/pages/mem/[...slug].astro", pageRoute("mem", options.components));
  if (options.components) {
    await write(
      "src/components/Aside.astro",
      `---\nconst { type = "note", title } = Astro.props;\n---\n<aside data-type={type} aria-label={title}><slot /></aside>\n`,
    );
    await write("src/components/Badge.astro", `---\nconst { text } = Astro.props;\n---\n<span class="badge">{text}</span>\n`);
    await write(
      "src/components.ts",
      `import Aside from "./components/Aside.astro";\nimport Badge from "./components/Badge.astro";\n\nexport const components = {\n  Aside,\n  Badge,\n};\n`,
    );
  }
  await write(
    "src/pages/api/[...slug].astro",
    [
      "---",
      `import { getApiStaticPaths, getApiPage } from ${src("runtime.ts")};`,
      "export const prerender = true;",
      `export const getStaticPaths = getApiStaticPaths("api");`,
      "const { page } = await getApiPage(Astro);",
      "---",
      "<html><head><title>{page.title}</title></head><body>{page.title}</body></html>",
    ].join("\n"),
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { llmsRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET } = llmsRoute();\n`,
  );
  await write(
    "src/pages/[...section]/llms.txt.ts",
    `import { llmsSectionRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = llmsSectionRoute();\n`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${src("agent-endpoints.ts")};\nexport const prerender = true;\nexport const { GET, getStaticPaths } = markdownRoute();\n`,
  );

  for (const [file, body] of Object.entries(options.routes ?? {})) await write(file, body);

  const configure = (
    patch: { sources?: Record<string, unknown>; nimbus?: Record<string, unknown>; integration?: Record<string, unknown> } = {},
  ): AstroInlineConfig => ({
    root: `${root}${path.sep}`,
    configFile: false,
    cacheDir: path.join(root, ".astro"),
    vite: { cacheDir: path.join(root, ".vite") },
    logLevel: options.logLevel ?? "silent",
    integrations: [
      nimbus(
        {
          site: "https://docs.example.test",
          title: "Parity Docs",
          description: "Page collections from three kinds of loader.",
          search: false,
          api: [
            {
              collection: "api",
              spec: SMALLCO_SPEC,
              label: "SmallCo API",
              routes: { convention: "resource-action-v2" },
            },
          ],
          ...((patch.sources ?? options.sources) ? { sources: patch.sources ?? options.sources } : {}),
          ...options.nimbus,
          ...patch.nimbus,
        } as Parameters<typeof nimbus>[0],
        {
          admonitions: false,
          sitemap: false,
          icons: false,
          validateMdx: false,
          ...options.integration,
          ...patch.integration,
        } as Parameters<typeof nimbus>[1],
      ),
    ],
  });
  const config = configure();

  return {
    root,
    config,
    configure,
    write,
    read: (file) => readFile(path.join(root, file), "utf8"),
    // Retried: under load, macOS can report a folder not empty mid-removal.
    remove: () => rm(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}
