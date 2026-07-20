/**
 * Root /llms.txt — sectioned index across every indexable collection.
 *
 * The framework's `getIndexedTopLevel()` helper partitions entries into:
 *   - LEAVES — single-entry items that link directly to their `.md`
 *     alternate at root (the primary collection's flat entries).
 *   - GROUPS — multi-entry items that link to a per-section file at
 *     `/<slug>/llms.txt`. Every non-primary collection (`api`, `blog`,
 *     etc.) becomes a single group named after the collection.
 *
 * Tool authors target a single rule: if a root link ends in
 * `/llms.txt`, drill in; if it ends in `.md`, that's the content.
 *
 * Adding a new collection to `src/content.config.ts` lights up
 * `/llms.txt` automatically — no edits needed in this file.
 */

import { getIndexedTopLevel } from "nimbus-docs";
import { config } from "virtual:nimbus/config";

export const prerender = true;

export async function GET() {
  const { leaves, groups } = await getIndexedTopLevel();

  const lines = [
    `# ${config.title}`,
    "",
    config.description ?? "Documentation index for AI agents.",
    "",
    `Full corpus (all pages, one document): ${new URL("/llms-full.txt", config.site).href}`,
    "",
    "## Pages",
    "",
  ];

  type Row = { key: string; line: string };
  const rows: Row[] = [];

  for (const leaf of leaves) {
    const description = leaf.description ? ` — ${leaf.description}` : "";
    rows.push({
      key: leaf.url,
      line: `- [${leaf.title}](${new URL(leaf.markdownUrl, config.site).href})${description}`,
    });
  }

  for (const group of groups) {
    // Versioning: old docs versions get their own /<v>/llms.txt
    // (emitted by the [section] route), but they should NOT appear in
    // the ROOT index. Agents discovering the site land on /llms.txt for
    // current content; older versions are reachable via the alternate
    // links on any current page. Listing them here would pollute the
    // entry point and lead agents down deprecated paths by default.
    if (group.kind === "version") continue;
    rows.push({
      key: `/${group.slug}`,
      line: `- [${group.label}](${new URL(`/${group.slug}/llms.txt`, config.site).href})`,
    });
  }

  rows.sort((a, b) => a.key.localeCompare(b.key));
  for (const row of rows) lines.push(row.line);

  lines.push("");

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
