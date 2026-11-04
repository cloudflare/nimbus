// The dev server hands /nimbus-api/coordinates.json between Nimbus and a
// project file as the file appears and goes. Its own file, so the watcher
// runs in a fresh process.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { dev } from "astro";
import { discoveryFixture as fixture } from "./fixtures/agent-discovery-site.js";

const OWNED = 'export const prerender = true;\nexport function GET() { return new Response("owned"); }\n';

test("in dev the route hands over when an owner appears and goes, without a restart by hand", async () => {
  const site = await fixture(undefined, "docs", true);
  // A fixed port: the restart that hands the route over keeps it, where port 0 picks another.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  const server = await dev({ ...site.config, server: { host: "127.0.0.1", port } });
  const url = `http://127.0.0.1:${port}/docs/nimbus-api/coordinates.json`;
  const until = async (expect: (body: string, response: Response) => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        last = await response.text();
        if (expect(last, response)) return response;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail(`${what}; last body: ${last.slice(0, 200)}`);
  };
  try {
    const served = await until((body) => body.includes('"pets"'), "Nimbus serves the manifest");
    assert.equal(served.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(served.headers.get("Cache-Control"), "public, max-age=3600");
    await site.write("src/pages/nimbus-api/coordinates.json.ts", OWNED);
    await until((body) => body === "owned", "the new owner serves it");
    rmSync(path.join(site.root, "src/pages/nimbus-api/coordinates.json.ts"));
    await until((body) => body.includes('"pets"'), "Nimbus serves it again");
  } finally {
    await server.stop();
    await rm(site.root, { recursive: true, force: true, maxRetries: 5 });
  }
});
