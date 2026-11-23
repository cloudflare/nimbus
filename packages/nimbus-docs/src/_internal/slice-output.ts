/**
 * The output of a partial build without the root collection (`NIMBUS_BUILD_ONLY`,
 * `build-slice.ts`): what it removes from the asset root, and how its sitemap
 * moves under its prefix. The slice's Worker answers only its prefix's zone
 * routes, so a file at the root is one it can never serve; the root slice
 * writes its own.
 */

import fs from "node:fs";
import path from "node:path";

import { STARTER_ROOT_ROUTES } from "./build-slice.js";

/**
 * Root files Nimbus writes for the whole site; a non-root slice has no use
 * for them. Named one by one: a site's own `public/.well-known/` files stay.
 */
export const NIMBUS_ROOT_FILES: readonly string[] = [
  "/llms.txt",
  "/llms-full.txt",
  "/index.md",
  "/.well-known/ard.json",
  "/.well-known/ai-catalog.json",
  "/.well-known/api-catalog",
];

/** Every route key a non-root slice leaves out of its output and sitemap. */
export function droppedRootRoutes(): string[] {
  return [...STARTER_ROOT_ROUTES, ...NIMBUS_ROOT_FILES];
}

function outputFile(distDir: string, route: string): string {
  const segments = route.split("/").filter(Boolean);
  if (route.endsWith("/")) segments.push("index.html");
  return path.join(distDir, ...segments);
}

/**
 * Delete the root artifacts from a non-root slice's output. Returns the
 * routes whose file existed. Parent directories left empty go too.
 */
export function removeRootArtifacts(distDir: string): string[] {
  const removed: string[] = [];
  for (const route of droppedRootRoutes()) {
    const file = outputFile(distDir, route);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(route);
    let dir = path.dirname(file);
    while (dir !== distDir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }
  // The request-route inventory leaves its directory behind once read.
  const nimbusDir = path.join(distDir, "_nimbus");
  if (fs.existsSync(nimbusDir) && fs.readdirSync(nimbusDir).length === 0) fs.rmdirSync(nimbusDir);
  return removed;
}

const SITEMAP_FILE = /^sitemap-(?:index|\d+)\.xml$/u;

/** A path as a sitemap `<loc>` holds it: URL-escaped where a path can't
 * hold the character as is (`#`, `?`, spaces, controls, non-ASCII; existing
 * `%XX` kept), then entity-escaped, as the sitemap protocol asks. */
function locPath(path: string): string {
  return path
    .replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu, (c) =>
      [...new TextEncoder().encode(c)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
    )
    .replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** A sitemap index whose file entries point under the prefix. */
export function sitemapIndexUnderPrefix(xml: string, prefix: string): string {
  return xml.replace(
    /<loc>([^<]*?)\/(sitemap-\d+\.xml)<\/loc>/gu,
    (_match, origin: string, file: string) => `<loc>${origin}${locPath(prefix)}/${file}</loc>`,
  );
}

/**
 * Move `@astrojs/sitemap`'s files from the output root under the prefix,
 * rewriting the index's entries. Returns the moved files' routes.
 */
export function relocateSitemap(outDir: string, prefix: string): string[] {
  const files = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((name) => SITEMAP_FILE.test(name))
    : [];
  if (files.length === 0) return [];
  const target = path.join(outDir, ...prefix.split("/").filter(Boolean));
  fs.mkdirSync(target, { recursive: true });
  const moved: string[] = [];
  for (const name of files) {
    const source = path.join(outDir, name);
    const destination = path.join(target, name);
    if (name === "sitemap-index.xml") {
      fs.writeFileSync(
        destination,
        sitemapIndexUnderPrefix(fs.readFileSync(source, "utf8"), prefix),
        "utf8",
      );
      fs.rmSync(source, { force: true });
    } else {
      fs.renameSync(source, destination);
    }
    moved.push(`${prefix}/${name}`);
  }
  return moved;
}
