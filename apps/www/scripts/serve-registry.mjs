#!/usr/bin/env node
/**
 * Minimal static file server for the generated registry output at
 * `apps/www/public/registry/`. Lightweight alternative to spinning up the
 * full Astro dev server when all you want is to test the CLI against a
 * local registry.
 *
 * Node-only, zero deps. Honours $PORT (default 8901). Logs each request.
 *
 *   node apps/www/scripts/serve-registry.mjs
 *
 * Typically spawned by `scripts/local.mjs`, not run by hand.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = resolve(__dirname, "..", "public", "registry");
const PORT = Number(process.env.PORT ?? 8901);

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

if (!existsSync(REGISTRY_DIR)) {
  console.error(
    `[serve-registry] no registry at ${REGISTRY_DIR}. Run \`pnpm --filter @nimbus/www generate-registry\` first.`,
  );
  process.exit(1);
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // Prevent path traversal — normalize and ensure result stays under REGISTRY_DIR.
  const filePath = normalize(join(REGISTRY_DIR, urlPath));
  if (!filePath.startsWith(REGISTRY_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not found: ${urlPath}`);
    return;
  }

  const ext = extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(readFileSync(filePath));
  process.stdout.write(`  ${req.method} ${urlPath}\n`);
});

server.listen(PORT, () => {
  process.stdout.write(`[serve-registry] http://localhost:${PORT}\n`);
  process.stdout.write(`[serve-registry] serving ${REGISTRY_DIR}\n`);
});

// Clean shutdown on Ctrl+C so the parent orchestrator can recycle the port.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
