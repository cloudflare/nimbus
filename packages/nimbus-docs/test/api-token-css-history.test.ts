import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeToHtml } from "shiki";
import { defaultCodeTransformers } from "../src/_internal/code-transformers.js";
import { prepareApiAssetFamily } from "../src/_internal/api/page-assets-build.js";
import {
  clearCodeStyleRegistry,
  getCodeStyleCSS,
} from "../src/_internal/code-style-registry.js";
import type { ApiSpec } from "../src/types.js";

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-token-css-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const spec = (lang: string, source: string) => ({
  openapi: "3.0.3",
  info: { title: "Example", version: "1" },
  paths: {
    "/cats": {
      get: {
        operationId: "listCats",
        "x-codeSamples": [{ lang, source }],
        responses: { "200": { description: "Success" } },
      },
    },
  },
});

const family = (v2: unknown, v1: unknown): ApiSpec => ({
  collection: "api",
  versionUrl: { in: "query" },
  samples: { generate: [] },
  versions: [
    { version: "v2", default: true, spec: v2 as Record<string, unknown> },
    { version: "v1", spec: v1 as Record<string, unknown> },
  ],
});

// Markdown has token colours none of the other samples use.
const markdown = spec("markdown", "# Title\n\n**bold** _it_ `code` [l](u)");
const ruby = spec("ruby", "class Cat < Animal\n  def meow = :purr\nend");
const shell = spec("shell", "curl -X GET https://example.com/cats");

// Each call starts like a new process: no token styles, no highlighted code.
async function build(root: string, input: ApiSpec): Promise<string> {
  clearCodeStyleRegistry();
  await prepareApiAssetFamily(root, input);
  return getCodeStyleCSS();
}

test("a kept cache gives the same token CSS as a clean build after a style leaves", async () =>
  temporary(async (kept) =>
    temporary(async (clean) => {
      // Release N: v2 uses Markdown, v1 uses Ruby.
      await build(kept, family(markdown, ruby));
      // Release N+1: v2 drops Markdown for shell; v1 is unchanged and reused.
      const reused = await build(kept, family(shell, ruby));
      const fresh = await build(clean, family(shell, ruby));
      assert.equal(reused, fresh);
    })));

const second = (input: unknown): ApiSpec => ({
  collection: "other",
  samples: { generate: [] },
  spec: input as Record<string, unknown>,
});

test("a family's reused version doesn't keep another family's departed styles", async () =>
  temporary(async (kept) =>
    temporary(async (clean) => {
      const both = async (root: string, other: unknown) => {
        clearCodeStyleRegistry();
        await prepareApiAssetFamily(root, second(other));
        await prepareApiAssetFamily(root, family(ruby, ruby));
        return getCodeStyleCSS();
      };
      await both(kept, markdown);
      assert.equal(await both(kept, shell), await both(clean, shell));
    })));

test("styles from code highlighted outside API preparation stay out of version caches", async () =>
  temporary(async (kept) =>
    temporary(async (clean) => {
      const withDocsBlock = async (root: string, docs: boolean) => {
        clearCodeStyleRegistry();
        // A docs page's code block, highlighted before the API is prepared.
        if (docs)
          await codeToHtml("# Title\n\n**bold** _it_ `code` [l](u)", {
            lang: "markdown",
            themes: { light: "github-light", dark: "github-dark" },
            defaultColor: false,
            transformers: defaultCodeTransformers({ classTokens: true }),
          });
        await prepareApiAssetFamily(root, family(ruby, ruby));
        return getCodeStyleCSS();
      };
      await withDocsBlock(kept, true);
      assert.equal(await withDocsBlock(kept, false), await withDocsBlock(clean, false));
    })));

test("a sample whose text spells a token class doesn't keep that class's style", async () =>
  temporary(async (probe) =>
    temporary(async (kept) =>
      temporary(async (clean) => {
        // The class names Markdown's highlighting uses.
        const css = await build(probe, family(markdown, markdown));
        const names = [...css.matchAll(/\.(nb-shiki-[a-z0-9]+)/g)].map((m) => m[1]);
        assert.ok(names.length > 0);
        const spelling = spec("shell", `echo "${names.join(" ")}"`);
        await build(kept, family(markdown, spelling));
        const reused = await build(kept, family(shell, spelling));
        assert.equal(reused, await build(clean, family(shell, spelling)));
      }))));
