import type { AgentCapabilities } from "../types.js";
import type { AgentDiscoveryOptions } from "./agent-discovery.js";
import type { ViteDevServer } from "vite";
import type { VitePluginLike } from "./virtual-config.js";
import { agentDiscoveryManifest } from "./agent-discovery.js";
import {
  API_CATALOG_MEDIA_TYPE,
  API_CATALOG_PATH,
  apiCatalog,
  apiCatalogLink,
} from "./agent-api-catalog.js";
import { withBase } from "./url.js";
import { AGENT_CAPABILITIES_VIRTUAL_ID } from "./dev-invalidation.js";
import { AGENT_SKILLS_PATH } from "./agent-skills.js";
import type { AgentSkillsPublication } from "./agent-skills.js";
export function virtualAgentCapabilitiesPlugin(
  get: () => Promise<{
    capabilities: AgentCapabilities;
    options: AgentDiscoveryOptions;
    specFiles?: { file: string; type: string; contents: string }[];
    specWarnings?: string[];
    skills?: AgentSkillsPublication;
  }>,
): Omit<VitePluginLike, "load"> & {
  load(source: string): Promise<string | undefined>;
  configureServer(server: Pick<ViteDevServer, "middlewares">): void;
} {
  const id = AGENT_CAPABILITIES_VIRTUAL_ID;
  return {
    name: "nimbus-docs:agent-capabilities",
    configureServer(server) {
      // Runs before Vite's base middleware: well-known discovery belongs to
      // the origin, including when the documentation lives under /docs/.
      const warned = new Set<string>();
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://nimbus.local")
          .pathname;
        const method = request.method ?? "";
        if (!["GET", "HEAD"].includes(method)) return next();
        if (pathname === API_CATALOG_PATH) {
          void get()
            .then(({ capabilities, options }) => {
              const catalog = options.discovery === false ? undefined : apiCatalog(capabilities);
              if (!catalog) return next();
              response.setHeader("Content-Type", API_CATALOG_MEDIA_TYPE);
              response.setHeader("Access-Control-Allow-Origin", "*");
              response.setHeader("Link", apiCatalogLink(options.site));
              response.end(
                method === "HEAD" ? undefined : JSON.stringify(catalog, null, 2) + "\n",
              );
            })
            .catch(next);
          return;
        }
        if (pathname.startsWith(`${AGENT_SKILLS_PATH}/`)) {
          void get()
            .then(({ skills }) => {
              for (const warning of skills?.warnings ?? []) {
                if (warned.has(warning)) continue;
                warned.add(warning);
                console.warn(warning);
              }
              // Not ours: let Astro serve public/ files or its own 404.
              const artifact = skills?.artifacts.find(
                (item) => item.pathname === pathname,
              );
              if (!artifact) return next();
              response.setHeader("Content-Type", artifact.type);
              response.setHeader("Content-Length", artifact.bytes.length);
              response.setHeader("Access-Control-Allow-Origin", "*");
              response.end(method === "HEAD" ? undefined : artifact.bytes);
            })
            .catch(next);
          return;
        }
        if (["/.well-known/ard.json", "/.well-known/ai-catalog.json"].includes(pathname)) {
          void get()
            .then(({ capabilities, options }) => {
              // Off: Vite serves the site's own public/.well-known file, or 404s.
              if (options.discovery === false) return next();
              response.setHeader("Content-Type", "application/json");
              response.setHeader("Access-Control-Allow-Origin", "*");
              response.end(
                method === "HEAD"
                  ? undefined
                  : JSON.stringify(
                      agentDiscoveryManifest(capabilities, options),
                      null,
                      2,
                    ) + "\n",
              );
            })
            .catch(next);
          return;
        }
        void get()
          .then(({ capabilities, options, specFiles, specWarnings }) => {
            for (const warning of specWarnings ?? []) {
              if (warned.has(warning)) continue;
              warned.add(warning);
              console.warn(warning);
            }
            // Astro's base middleware has already stripped the base.
            const spec = specFiles?.find(
              (item) => pathname === item.file || pathname === withBase(item.file, options.base),
            );
            if (!spec) {
              // Astro carries dev-server request locals into its middleware.
              const key = Symbol.for("astro.locals");
              const locals = Reflect.get(request, key) ?? {};
              Reflect.set(locals, Symbol.for("nimbus.agent-capabilities"), capabilities);
              Reflect.set(request, key, locals);
              return next();
            }
            response.setHeader("Content-Type", spec.type);
            response.setHeader("Access-Control-Allow-Origin", "*");
            response.end(method === "HEAD" ? undefined : spec.contents);
          })
          .catch(next);
      });
    },
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(source) {
      if (source !== `\0${id}`) return undefined;
      const { capabilities, options } = await get();
      return `export const capabilities = ${JSON.stringify(capabilities)};\nexport const options = ${JSON.stringify(options)};\n`;
    },
  };
}
