// Golden comparison for generated code samples: every sample of every
// operation in the gauntlet specs, at a baseline commit and in the working
// tree, compared from the same verified fixture files.
//
//   pnpm --filter nimbus-docs pull:api-fixtures
//   node --max-old-space-size=8192 --import tsx scripts/sample-golden.mts --baseline <rev> --allow scripts/sample-golden.allow.json
//
// Fails on a fixture whose hash isn't the pinned one, a run that captured
// nothing, a missing operation or sample, and any difference no rule in the
// allowlist covers, or a rule whose count changed. The allowlist names rules,
// not samples: `{ "rule": "whitespace-only", "lang": "typescript", "count": 1306, "why": "…" }`.
// `--write-allow` prints the rule counts this run found, for review.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Sample = { id: string; lang: string; source: string };
type Capture = Record<string, Record<string, Sample[]>>;
type Rule = { rule: "whitespace-only"; lang: string; count: number; why: string };

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(pkg, "test/fixtures/api/production");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

// ---- Capture mode: run in a package root, print the samples as JSON ----------

if (args[0] === "--capture") {
  const root = args[1]!;
  const out = args[2]!;
  const { buildApiModel, getApiPageProps, getApiPageSlugs } = await import(pathToFileURL(path.join(root, "src/api/index.ts")).href);
  const manifest = JSON.parse(readFileSync(path.join(fixtures, "sources.json"), "utf8")) as { sources: { file: string }[] };
  const capture: Capture = {};
  for (const { file } of manifest.sources) {
    const spec = file.replace(/\.(json|yaml)$/, "");
    const model = await buildApiModel({ collection: spec, spec: readFileSync(path.join(fixtures, file), "utf8"), label: file });
    const samples: Record<string, Sample[]> = {};
    for (const { coordinate } of getApiPageSlugs(model)) {
      const page = getApiPageProps(model, coordinate);
      if (page.kind === "operation") samples[coordinate] = page.samples.map(({ id, lang, source }: Sample) => ({ id, lang, source }));
    }
    capture[spec] = samples;
  }
  writeFileSync(out, JSON.stringify(capture));
  process.exit(0);
}

// ---- Compare mode ----------------------------------------------------------------

const baseline = flag("--baseline");
const allowFile = flag("--allow");
if (!baseline) throw new Error("Pass --baseline <rev>.");

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync(path.join(fixtures, "sources.json"), "utf8")) as { sources: { file: string; sha256: string }[] };
for (const { file, sha256: expected } of manifest.sources) {
  const at = path.join(fixtures, file);
  if (!existsSync(at) || sha256(readFileSync(at)) !== expected) {
    throw new Error(`${file} is missing or isn't the pinned revision: run pnpm --filter nimbus-docs pull:api-fixtures.`);
  }
}

const work = mkdtempSync(path.join(tmpdir(), "nimbus-sample-golden-"));
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: pkg, encoding: "utf8" }).trim();
const tree = path.join(work, "baseline");
const capture = (root: string, out: string) =>
  execFileSync(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", fileURLToPath(import.meta.url), "--capture", root, out], {
    cwd: pkg,
    stdio: ["ignore", "ignore", "inherit"],
  });
let before: Capture;
let after: Capture;
try {
  execFileSync("git", ["worktree", "add", "--detach", tree, baseline], { cwd: repo, stdio: "ignore" });
  // The baseline runs with this checkout's dependencies.
  symlinkSync(path.join(repo, "node_modules"), path.join(tree, "node_modules"));
  symlinkSync(path.join(pkg, "node_modules"), path.join(tree, "packages/nimbus-docs/node_modules"));
  capture(path.join(tree, "packages/nimbus-docs"), path.join(work, "before.json"));
  capture(pkg, path.join(work, "after.json"));
  before = JSON.parse(readFileSync(path.join(work, "before.json"), "utf8"));
  after = JSON.parse(readFileSync(path.join(work, "after.json"), "utf8"));
} finally {
  execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: repo, stdio: "ignore" });
  rmSync(work, { recursive: true, force: true });
}

const rules: Rule[] = allowFile ? JSON.parse(readFileSync(allowFile, "utf8")) : [];
const found = new Map<string, number>();
const failures: string[] = [];
let identical = 0;
let total = 0;
const squash = (text: string) => text.replace(/\s+/g, "");
for (const [spec, operations] of Object.entries(before)) {
  for (const [coordinate, samples] of Object.entries(operations)) {
    const next = after[spec]?.[coordinate];
    if (!next) {
      failures.push(`${spec} ${coordinate}: missing`);
      continue;
    }
    if (next.length !== samples.length) failures.push(`${spec} ${coordinate}: ${samples.length} samples before, ${next.length} after`);
    samples.forEach((sample, i) => {
      total++;
      const other = next[i];
      if (!other || other.id !== sample.id) return failures.push(`${spec} ${coordinate} ${sample.id}: missing`);
      if (other.source === sample.source) return identical++;
      if (squash(other.source) === squash(sample.source)) {
        const key = `whitespace-only ${sample.lang}`;
        found.set(key, (found.get(key) ?? 0) + 1);
        return;
      }
      failures.push(`${spec} ${coordinate} ${sample.id}: changed\n--- before\n${sample.source}\n--- after\n${other.source}`);
    });
  }
}
for (const [spec, operations] of Object.entries(after)) {
  for (const coordinate of Object.keys(operations)) if (!before[spec]?.[coordinate]) failures.push(`${spec} ${coordinate}: new`);
}
if (total === 0) failures.push("No samples were captured.");
for (const [key, count] of found) {
  const [rule, lang] = key.split(" ");
  const allowed = rules.find((r) => r.rule === rule && r.lang === lang);
  if (!allowed) failures.push(`${count} ${lang} samples differ in whitespace only, and no rule allows it.`);
  else if (allowed.count !== count) failures.push(`${lang} whitespace-only: ${count} samples, the allowlist says ${allowed.count}.`);
}
for (const rule of rules) if (!found.has(`${rule.rule} ${rule.lang}`)) failures.push(`The ${rule.rule} rule for ${rule.lang} matched nothing.`);

console.log(`samples ${total}, identical ${identical}, ${[...found].map(([k, n]) => `${k} ${n}`).join(", ") || "no allowed differences"}`);
if (args.includes("--write-allow")) {
  console.log(JSON.stringify([...found].map(([key, count]) => ({ rule: key.split(" ")[0], lang: key.split(" ")[1], count, why: "" })), null, 2));
}
if (failures.length > 0) {
  console.error(failures.slice(0, 20).join("\n\n"));
  console.error(`\n${failures.length} unexpected difference(s).`);
  process.exit(1);
}
