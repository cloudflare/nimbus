/**
 * Vite plugin: exposes icon collections via `virtual:nimbus/icons`.
 *
 * Replaces `astro-icon`'s virtual module with a deterministic, cache-stable
 * alternative. The key difference: no `lastModified` timestamp is emitted
 * into the virtual module content, so Astro's incremental build cache
 * treats the module as stable across builds (the icon SVGs themselves
 * are the cache key, not a generated timestamp).
 *
 * Consumers:
 *
 *   import icons, { config } from "virtual:nimbus/icons";
 *
 * `icons` is a record of `{ [prefix]: IconifyCollection }`.
 * `config.include` mirrors the include config for type-checking.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getIcons } from "@iconify/utils";
import { loadCollectionFromFS } from "@iconify/utils/lib/loader/fs";
import {
  cleanupSVG,
  importDirectory,
  isEmptyColor,
  parseColors,
  runSVGO,
} from "@iconify/tools";
import type { IconifyJSON } from "@iconify/types";

const VIRTUAL_ID = "virtual:nimbus/icons";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export interface IconPluginOptions {
  /** Directory containing local SVG icons. Defaults to `src/icons`. */
  iconDir?: string;
  /**
   * Explicit iconify collections to include. When omitted, auto-detects
   * `@iconify-json/*` packages from the consumer's `package.json` and
   * includes all icons from each.
   */
  include?: Record<string, string[]>;
  /** SVGO plugin config. Defaults to `["preset-default"]`. */
  svgoOptions?: { plugins?: unknown[] };
}

export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post" | "normal";
  resolveId(id: string): string | undefined;
  load(id: string): Promise<string | undefined> | string | undefined;
  configureServer?(server: {
    watcher: { add: (p: string) => void; on: (e: string, cb: (e: string, p: string) => void) => void };
    moduleGraph: { invalidateAll: () => void };
  }): void;
}

export function iconVirtualPlugin(
  opts: IconPluginOptions & { root: string },
): VitePluginLike {
  const { root, iconDir = "src/icons", include, svgoOptions } = opts;
  const resolvedIconDir = resolve(root, iconDir);
  const svgoPlugins = svgoOptions?.plugins ?? ["preset-default"];

  let collections: Record<string, IconifyJSON> | null = null;

  async function loadAll(): Promise<Record<string, IconifyJSON>> {
    const result: Record<string, IconifyJSON> = {};

    // Load iconify collections (auto-detect or explicit)
    const collectionsToLoad = include ?? (await detectInstalledCollections(root));
    for (const [name, icons] of Object.entries(collectionsToLoad)) {
      const collection = await loadCollection(name, root);
      if (!collection) {
        console.error(
          `[nimbus-icons] "${name}" does not appear to be a valid iconify collection! Did you install the "@iconify-json/${name}" dependency?`,
        );
        continue;
      }
      if (icons.length === 1 && icons[0] === "*") {
        result[name] = collection;
      } else {
        const reduced = getIcons(collection, [...new Set(icons)]);
        if (!reduced) {
          console.error(`[nimbus-icons] "${name}" failed to load the specified icons!`);
          continue;
        }
        result[name] = reduced as unknown as IconifyJSON;
      }
    }

    // Load local icons from src/icons/*.svg
    try {
      const local = await loadLocalCollection(resolvedIconDir, svgoPlugins);
      if (local && Object.keys(local.icons).length > 0) {
        result["local"] = local;
      }
    } catch {
      // No local icons directory — fine.
    }

    return result;
  }

  return {
    name: "nimbus-docs:virtual-icons",
    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    async load(id: string) {
      if (id === RESOLVED_ID) {
        if (!collections) {
          collections = await loadAll();
        }
        // No `lastModified` — this is the whole point. The module content
        // is deterministic across builds so the incremental cache is stable.
        return (
          `export default ${JSON.stringify(collections)};\n` +
          `export const config = ${JSON.stringify({ include: include ?? {} })};\n`
        );
      }
      return undefined;
    },
    configureServer({ watcher, moduleGraph }) {
      watcher.add(`${iconDir}/**/*.svg`);
      watcher.on("all", async (_event, filepath) => {
        if (!filepath.endsWith(".svg")) return;
        if (!filepath.startsWith(resolvedIconDir)) return;
        collections = null;
        moduleGraph.invalidateAll();
      });
    },
  };
}

/** Resolve from the site root, not the process's working directory: a build
 * started elsewhere (`astro build --root`, a programmatic build) must still
 * find the site's own `@iconify-json/*` packages. */
async function loadCollection(
  name: string,
  root: string,
): Promise<IconifyJSON | undefined> {
  if (!name) return undefined;
  return loadCollectionFromFS(name, false, "@iconify-json", root) as Promise<
    IconifyJSON | undefined
  >;
}

async function detectInstalledCollections(
  root: string,
): Promise<Record<string, string[]>> {
  try {
    const pkgPath = new URL("./package.json", new URL(`file://${root}/`));
    const text = await readFile(pkgPath, "utf8");
    const { dependencies = {}, devDependencies = {} } = JSON.parse(text);
    const names = [
      ...Object.keys(dependencies),
      ...Object.keys(devDependencies),
    ]
      .filter((n) => n.startsWith("@iconify-json/"))
      .map((n) => n.replace("@iconify-json/", ""));
    const result: Record<string, string[]> = {};
    for (const name of names) result[name] = ["*"];
    return result;
  } catch {
    return {};
  }
}

async function loadLocalCollection(
  dir: string,
  svgoPlugins: unknown[],
): Promise<IconifyJSON | null> {
  const local = await importDirectory(dir, {
    prefix: "local",
    keepTitles: true,
    includeSubDirs: true,
    ignoreImportErrors: "warn",
    keyword: (file) => file.subdir + file.file,
  });

  await local.forEach(async (name, type) => {
    if (type !== "icon") return;
    const svg = local.toSVG(name);
    if (svg === null) {
      local.remove(name);
      return;
    }
    try {
      cleanupSVG(svg, { keepTitles: true });
      if (await isMonochrome(svg)) {
        await convertToCurrentColor(svg);
      }
      runSVGO(svg, { plugins: svgoPlugins as never });
    } catch {
      local.remove(name);
      return;
    }
    local.fromSVG(name, svg);
  });

  const collection = local.export(true) as IconifyJSON;
  // Deliberately delete lastModified — this is the fix for the
  // incremental build cache instability that motivated this module.
  delete (collection as unknown as Record<string, unknown>).lastModified;
  return collection;
}

async function convertToCurrentColor(svg: Parameters<typeof parseColors>[0]) {
  await parseColors(svg, {
    defaultColor: "currentColor",
    callback: (_, colorStr, color) => {
      return color === null || isEmptyColor(color) || isWhite(color)
        ? colorStr
        : "currentColor";
    },
  });
}

async function isMonochrome(svg: Parameters<typeof parseColors>[0]) {
  let monochrome = true;
  await parseColors(svg, {
    defaultColor: "currentColor",
    callback: (_, colorStr, color) => {
      if (!monochrome) return colorStr;
      monochrome =
        !color || isEmptyColor(color) || isWhite(color) || isBlack(color);
      return colorStr;
    },
  });
  return monochrome;
}

function isBlack(color: { type: string; r?: number; g?: number; b?: number }) {
  return color.type === "rgb" && color.r === 0 && color.r === color.g && color.g === color.b;
}

function isWhite(color: { type: string; r?: number; g?: number; b?: number }) {
  return color.type === "rgb" && color.r === 255 && color.r === color.g && color.g === color.b;
}
