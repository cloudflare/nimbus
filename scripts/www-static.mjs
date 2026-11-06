#!/usr/bin/env node
/**
 * Turn a checkout of apps/www into its static form, for fork PR Previews:
 * no adapter, every page built ahead of time, no MCP server. Fork Previews
 * serve only static files, so unreviewed code never runs as a Worker.
 *
 * It edits astro.config.ts, then lets `nimbus-docs check --fix` put each
 * route file in build mode. Run it on a throwaway checkout, never to commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const www = fileURLToPath(new URL("../apps/www/", import.meta.url));
const configPath = `${www}astro.config.ts`;

// Each line must be found exactly as written, so a config change can't leave
// the fork build half static.
const edits = [
  ['  rendering: { collections: { docs: "request", components: "request" } },\n', ""],
  ["  agents: { mcp: true },\n", ""],
  ['  output: "server",\n', '  output: "static",\n'],
  ['  adapter: cloudflare({ prerenderEnvironment: "node" }),\n', ""],
  ['import cloudflare from "@astrojs/cloudflare";\n', ""],
];

let config = readFileSync(configPath, "utf8");
for (const [from, to] of edits) {
  if (config.split(from).length !== 2) {
    console.error(`www-static: expected exactly one ${JSON.stringify(from.trim())} in apps/www/astro.config.ts.`);
    process.exit(1);
  }
  config = config.replace(from, to);
}
writeFileSync(configPath, config);

execFileSync(process.execPath, ["../../packages/nimbus-docs/dist/cli/index.js", "check", "--fix"], { cwd: www, stdio: "inherit" });
