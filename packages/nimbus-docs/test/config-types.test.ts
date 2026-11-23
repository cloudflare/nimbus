// The config types catch what Nimbus would reject when it runs: an unknown
// key, or a Markdown processor that isn't one.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const source = (file: string) => JSON.stringify(path.join(here, "../src", file));

const check = `
/// <reference path=${source("types/virtual-modules.d.ts")} />
import { satteri } from "@astrojs/markdown-satteri";
import { unified } from "@astrojs/markdown-remark";
import { defineConfig } from ${source("config.ts")};
import { nimbus } from ${source("integration.ts")};

const config = defineConfig({
  site: "https://example.com",
  title: "Acme",
  features: { sidebar: true, tableOfContents: false },
});
defineConfig({
  site: "https://example.com",
  title: "Acme",
  // @ts-expect-error a typo of tableOfContents
  features: { tableOfContent: false },
});
// @ts-expect-error not a Nimbus key
defineConfig({ site: "https://example.com", title: "Acme", sidebarr: {} });

nimbus(config, { markdown: { processor: satteri() } });
nimbus(config, { markdown: { processor: unified() } });
// @ts-expect-error not a Markdown processor
nimbus(config, { markdown: { processor: 123 } });
`;

test("config types reject unknown keys and processors that aren't one", async () => {
  const dir = await mkdtemp(path.join(here, ".config-types-"));
  roots.push(dir);
  const file = path.join(dir, "check.ts");
  await writeFile(file, check);
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(here, "../tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )!;
  const program = ts.createProgram([file], { ...config.options, noEmit: true, allowImportingTsExtensions: true });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === file)
    .map((diagnostic) => {
      const { line } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!);
      return `${line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    });
  assert.deepEqual(diagnostics, []);
});
