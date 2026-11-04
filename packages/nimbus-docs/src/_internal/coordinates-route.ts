import fs from "node:fs";
import path from "node:path";

/** Where a site publishes its coordinate manifest for `apiReferences[]`. */
export const COORDINATES_PATH = "/nimbus-api/coordinates.json";

// Astro's endpoint and page extensions (`create-manifest.js`): `.mdx` comes
// from the MDX integration Nimbus adds. Extensions other integrations register
// aren't known at setup; `coordinatesRouteCollision` catches those.
const ENDPOINT_EXTENSIONS = [".ts", ".js"];
const PAGE_EXTENSIONS = [".astro", ".md", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn", ".mdx"];

/**
 * The project file or redirect that already serves the manifest's path, or
 * `undefined` when none does and Nimbus serves it. Only an exact owner counts:
 * a catch-all such as `[...slug]` never answers a `.json` path Nimbus routes.
 */
export function coordinatesRouteOwner(options: {
  srcDir: string;
  publicDir: string;
  projectRoot: string;
  redirects?: Record<string, unknown>;
}): string | undefined {
  const base = path.join(options.srcDir, "pages", "nimbus-api", "coordinates.json");
  const files = [
    ...[...ENDPOINT_EXTENSIONS, ...PAGE_EXTENSIONS].flatMap((ext) => [`${base}${ext}`, path.join(base, `index${ext}`)]),
    path.join(options.publicDir, "nimbus-api", "coordinates.json"),
  ];
  const file = files.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (file) return path.relative(options.projectRoot, file).replaceAll("\\", "/");
  const redirect = Object.keys(options.redirects ?? {}).find(
    (source) => source.replace(/\/+$/, "") === COORDINATES_PATH,
  );
  return redirect ? `redirects["${redirect}"] in astro.config` : undefined;
}

/** Whether a changed file could start or stop owning the manifest's path. */
export function isCoordinatesOwnerPath(file: string, srcDir: string, publicDir: string): boolean {
  const normalized = path.resolve(file);
  const pages = path.join(srcDir, "pages", "nimbus-api", "coordinates.json");
  return (
    normalized === path.join(publicDir, "nimbus-api", "coordinates.json") ||
    normalized.startsWith(pages)
  );
}
