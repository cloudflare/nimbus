/**
 * The corpus manifest, `_nimbus/search-corpus.json`: every page with a
 * Markdown twin that discovery lists, where its content sits on disk and a
 * hash of what an indexer uploads. Any search indexer reads it; `nimbus-docs
 * search sync` is the AI Search one. `format` changes only with a major
 * Nimbus version.
 */
import { createHash } from "node:crypto";

export const SEARCH_CORPUS_FORMAT = 1;
export const SEARCH_CORPUS_PATH = "_nimbus/search-corpus.json";

export interface SearchCorpusPage {
  /** The page's own absolute URL, base included. */
  url: string;
  title: string;
  description?: string;
  collection: string;
  /** The `llms.txt` section the page belongs to. */
  section: string;
  /** The version pair hash: the value uploaded as `version` metadata. */
  version: string;
  deprecated: boolean;
  /** The product id, `site` for the default product. */
  product: string;
  /** Whether site search should index it (`searchable ?? !noindex`). */
  searchable: boolean;
  /** The twin's file, relative to the output directory. */
  file: string;
  /** UTF-8 byte range of the page inside `file`: its `# Title` line and content, without the frontmatter, the index preamble or the `Source:` line. */
  contentStart: number;
  contentEnd: number;
  /** SHA-256 hex of the content bytes followed by `JSON.stringify([url, title, version, deprecated, product])`. */
  hash: string;
  bytes: number;
}

export interface SearchCorpusManifest {
  format: typeof SEARCH_CORPUS_FORMAT;
  site: string;
  base: string;
  /** The slice prefix this build's site-wide files live under, `""` for a full build. */
  slice: string;
  /** The collections this build built. */
  collections: string[];
  /** Every configured page collection. */
  siteCollections: string[];
  versions: Array<{ unit: string; id: string; label: string; hash: string; deprecated: boolean }>;
  products: string[];
  pages: SearchCorpusPage[];
}

/** The hash an indexer reproduces from a page's content bytes and its own five metadata values. */
export function corpusHash(
  content: Uint8Array,
  page: Pick<SearchCorpusPage, "url" | "title" | "version" | "deprecated" | "product">,
): string {
  return createHash("sha256")
    .update(content)
    .update(JSON.stringify([page.url, page.title, page.version, page.deprecated, page.product]))
    .digest("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
