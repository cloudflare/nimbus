#!/usr/bin/env node
/**
 * `pnpm screenshots` — the fixed views the Nimbus home page uses, from the
 * built Worker: each page in light and dark, at desktop and phone widths, 2x.
 * Build first (`pnpm build`). Writes PNGs to `screenshots/`, or `--out <dir>`.
 * Pass `--url <origin>` to shoot a server that's already running.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const out = resolve(arg("--out") ?? resolve(root, "screenshots"));
const PORT = 4599;

const VIEWS = [
  { name: "overview", path: "/" },
  { name: "api", path: "/api/" },
  { name: "operation", path: "/api/forecasts/get-daily-forecast/" },
];
const SIZES = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

async function waitFor(url, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} didn't answer within ${ms / 1000}s. Run pnpm build first.`);
}

let server;
let origin = arg("--url");
if (!origin) {
  origin = `http://localhost:${PORT}`;
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], { cwd: root, stdio: "ignore" });
}

try {
  await waitFor(origin);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const mode of ["light", "dark"]) {
    for (const size of SIZES) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 2,
        colorScheme: mode,
        reducedMotion: "reduce",
      });
      // The theme toggle's stored choice wins over the system's.
      await context.addInitScript((m) => localStorage.setItem("ui-mode", m), mode);
      const page = await context.newPage();
      for (const view of VIEWS) {
        await page.goto(origin + view.path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const file = resolve(out, `${view.name}-${size.name}-${mode}.png`);
        await page.screenshot({ path: file });
        console.log(file);
      }
      await context.close();
    }
  }
  await browser.close();
} finally {
  server?.kill();
}
