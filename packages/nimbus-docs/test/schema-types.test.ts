// `entry.data` is typed the way each schema helper validates it: built-in
// fields keep their types, added and narrowed fields are typed, and wrong
// reads are errors.

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
import { z } from "astro/zod";
import type { SchemaContext } from "astro:content";
import { defineDocSchema, definePartialsSchema, defineSchema, docsSchema } from ${source("schemas.ts")};
import { docsCollection, partialsCollection } from ${source("content.ts")};

declare const ctx: SchemaContext;

// No fields: the built-in fields keep their types.
for (const schema of [docsSchema, defineDocSchema(), docsCollection().schema, docsCollection({ base: "docs" }).schema]) {
  const data = schema.parse({});
  const title: string = data.title;
  // @ts-expect-error title is a string
  const wrong: number = data.title;
  // @ts-expect-error no such field
  data.titel;
  void [title, wrong];
}
{
  const data = definePartialsSchema().parse({});
  const params: string[] | undefined = data.params;
  // @ts-expect-error no such field
  data.other;
  void params;
}
{
  const data = partialsCollection().schema.parse({});
  // @ts-expect-error no such field
  data.other;
}

// Fields: typed next to the built-in ones.
{
  const data = docsCollection({ schemaFields: { author: z.string() } }).schema.parse({});
  const author: string = data.author;
  const title: string = data.title;
  void [author, title];
}
{
  const data = partialsCollection({ schemaFields: { inputParameters: z.number() } }).schema.parse({});
  const input: number = data.inputParameters;
  void input;
}

// defineSchema: extend, narrow, both, neither, and a non-object extend.
{
  const both = defineSchema(() => ({ extend: z.object({ author: z.string() }), narrow: { mode: z.literal("doc") } }))(ctx);
  const data = both.parse({});
  const title: string = data.title;
  const author: string = data.author;
  const mode: "doc" = data.mode;
  // @ts-expect-error no such field
  data.titel;
  // @ts-expect-error author is a string
  const wrong: number = data.author;
  void [title, author, mode, wrong];
}
{
  const data = defineSchema(() => ({}))(ctx).parse({});
  const title: string = data.title;
  // @ts-expect-error no such field
  data.author;
  void title;
}
{
  const data = defineSchema(() => ({ narrow: { mode: z.literal("doc") } }))(ctx).parse({});
  const mode: "doc" = data.mode;
  void mode;
}
{
  const data = defineSchema((c) => ({ extend: z.object({ cover: c.image() as z.ZodString }) }))(ctx).parse({});
  const title: string = data.title;
  void [title, data.cover];
  // @ts-expect-error no such field
  data.covr;
}
{
  const data = defineSchema(() => ({ extend: z.object({ a: z.string() }).or(z.object({ b: z.number() })) }))(ctx).parse({});
  const title: string = data.title;
  void title;
  // @ts-expect-error no such field
  data.c;
}
`;

test("schema helpers type entry.data the way they validate it", async () => {
  const dir = await mkdtemp(path.join(here, ".schema-types-"));
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
