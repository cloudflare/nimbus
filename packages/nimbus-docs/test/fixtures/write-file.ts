// Writes a file a running dev server watches.
//
// `writeFile` empties the file, then fills it, as two steps. A watcher can
// report the first, and Astro then reads `astro.config.mjs` empty: it restarts
// with no integrations, and drops the event for the finished write because that
// restart is still running. The server then answers every request with its
// error page until the next edit. Writing beside the site and renaming over the
// file leaves nothing to read in between.

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { TEST_TMP } from "./temp-root.js";

const STAGING = path.join(TEST_TMP, ".writes");

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await mkdir(STAGING, { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  const staged = path.join(STAGING, randomUUID());
  await writeFile(staged, contents, "utf8");
  await rename(staged, file);
}
