import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { validateStagedAssetPath } from "./staged-asset-reader.js";

const ID = "virtual:nimbus/staged-asset-loader";
const RESOLVED = `\0${ID}`;
const CLIENT_ROOT = "__NIMBUS_DEPLOYED_CLIENT_ROOT__";
export interface StagedAssetPluginOptions {
  root: URL | string;
  base: string;
  adapterName: () => string | null;
  clientDirectory: () => URL | string;
  serverDirectory: () => URL | string;
  isDev: () => boolean;
}
function fsPath(value: URL | string): string {
  return value instanceof URL ? fileURLToPath(value) : path.resolve(value);
}
function stagedPath(root: string, asset: string): string {
  validateStagedAssetPath(asset);
  if (!asset.startsWith("_nimbus/"))
    throw new Error("nimbus-docs: asset is outside the staged namespace.");
  return path.join(root, ".astro", "nimbus", asset.slice("_nimbus/".length));
}
/** The same transport is used by page records and agent endpoint files. */
export function stagedAssetPlugin(options: StagedAssetPluginOptions): Plugin {
  const root = fsPath(options.root);
  let server: ViteDevServer | undefined;
  function devOrigin(): string {
    const address = server?.httpServer?.address();
    const port =
      typeof address === "object" && address
        ? address.port
        : (server?.config.server.port ?? 5173);
    return (
      server?.resolvedUrls?.local[0] ??
      `${server?.config.server.https ? "https" : "http"}://localhost:${port}/`
    );
  }
  return {
    name: "nimbus-docs:staged-assets",
    enforce: "pre",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    configureServer(instance) {
      server = instance;
      instance.middlewares.use(async (request, response, next) => {
        let pathname: string;
        try {
          pathname = new URL(request.url ?? "/", "http://nimbus.invalid")
            .pathname;
        } catch {
          return next();
        }
        const prefix = `${options.base.replace(/\/$/, "")}/_nimbus/`;
        if (!pathname.startsWith(prefix)) return next();
        const asset = `_nimbus/${pathname.slice(prefix.length)}`;
        if (
          !asset.startsWith("_nimbus/pages/") &&
          !asset.startsWith("_nimbus/agent-endpoint-assets/")
        )
          return next();
        try {
          const body = await readFile(stagedPath(root, asset));
          response.setHeader("Cache-Control", "no-store");
          response.setHeader(
            "Content-Type",
            asset.endsWith(".json")
              ? "application/json"
              : "text/plain; charset=utf-8",
          );
          response.statusCode = 200;
          response.end(request.method === "HEAD" ? undefined : body);
        } catch (error) {
          response.statusCode =
            (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
          response.end("Staged asset unavailable");
        }
      });
      instance.httpServer?.once("listening", () => {
        for (const environment of Object.values(instance.environments)) {
          const module = environment.moduleGraph.getModuleById(RESOLVED);
          if (module) environment.moduleGraph.invalidateModule(module);
        }
      });
    },
    load(id) {
      if (id !== RESOLVED) return;
      const base = `export const base = ${JSON.stringify(options.base)};\n`;
      const worker =
        options.adapterName() === "@astrojs/cloudflare" &&
        (this.environment.name === "ssr" ||
          this.environment.config?.resolve?.conditions?.includes("workerd"));
      const nodePrerender = this.environment.name === "prerender" && !worker;
      if (worker && options.isDev()) {
        return (
          base +
          `export function fetchStagedAsset(path) { return fetch(new URL(path, ${JSON.stringify(devOrigin())}), {redirect: "manual"}); }\n` +
          "export async function readStagedAssetFile() { return null; }\n"
        );
      }
      if (worker) {
        return (
          base +
          'import { env } from "cloudflare:workers";\n' +
          "export function fetchStagedAsset(path, request) { return env.ASSETS?.fetch(new Request(new URL(path, request.url), {method: 'GET'})) ?? null; }\n" +
          "export async function readStagedAssetFile() { return null; }\n"
        );
      }
      if (
        !options.isDev() &&
        !nodePrerender &&
        options.adapterName() &&
        options.adapterName() !== "@astrojs/node"
      ) {
        // Other adapters may run where the build ran (a self-hosted server) or
        // anywhere else. Try the staging directory through a guarded dynamic
        // import, as 0.17 did, then fall back to the same-origin fetch.
        return (
          base +
          "export function fetchStagedAsset() { return null; }\n" +
          `const root = ${JSON.stringify(path.join(root, ".astro", "nimbus"))};\n` +
          "export async function readStagedAssetFile(asset) {\n" +
          "  try {\n" +
          '    const [{ readFile }, { join }] = await Promise.all([import("node:fs/promises"), import("node:path")]);\n' +
          "    return await readFile(join(root, asset.slice('_nimbus/'.length)), 'utf8');\n" +
          "  } catch { return null; }\n" +
          "}\n"
        );
      }
      // Prerender-only builds/dev use staging. Server builds use only deployed output.
      const rootExpression =
        options.isDev() || nodePrerender || !options.adapterName()
          ? JSON.stringify(path.join(root, ".astro", "nimbus"))
          : `new URL(${JSON.stringify(CLIENT_ROOT)}, import.meta.url)`;
      const relativePath =
        options.isDev() || nodePrerender || !options.adapterName()
          ? "asset.slice('_nimbus/'.length)"
          : "asset";
      return (
        base +
        'import { readFile } from "node:fs/promises";\nimport { resolve } from "node:path";\nimport { fileURLToPath } from "node:url";\n' +
        "export function fetchStagedAsset() { return null; }\n" +
        `const root = ${rootExpression};\n` +
        // A server deployed apart from its client files falls back to the
        // same-origin fetch, as 0.17 did; a truly missing file still fails there.
        `export async function readStagedAssetFile(asset) {\n` +
        `  try { return await readFile(resolve(typeof root === 'string' ? root : fileURLToPath(root), ${relativePath}), 'utf8'); }\n` +
        "  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }\n" +
        "}\n"
      );
    },
    renderChunk(code, chunk, outputOptions) {
      if (!code.includes(CLIENT_ROOT)) return;
      const outputDirectory =
        outputOptions?.dir ?? fsPath(options.serverDirectory());
      const directory = path.dirname(
        path.join(path.resolve(outputDirectory), chunk.fileName),
      );
      let relative = path
        .relative(directory, fsPath(options.clientDirectory()))
        .split(path.sep)
        .join("/");
      if (!relative.startsWith(".")) relative = `./${relative}`;
      return { code: code.replaceAll(CLIENT_ROOT, `${relative}/`), map: null };
    },
  };
}
