// Builds a throwaway Astro site against the in-repo Nimbus integration, for
// tests that need real route resolution, prerendering, and baked
// agent-endpoint assets.

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type AstroIntegration } from "astro";

import nimbus from "../../src/index.ts";
import { runningNimbusVersion } from "../../src/_internal/upgrades.ts";

export interface AgentSite {
  root: string;
  logs: string;
}

export interface AgentSiteOptions {
  conflict?: "error" | "warn" | "ignore";
  server?: boolean;
  logLevel?: "silent" | "warn";
  versions?: { current: string; others: string[] };
  api?: unknown[];
}

/** Import specifier for a package source module, usable from fixture files. */
export function srcModule(relative: string): string {
  return JSON.stringify(
    pathToFileURL(path.resolve(import.meta.dirname, "../../src", relative)).href,
  );
}

export const SMALLCO_SPEC = path.resolve(import.meta.dirname, "api/smallco.yaml");

/** A minimal on-demand adapter: Astro's generated App behind the entrypoint. */
function testAdapter(entrypoint: string): AstroIntegration {
  return {
    name: "test:adapter",
    hooks: {
      "astro:config:done": ({ setAdapter }) => {
        setAdapter({
          name: "test:adapter",
          entrypointResolution: "auto",
          serverEntrypoint: entrypoint,
          supportedAstroFeatures: { serverOutput: "stable" },
        });
      },
    },
  };
}

export function agentSites() {
  const roots: string[] = [];

  async function buildSite(
    files: Record<string, string>,
    options: AgentSiteOptions = {},
  ): Promise<AgentSite> {
    const root = await mkdtemp(path.join(os.tmpdir(), "nimbus-agent-site-"));
    roots.push(root);
    const write = async (relative: string, contents: string) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), contents, "utf8");
    };
    await write(
      "nimbus.json",
      `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`,
    );
    await symlink(
      path.resolve(import.meta.dirname, "../../node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const [relative, contents] of Object.entries(files)) {
      await write(relative, contents);
    }
    let adapter: AstroIntegration | undefined;
    if (options.server) {
      await write(
        "server-entry.mjs",
        `import { createApp } from "astro/app/entrypoint";\nexport const app = createApp();\n`,
      );
      adapter = testAdapter(path.join(root, "server-entry.mjs"));
    }

    const chunks: string[] = [];
    const streams = [process.stdout, process.stderr] as const;
    const realWrites = streams.map((stream) => stream.write);
    for (const [index, stream] of streams.entries()) {
      const realWrite = realWrites[index]!.bind(stream) as (...args: unknown[]) => boolean;
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        chunks.push(String(chunk));
        return realWrite(chunk, ...rest);
      }) as typeof stream.write;
    }
    try {
      await build({
        root: pathToFileURL(`${root}${path.sep}`),
        cacheDir: path.join(root, ".astro"),
        outDir: "./dist",
        build: { server: path.join(root, ".server"), client: path.join(root, "dist") },
        vite: { cacheDir: path.join(root, ".vite") },
        base: "/docs",
        prerenderConflictBehavior: options.conflict ?? "error",
        ...(adapter ? { output: "server" as const, adapter } : {}),
        logLevel: options.logLevel ?? "silent",
        integrations: [
          nimbus(
            {
              site: "https://example.test",
              title: "Test",
              description: "Test",
              search: false,
              ...(options.versions ? { versions: options.versions } : {}),
              ...(options.api ? { api: options.api } : {}),
            } as Parameters<typeof nimbus>[0],
            { admonitions: false, sitemap: false, validateMdx: false },
          ),
        ],
      });
    } finally {
      for (const [index, stream] of streams.entries()) stream.write = realWrites[index]!;
    }
    return { root, logs: chunks.join("") };
  }

  return {
    buildSite,
    async cleanup() {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
    },
  };
}

/** The request handler of a site built with `server: true`. */
export async function siteApp(
  site: AgentSite,
): Promise<{ render(request: Request): Promise<Response> }> {
  const { app } = (await import(
    pathToFileURL(path.join(site.root, ".server/entry.mjs")).href
  )) as { app: { render(request: Request): Promise<Response> } };
  return app;
}

export async function agentManifest(root: string) {
  return JSON.parse(
    await readFile(
      path.join(root, ".astro/nimbus/agent-endpoint-assets/manifest.json"),
      "utf8",
    ),
  ) as {
    version: number;
    markdownAssets: Array<{
      collection: string;
      id: string;
      surface: string;
      url: string;
      path: string;
    }>;
    llmsAssets: Array<{ scope: string; surface: string; section?: string; path: string }>;
  };
}
