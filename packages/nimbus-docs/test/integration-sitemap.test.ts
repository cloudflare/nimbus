import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { AstroIntegration } from "astro";
import { nimbus } from "../src/integration.js";

for (const base of ["/", "/my-project", "/my-project/"]) {
  test(`sitemap emits one root entry with base ${base}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nimbus-sitemap-"));
    const directory = pathToFileURL(root + path.sep);
    const logger = {
      warn() {},
      info() {},
      error(message: string) {
        throw new Error(message);
      },
    };
    const config = {
      root: directory,
      srcDir: new URL("src/", directory),
      cacheDir: new URL(".cache/", directory),
      site: "https://example.test",
      base,
      trailingSlash: "ignore",
      build: { format: "directory" },
    };
    let integrations: AstroIntegration[] = [];
    const integration = nimbus(
      { site: config.site, title: "Test" },
      {
        validateMdx: false,
        admonitions: false,
        markdown: { processor: {} as never },
      },
    );
    await integration.hooks["astro:config:setup"]!({
      config,
      logger,
      updateConfig(update: { integrations: AstroIntegration[] }) {
        integrations = update.integrations;
        return {};
      },
    } as never);
    const sitemap = integrations.find(
      (item) => item.name === "@astrojs/sitemap",
    )!;
    await sitemap.hooks["astro:config:done"]!({ config } as never);
    assert.equal(config.base, base, "the app's base must remain unchanged");
    await sitemap.hooks["astro:routes:resolved"]!({
      routes: [
        {
          type: "page",
          pathname: "/",
          generate: () => "/",
        },
      ],
    } as never);
    await sitemap.hooks["astro:build:done"]!({
      dir: directory,
      pages: [{ pathname: "" }, { pathname: "guide/" }],
      logger,
    } as never);
    const xml = await readFile(new URL("sitemap-0.xml", directory), "utf8");
    const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(
      (match) => match[1],
    );
    const prefix = base.replace(/\/$/, "");
    assert.deepEqual(
      urls.sort(),
      [
        `https://example.test${prefix}/`,
        `https://example.test${prefix}/guide/`,
      ].sort(),
    );
  });
}
