// A Markdown plugin's type comes from the public entry, not borrowed from one
// of our own plugins.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("HastPluginDefinition and HastVisitorContext import from @cloudflare/nimbus-docs/markdown", async () => {
  const pkg = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const dir = await mkdtemp(path.join(tmpdir(), "nimbus-markdown-types-"));
  try {
    await mkdir(path.join(dir, "node_modules", "@cloudflare"), { recursive: true });
    await symlink(pkg, path.join(dir, "node_modules", "@cloudflare", "nimbus-docs"), "dir");
    await writeFile(path.join(dir, "plugin.ts"), `import type { HastPluginDefinition, HastVisitorContext } from "@cloudflare/nimbus-docs/markdown";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";
const plugins: HastPluginDefinition[] = [tableScroll()];
type Context = HastVisitorContext;
export { plugins, type Context };
`);
    const program = ts.createProgram([path.join(dir, "plugin.ts")], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      types: [],
    });
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(errors, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
