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
  const pages = path.join(options.srcDir, "pages");
  const candidates: Array<[string, string[]]> = [
    ...[...ENDPOINT_EXTENSIONS, ...PAGE_EXTENSIONS].flatMap((ext): Array<[string, string[]]> => [
      [pages, ["nimbus-api", `coordinates.json${ext}`]],
      [pages, ["nimbus-api", "coordinates.json", `index${ext}`]],
    ]),
    [options.publicDir, ["nimbus-api", "coordinates.json"]],
  ];
  const found = candidates.find(([root, segments]) => isExactFile(root, segments));
  if (found) return path.relative(options.projectRoot, path.join(found[0], ...found[1])).replaceAll("\\", "/");
  const redirect = Object.keys(options.redirects ?? {}).find(
    (source) => source.replace(/\/+$/, "") === COORDINATES_PATH,
  );
  return redirect ? `redirects["${redirect}"] in astro.config` : undefined;
}

/**
 * Whether `root/segments…` is a file spelled exactly so. Astro and hosts match
 * names by case, so on a case-insensitive disk `Coordinates.json.ts` exists
 * but doesn't serve the path.
 */
function isExactFile(root: string, segments: string[]): boolean {
  let dir = root;
  for (const [i, segment] of segments.entries()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false;
    }
    if (!names.includes(segment)) return false;
    dir = path.join(dir, segment);
    if (i === segments.length - 1) return fs.statSync(dir, { throwIfNoEntry: false })?.isFile() ?? false;
  }
  return false;
}

/** The folders whose changes can start or stop owning the manifest's path. */
export function coordinatesOwnerDirs(srcDir: string, publicDir: string): string[] {
  return [path.join(srcDir, "pages", "nimbus-api"), path.join(publicDir, "nimbus-api")];
}

/** Whether a changed file could start or stop owning the manifest's path. */
export function isCoordinatesOwnerPath(file: string, srcDir: string, publicDir: string): boolean {
  const normalized = path.resolve(file).toLowerCase();
  return coordinatesOwnerDirs(srcDir, publicDir).some((dir) => normalized.startsWith(dir.toLowerCase()));
}
