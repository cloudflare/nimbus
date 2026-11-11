// Runs `astro dev` on a throwaway site against the in-repo Nimbus integration,
// for tests that edit files under a running server.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    // Vite's own lines are kept: "server restarted." is how an in-place
    // restart says its replacement server is listening.
    logLevel: "info",
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
  // Whether `text` ends with a dev restart still in flight. A route-file
  // change restarts the dev server in place; the restart is over once Vite
  // reports the replacement server listening ("server restarted.") and Astro
  // has re-synced content after it, or once a restart gave up.
  const restartOver = (text: string) => {
    const start = text.lastIndexOf("Restarting...");
    if (start < 0) return true;
    const rest = text.slice(start);
    if (/Continuing with previous valid configuration|server restart failed/u.test(rest)) return true;
    const listening = rest.indexOf("server restarted.");
    return listening >= 0 && rest.indexOf("Synced content", listening) >= 0;
  };
  let failed = false;
  try {
    await run({
      file,
      write,
      page,
      serves: (route, text) => until(`${route} to serve ${text}`, () => page(route), ({ status, body }) => status === 200 && body.includes(text)),
      since,
      restartsSince: (mark) => since(mark).match(/Restarting\.\.\./gu)?.length ?? 0,
      // Wait for the restart a step caused, so the next step (or stopping the
      // server) doesn't race it.
      restarted: (mark) =>
        until("the restart to finish", () => since(mark), (text) => text.includes("Restarting...") && restartOver(text)),
      mark: () => logs.length,
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Stopping the server while a restart is in flight leaves the restarted
    // server listening, and the test process never exits. Let a pending
    // route recheck fire, then let any restart finish before stopping.
    await settle(300);
    const deadline = Date.now() + 60_000;
    while (!restartOver(since(0)) && Date.now() < deadline) await settle(100);
    const unfinished = !restartOver(since(0));
    try {
      await server.stop();
    } finally {
      for (const [index, stream] of streams.entries()) stream.write = realWrites[index]!;
    }
    if (unfinished && !failed) {
      assert.fail("the dev server was still restarting when the test ended; its restarted server may outlive the stop");
    }
  }
}
