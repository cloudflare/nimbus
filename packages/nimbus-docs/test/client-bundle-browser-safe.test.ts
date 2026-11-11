// The `client` entry runs in readers' browsers. No chunk it reaches may import
// a Node built-in: the bundler can pull one in through a shared chunk (a
// runtime helper importing `node:module`), and every page script then fails.
// Reads the built package, which CI builds before the tests.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const dist = path.resolve(import.meta.dirname, "../dist");

test("the client entry's chunks import no Node built-in", { skip: !existsSync(path.join(dist, "client.js")) && "build the package first" }, () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string, from: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(path.join(dist, file), "utf8");
    // Import statements only: generated samples hold `node:` text in strings.
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      if (specifier.startsWith("node:")) offenders.push(`${file} imports ${specifier} (reached from ${from})`);
      else if (specifier.startsWith("./")) visit(specifier.slice(2), file);
    }
  };
  visit("client.js", "client.js");
  assert.ok(seen.size > 1, "found the client's chunks");
  assert.deepEqual(offenders, []);
});
