// Runs `astro dev` on a throwaway site against the in-repo Nimbus integration,
// for tests that edit files under a running server.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { after } from "node:test";
import { pathToFileURL } from "node:url";

import { dev } from "astro";

import { runningNimbusVersion } from "../../src/_internal/upgrades.ts";
import { TEST_TMP } from "./temp-root.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

const SRC = path.resolve(import.meta.dirname, "../../src");

/** Import specifier for a package source module, usable from fixture files. */
export const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.join(SRC, relative)).href);

const astroConfig = (nimbusOptions: Record<string, unknown>) => `import nimbus from ${moduleUrl("index.ts")};

export default {
  cacheDir: "./.astro",
  vite: {
    cacheDir: "./.vite",
    logLevel: "silent",
    resolve: {
      alias: [
        { find: /^@cloudflare\\/nimbus-docs$/, replacement: ${JSON.stringify(path.join(SRC, "index.ts"))} },
        { find: /^@cloudflare\\/nimbus-docs\\//, replacement: ${JSON.stringify(`${SRC}/`)} },
      ],
    },
  },
  integrations: [
    nimbus(
      { site: "https://dev.test", title: "Dev", description: "Dev", search: false, ...${JSON.stringify(nimbusOptions)} },
      { admonitions: false, sitemap: false, validateMdx: false },
    ),
  ],
};
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export async function until<T>(describe: string, read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${describe}; last value: ${JSON.stringify(last)}`);
}

export const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops a dev server, then waits for Astro's debounced content-store write
 * (500 ms after the last change, and not cancelled by `stop()`), so removing
 * the site doesn't race it.
 */
export async function stopDevServer(server: { stop(): Promise<void> }, root: string): Promise<void> {
  await server.stop();
  const store = path.join(root, ".astro", "data-store.json");
  const written = async () =>
    (await Promise.all([store, `${store}.tmp`].map((file) => stat(file).then((info) => info.mtimeMs, () => 0)))).join();
  const deadline = Date.now() + 10_000;
  let last = await written();
  let quietSince = Date.now();
  while (Date.now() < deadline && Date.now() - quietSince < 1_000) {
    await settle(100);
    const current = await written();
    if (current !== last) {
      last = current;
      quietSince = Date.now();
    }
  }
}

export interface DevSite {
  file(relative: string): string;
  write(relative: string, contents: string): Promise<void>;
  page(route: string): Promise<{ status: number; body: string }>;
  serves(route: string, text: string): Promise<unknown>;
  since(mark: number): string;
  restartsSince(mark: number): number;
  restarted(mark: number): Promise<unknown>;
  mark(): number;
}

export async function withDevSite(files: Record<string, string>, nimbusOptions: Record<string, unknown>, run: (site: DevSite) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(TEST_TMP, "nimbus-dev-site-"));
  roots.push(root);
  const file = (relative: string) => path.join(root, relative);
  const write = async (relative: string, contents: string) => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), contents, "utf8");
  };
  await symlink(path.resolve(import.meta.dirname, "../../node_modules"), file("node_modules"), process.platform === "win32" ? "junction" : "dir");
  await write("nimbus.json", `${JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() })}\n`);
  await write("astro.config.mjs", astroConfig(nimbusOptions));
  for (const [relative, contents] of Object.entries(files)) await write(relative, contents);

  const logs: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const realWrites = streams.map((stream) => stream.write);
  for (const [index, stream] of streams.entries()) {
    const realWrite = realWrites[index]!.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return realWrite(chunk, ...rest);
    }) as typeof stream.write;
  }
  const since = (mark: number) => logs.slice(mark).join("");

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = await dev({ root: pathToFileURL(`${root}${path.sep}`), logLevel: "info", server: { host: "127.0.0.1", port } });
  const page = async (route: string) => {
    const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    return { status: response?.status ?? 0, body: (await response?.text()) ?? "" };
  };
  try {
    await run({
      file,
      write,
      page,
      serves: (route, text) => until(`${route} to serve ${text}`, () => page(route), ({ status, body }) => status === 200 && body.includes(text)),
      since,
      restartsSince: (mark) => since(mark).match(/Restarting\.\.\./gu)?.length ?? 0,
      // A restart re-syncs content once setup has run; wait for it, so the next
      // step (or stopping the server) doesn't race it.
      restarted: (mark) =>
        until("the restart to finish", () => since(mark), (text) => {
          const start = text.lastIndexOf("Restarting...");
          return start >= 0 && text.indexOf("Synced content", start) > start;
        }),
      mark: () => logs.length,
    });
  } finally {
    await stopDevServer(server, root);
    for (const [index, stream] of streams.entries()) stream.write = realWrites[index]!;
  }
}

