import fs from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { AgentEndpointAssetManifest } from "./agent-endpoint-assets.js";
import {
  corpusHash,
  SEARCH_CORPUS_FORMAT,
  SEARCH_CORPUS_PATH,
  type SearchCorpusManifest,
  type SearchCorpusPage,
} from "./search-corpus.js";
import type { SearchScopeTable } from "./search-scope.js";

/**
 * Write `_nimbus/search-corpus.json` under the build's site-wide directory.
 * Each page points at a twin that is actually in the output: the staged
 * asset on a request-rendered build, the page's own `index.md` on a static
 * one (checked against the bake's hash, so the bytes an indexer uploads are
 * the bytes agents read).
 */
export async function writeSearchCorpus(input: {
  manifest: AgentEndpointAssetManifest;
  outDir: string;
  sliceDir: string;
  site: string;
  base: string;
  slice: string;
  collections: string[];
  siteCollections: string[];
  table: SearchScopeTable;
  /** An AI Search site: a page without a twin on disk fails the build. */
  required: boolean;
  logger: { info(message: string): void; warn(message: string): void };
}): Promise<void> {
  const { manifest, outDir, table } = input;
  const records = manifest.corpus ?? [];
  const pages: SearchCorpusPage[] = [];
  const missing: string[] = [];
  for (let index = 0; index < records.length; index += 64) {
    const batch = await Promise.all(
      records.slice(index, index + 64).map(async (record) => {
        const { asset, markdownUrl, ...page } = record;
        const staged = path.posix.join("_nimbus/agent-endpoint-assets", asset);
        if (fs.existsSync(path.join(outDir, staged))) return { ...page, file: staged };
        const twin = markdownUrl.replace(/^\/+/u, "");
        const file = path.join(outDir, twin);
        if (!fs.existsSync(file)) {
          missing.push(markdownUrl);
          return undefined;
        }
        const content = (await readFile(file)).subarray(page.contentStart, page.contentEnd);
        if (corpusHash(content, page) !== page.hash) {
          throw new Error(
            `nimbus-docs: ${markdownUrl} in the output differs from the Markdown the build prepared for it, so search would index other text than agents read. ` +
              "A route in src/pages writes that file; let the Markdown route serve it.",
          );
        }
        return { ...page, file: twin };
      }),
    );
    for (const page of batch) if (page) pages.push(page);
  }
  if (missing.length > 0) {
    const message =
      `${missing.length} page${missing.length === 1 ? " has" : "s have"} no Markdown file in the output (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}), so search can't index ${missing.length === 1 ? "it" : "them"}. ` +
      "The starter's src/pages/[...slug]/index.md.ts route writes them.";
    if (input.required) throw new Error(`nimbus-docs search: ${message}`);
    input.logger.warn(message);
  }
  const used = new Set(pages.map((page) => page.product));
  // A slice holds only some products; only a full build can tell one is empty.
  if (input.slice === "" && input.collections.length === input.siteCollections.length) {
    for (const id of new Set(table.products.map((product) => product.id))) {
      if (!used.has(id)) input.logger.warn(`products.${id} matches no page; check its section and API mount names.`);
    }
  }
  const corpus: SearchCorpusManifest = {
    format: SEARCH_CORPUS_FORMAT,
    site: input.site,
    base: input.base,
    slice: input.slice,
    collections: [...input.collections].sort(),
    siteCollections: [...input.siteCollections].sort(),
    versions: table.pairs
      .filter((pair) => !pair.hidden)
      .map(({ unit, id, label, hash, deprecated }) => ({ unit, id, label, hash, deprecated })),
    products: [...new Set(table.products.map((product) => product.id))].sort(),
    pages,
  };
  const target = path.join(input.sliceDir, SEARCH_CORPUS_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(corpus)}\n`, "utf8");
  if (input.required)
    input.logger.info(
      `search corpus: ${pages.filter((page) => page.searchable).length} searchable pages in ${path.relative(outDir, target) || SEARCH_CORPUS_PATH}`,
    );
}
