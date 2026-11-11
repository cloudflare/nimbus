/**
 * The page index the remote MCP server lists from: one record per page
 * that has a Markdown twin, baked with the agent-endpoint assets when
 * `agents.mcp` is on and read at request time through the staged-asset
 * reader, so the server bundle never carries the content store. Hidden versions
 * and drafts are not in it at all.
 */
export const MCP_PAGE_INDEX_VERSION = 1;

export interface McpPageRecord {
  title: string;
  description?: string;
  /** Absolute page URL, as search returns it. */
  url: string;
  /** Absolute URL of the page's Markdown twin, when a route of the site serves it. */
  markdownUrl?: string;
  /** Site-relative Markdown path without the base; the Markdown asset's `url`. */
  markdownPath: string;
  /** The `llms.txt` section this page belongs to (its top-level slug). */
  section: string;
  /** The docs version the page belongs to; API and other pages have none. */
  version?: string;
  deprecated?: true;
  /** Site search's rule: `searchable: true`, or neither `searchable: false` nor `noindex`. */
  searchable: boolean;
}

export interface McpPageIndex {
  version: typeof MCP_PAGE_INDEX_VERSION;
  /** Every listable docs version label, current first; hidden ones are absent. */
  versions: string[];
  pages: McpPageRecord[];
}
