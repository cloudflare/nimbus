/**
 * The sidebar filter's list of one API version's pages, for
 * `sidebar: "on-demand"`, whose pages carry only part of the tree. Written at
 * build time beside the page assets and named by its hash, so an unchanged
 * version keeps its file.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { pageAssetDigest, writeAtomic } from "../page-assets-build.js";
import { preparedMarkdownRootKey } from "../prepared-markdown-registry.js";
import type { NavListRow } from "../../client/nav-list.js";
import type { ApiNav, ApiNavItem } from "./api-view-types.js";

/** Every page in the version's navigation, in sidebar order. */
export function apiNavList(
  nav: ApiNav,
  operationPaths: Record<string, string>,
): { filename: string; body: string } {
  const rows: NavListRow[] = [];
  const visit = (item: ApiNavItem) => {
    const path = operationPaths[item.coordinate];
    if (item.href)
      rows.push({
        title: item.label,
        ...(item.method ? { method: item.method } : {}),
        ...(path ? { path } : {}),
        url: item.href,
      });
    item.children.forEach(visit);
  };
  nav.items.forEach(visit);
  const body = JSON.stringify(rows);
  return { filename: `nav-${pageAssetDigest(body)}.json`, body };
}

// collection → version ("" when unversioned) → filename. On globalThis: the
// integration and the content loader can load separate copies of this module.
type ApiNavListManifest = Record<string, Record<string, string>>;
const REGISTRY = Symbol.for("@cloudflare/nimbus-docs/api-nav-lists/v1");
const globals = globalThis as typeof globalThis & {
  [REGISTRY]?: Map<string, ApiNavListManifest>;
};
const manifests = (globals[REGISTRY] ??= new Map());

export function recordApiNavList(
  root: URL | string,
  collection: string,
  version: string | null,
  filename: string,
): void {
  const manifest = manifests.get(preparedMarkdownRootKey(root)) ?? {};
  (manifest[collection] ??= {})[version ?? ""] = filename;
  manifests.set(preparedMarkdownRootKey(root), manifest);
}

export function getApiNavListManifest(root: URL | string): ApiNavListManifest {
  return manifests.get(preparedMarkdownRootKey(root)) ?? {};
}

export function apiNavListFiles(root: URL | string): string[] {
  return Object.values(getApiNavListManifest(root)).flatMap((versions) =>
    Object.values(versions),
  );
}

export function clearApiNavLists(root: URL | string): void {
  manifests.delete(preparedMarkdownRootKey(root));
}

/** Write a list into the page-asset staging folder, where the build deploys
 * it from and the dev server serves it. */
export async function stageApiNavList(
  root: string,
  list: { filename: string; body: string },
): Promise<void> {
  const file = path.join(root, ".astro/nimbus/pages", list.filename);
  try {
    await access(file);
  } catch {
    await writeAtomic(file, list.body);
  }
}
