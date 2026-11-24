import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ApiSidebarMode } from "../types.js";
import type { ApiNav } from "./api/api-view-types.js";
import { invocation } from "../cli/pm.js";
import { walkFilesSync } from "./fs-walk.js";
import { runningNimbusVersion } from "./upgrades.js";

/** One API version's navigation and how its sidebar is bounded. */
export interface NavBuildInput {
  nav: ApiNav;
  sidebar: ApiSidebarMode;
  mountPath: string;
}

/**
 * Identifies what a build's sidebar rows are made from, so the sidebar's
 * session cache drops rows cached from an older deployment. Rows come from
 * each API's navigation (labels, links, methods, structure), the site's
 * components and the helpers they use (`src/lib`, such as `cn`), and Nimbus
 * itself. Spec edits that leave the navigation alone, such as descriptions,
 * schemas, or examples, keep the id, so they change only the pages they
 * appear on.
 */
export function navBuildId(
  navs: readonly NavBuildInput[],
  srcDir: string,
  base: string,
  externalizedIndexes?: unknown,
): string {
  const hash = createHash("sha256");
  const add = (value: string | Buffer) => hash.update(value).update("\0");
  add(runningNimbusVersion());
  add(base);
  if (externalizedIndexes) add(JSON.stringify(externalizedIndexes));
  for (const { nav, sidebar, mountPath } of navs) {
    add(JSON.stringify({ sidebar, mountPath, nav }));
  }
  for (const dir of ["components", "lib"]) {
    const files = [...walkFilesSync(path.join(srcDir, dir), { onReadError: "lenient" })].sort((a, b) =>
      a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
    );
    for (const file of files) {
      add(`${dir}/${file.rel}`);
      add(fs.readFileSync(file.abs));
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * `sidebar: "on-demand"` relies on two starter components: `ApiSidebarItem`
 * renders collapsed groups as loadable, and `ApiSidebarPanel` mounts the
 * loader. With the starter's older copies, collapsed groups never open and
 * page-less categories link nowhere, so the integration fails the build with
 * this message. Only the starter's own outdated shapes are recognised: a
 * layout the site rewrote (its own panel, a wrapper around the panel, the
 * sidebar rendered elsewhere) is the site's, and so is its loader. Sites that
 * replaced these components (no file at the starter's path) are not checked.
 */
export function outdatedApiSidebarError(
  api: readonly { collection: string; sidebar?: string }[],
  srcDir: string,
  projectRoot: string,
): string | undefined {
  const onDemand = api.filter((entry) => entry.sidebar === "on-demand");
  if (onDemand.length === 0) return undefined;
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(srcDir, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const outdated: string[] = [];
  const item = "components/ui/api-sidebar/ApiSidebarItem.astro";
  const itemSource = read(item);
  if (itemSource !== undefined && !itemSource.includes("childrenHref")) outdated.push(item);
  const layout = "components/ui/api-layout/ApiLayout.astro";
  const layoutSource = read(layout);
  if (layoutSource !== undefined && isPreOnDemandLayout(layoutSource)) outdated.push(layout);
  if (outdated.length === 0) return undefined;
  const collections = onDemand.map((e) => `"${e.collection}"`).join(", ");
  return (
    `nimbus-docs: \`sidebar: "on-demand"\` (${collections}) needs newer API components. ` +
    `${outdated.map((f) => `src/${f}`).join(" and ")} ${outdated.length === 1 ? "predates" : "predate"} it, ` +
    `so collapsed groups would not open and x-tagGroups categories would link nowhere. ` +
    `Run \`${invocation("add api-layout", projectRoot)}\` and choose Overwrite for api-layout and api-sidebar ` +
    `(Skip keeps your edits to the other components), or remove \`sidebar: "on-demand"\`. ` +
    `If it warns that the registry is older than this project, the new components aren't published yet; ` +
    `keep \`sidebar: "full"\` until they are.`
  );
}

// The starter's layout before on-demand sidebars imported the plain tree from
// the api-sidebar barrel and rendered `<ApiSidebar items={nav.items} />`; the
// current one renders `ApiSidebarPanel`, which mounts the loader. Only that
// historical shape is flagged, by its own two lines: the singleton import (an
// alias or a longer specifier list is a site's edit) and the invocation, with
// no panel tag anywhere in the file.
const OLD_SIDEBAR_IMPORT = /^\s*import\s*\{\s*ApiSidebar\s*\}\s*from\s*["']@\/components\/ui\/api-sidebar["']/m;
function isPreOnDemandLayout(source: string): boolean {
  return OLD_SIDEBAR_IMPORT.test(source) && source.includes("<ApiSidebar items={") && !/<ApiSidebarPanel[\s/>]/.test(source);
}
