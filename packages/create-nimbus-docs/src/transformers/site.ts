import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix } from "node:path";
import { parse } from "yaml";
import {
  SITE_PARTS_DIR,
  composeSiteFiles,
  readSiteParts,
  type SiteRecord,
} from "@cloudflare/nimbus-docs/site-parts";
import { ASTRO_CONFIG_FILENAMES } from "@cloudflare/nimbus-docs/adapters";
import { ScaffoldError } from "../scaffold.js";

/** The parts a new site has: what's at the root, and the API with its spec (null: the sample). */
export interface SiteChoice {
  template: "docs" | "api";
  api: false | { spec: string | null };
}

/** What `nimbus.json` records for the parts: the site, and the registry components installed for it. */
export interface SiteResult {
  site: SiteRecord | null;
  components: Array<{
    slug: string;
    type: string;
    version: string;
    source: string;
    hash: string;
    files: string[];
  }>;
}

/**
 * Give a fetched template the site's parts, from the template's own
 * `.nimbus-parts/`: the API's route, config and content line (composed as
 * `outdated` composes them), its spec, its registry components and their
 * peers. The payload directory never stays in the site.
 */
export function applySite(target: string, choice: SiteChoice, registry: string): SiteResult {
  try {
    if (!choice.api) return { site: null, components: [] };
    const manifest = readSiteParts(target);
    if (!manifest) {
      throw new ScaffoldError(
        "This template has no API reference part. Scaffold with a matching create-nimbus-docs, or leave out --api and --template api.",
      );
    }
    const { spec: sample } = manifest.api;
    const own = choice.api.spec;
    const ext = own ? extname(own).toLowerCase() : extname(sample.to);
    const spec = `${sample.to.slice(0, -extname(sample.to).length)}${ext}`;
    const site: SiteRecord = { template: choice.template, api: { spec } };
    composeSiteFiles(target, site);

    // A copy of its own, even when the spec given is a symlink.
    mkdirSync(dirname(join(target, spec)), { recursive: true });
    copyFileSync(own ?? join(target, SITE_PARTS_DIR, sample.from), join(target, spec));

    for (const component of manifest.api.components) {
      for (const file of component.files) cpSync(join(target, SITE_PARTS_DIR, file), join(target, "src", file));
    }

    const pkgPath = join(target, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
    pkg.dependencies = { ...pkg.dependencies, ...manifest.api.dependencies };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    return {
      site,
      components: manifest.api.components.map((component) => ({
        slug: component.slug,
        type: component.type,
        version: component.version,
        source: registry,
        hash: component.hash,
        files: component.files.map((file) => posix.join("src", file)),
      })),
    };
  } finally {
    rmSync(join(target, SITE_PARTS_DIR), { recursive: true, force: true });
  }
}

/**
 * Name an API-only site after its spec: the starter's `title` (and
 * `description`) in the Astro config become the spec's `info.title` (and the
 * first paragraph of `info.description`). `false` when the spec has a title
 * but the config's line wasn't found, so the caller can say so.
 */
export function nameSiteFromSpec(target: string, spec: string): boolean {
  let info: Record<string, unknown> = {};
  try {
    const doc = parse(readFileSync(join(target, spec), "utf8"), { merge: true }) as { info?: unknown } | null;
    if (doc && typeof doc.info === "object" && doc.info !== null) info = doc.info as Record<string, unknown>;
  } catch {
    return true;
  }
  const title = typeof info.title === "string" ? info.title.trim() : "";
  if (!title) return true;
  const file = ASTRO_CONFIG_FILENAMES.map((name) => join(target, name)).find((path) => existsSync(path));
  if (!file) return false;
  const source = readFileSync(file, "utf8");
  const line = /^(\s*)title: "Nimbus",$/m;
  if (!line.test(source)) return false;
  let next = source.replace(line, (_, indent: string) => `${indent}title: ${JSON.stringify(title)},`);
  const description =
    typeof info.description === "string" ? info.description.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ") : "";
  if (description) {
    next = next.replace(/^(\s*)description: "[^"\n]*",$/m, (_, indent: string) => `${indent}description: ${JSON.stringify(description)},`);
  }
  writeFileSync(file, next);
  return true;
}

/**
 * Why `value` isn't a spec `--api` can copy, worded to follow the file's name,
 * or undefined when it is: an existing .yaml, .yml or .json that declares
 * OpenAPI 3.x at its top level. The build validates the rest.
 */
export function specProblem(value: string): string | undefined {
  if (![".yaml", ".yml", ".json"].includes(extname(value).toLowerCase())) return "isn't a .yaml, .yml or .json file";
  if (!existsSync(value) || !statSync(value).isFile()) return "doesn't exist";
  let doc: unknown;
  try {
    // JSON is YAML too; merge keys resolve as the build's parser resolves them.
    doc = parse(readFileSync(value, "utf8"), { merge: true });
  } catch {
    return "isn't valid YAML or JSON";
  }
  const root = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  if (root.swagger !== undefined) return "is Swagger 2.0; convert it to OpenAPI 3.x first";
  if (!/^3(\.|$)/.test(String(root.openapi ?? ""))) return "isn't an OpenAPI 3.x document: it has no top-level openapi: 3.x";
  return undefined;
}
