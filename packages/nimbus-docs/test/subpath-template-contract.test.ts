import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function source(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("framework and starter-owned navigation apply Astro's base path", () => {
  const head = source("packages/nimbus-docs/src/components/NimbusHead.astro");
  assert.match(
    head,
    /const faviconHref = withBase\(headDefaults\.favicon\.file, baseUrl\);/,
  );
  assert.match(head, /withBase\("\/_nimbus\/shiki\.css", baseUrl\)/);

  const starterRoot = "packages/nimbus-starter-source/src";
  const header = source(`${starterRoot}/components/Header.astro`);
  assert.match(
    header,
    /const homeHref = withBase\("\/", import\.meta\.env\.BASE_URL\);/,
  );
  assert.match(header, /href=\{homeHref\}/);
  assert.match(
    header,
    /href=\{withBase\(section\.href, import\.meta\.env\.BASE_URL\)\}/,
  );

  const sidebarLink = source(
    `${starterRoot}/components/ui/sidebar/SidebarLink.astro`,
  );
  assert.match(
    sidebarLink,
    /const hrefWithBase = withBase\(href, import\.meta\.env\.BASE_URL\);/,
  );
  assert.match(sidebarLink, /href=\{hrefWithBase\}/);

  const breadcrumbs = source(
    `${starterRoot}/components/ui/breadcrumbs/Breadcrumbs.astro`,
  );
  assert.match(breadcrumbs, /href=\{hrefWithBase\(crumb\.href\)\}/);

  const pagination = source(
    `${starterRoot}/components/ui/pagination/Pagination.astro`,
  );
  assert.match(
    pagination,
    /const prevHref = prev && withBase\(prev\.href, import\.meta\.env\.BASE_URL\);/,
  );
  assert.match(
    pagination,
    /const nextHref = next && withBase\(next\.href, import\.meta\.env\.BASE_URL\);/,
  );

  assert.match(
    source(`${starterRoot}/layouts/DocsLayout.astro`),
    /const homeHref = withBase\("\/", import\.meta\.env\.BASE_URL\);/,
  );
  assert.match(
    source(`${starterRoot}/pages/404.astro`),
    /const homeHref = withBase\("\/", import\.meta\.env\.BASE_URL\);/,
  );
});
