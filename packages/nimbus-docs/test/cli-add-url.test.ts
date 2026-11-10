// `add <url>` hands the recipe at a URL to a coding agent the way `add <feature>`
// does, with errors about that URL rather than the registry.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { provenanceNote } from "../src/cli/feature.ts";
import { RECIPE_MAX_BYTES } from "../src/cli/resolver.ts";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

// Without the variables coding agents set, so the CLI sees a person unless
// `--print` says otherwise.
const AGENT_ENV = /^(AI_AGENT|CLAUDECODE|CLAUDE_CODE.*|CODEX.*|CURSOR.*|OPENCODE.*|GEMINI_CLI|REPL_ID|AUGMENT.*|AMP_.*)$/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !AGENT_ENV.test(key)));

const RECIPE = "# Add a chat panel\n\nDo the thing.\n";
let server: Server;
let origin = "";
let requests = 0;
let cwd = "";

before(async () => {
  cwd = mkdtempSync(path.join(tmpdir(), "nimbus-add-url-"));
  server = createServer((req, res) => {
    requests += 1;
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/RECIPE.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(RECIPE);
    } else if (url.pathname === "/no-newline.md") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("No final newline");
    } else if (url.pathname === "/moved.md") {
      res.writeHead(302, { location: "/RECIPE.md" });
      res.end();
    } else if (url.pathname === "/cut.md") {
      // Headers promise more than arrives before the connection drops.
      res.writeHead(200, { "content-type": "text/markdown", "content-length": "1000" });
      res.write("# Half");
      setTimeout(() => res.socket?.destroy(), 20);
    } else if (url.pathname === "/elsewhere.md") {
      // Another origin on this machine: localhost rather than 127.0.0.1.
      res.writeHead(302, { location: `http://localhost:${(server.address() as { port: number }).port}/RECIPE.md` });
      res.end();
    } else if (url.pathname === "/huge.md") {
      // No content-length, so only counting the bytes as they arrive catches it.
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("x".repeat(RECIPE_MAX_BYTES + 1));
    } else if (url.pathname === "/blob.md") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>GitHub</title>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...args], {
      cwd,
      env: { ...baseEnv, NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr, all: stdout + stderr }));
  });
}

// What the agent reads: the provenance note, a blank line, then the recipe.
const handedOver = (url: string, body: string) =>
  `${provenanceNote(url, new TextEncoder().encode(body))}\n\n${body}`;

test("--print writes the note then the recipe, adding a final newline only when it has none", async () => {
  const recipe = await run("add", `${origin}/RECIPE.md`, "--print");
  assert.equal(recipe.code, 0, recipe.all);
  assert.equal(recipe.stdout, handedOver(`${origin}/RECIPE.md`, RECIPE));
  const bare = await run("add", `${origin}/no-newline.md`, "--print");
  assert.equal(bare.code, 0, bare.all);
  assert.equal(bare.stdout, `${handedOver(`${origin}/no-newline.md`, "No final newline")}\n`);
});

test("the note names the URL, the digest and size of the bytes served, and asks before risky edits", () => {
  const body = new TextEncoder().encode(RECIPE);
  const digest = createHash("sha256").update(body).digest("hex");
  const note = provenanceNote("https://example.com/RECIPE.md", body);
  assert.ok(note.startsWith("<!-- nimbus-docs: recipe from https://example.com/RECIPE.md\n"), note);
  assert.ok(note.includes(`sha256 ${digest.slice(0, 8)}…${digest.slice(-4)} · ${body.byteLength} bytes · not from the Nimbus registry.`), note);
  assert.match(note, /tell the user what you'll change and why, and wait\n\s+for a yes\./);
  assert.ok(note.endsWith("added. -->"));
  assert.equal(note.indexOf("-->"), note.length - 3, "nothing closes the comment early");
  const sized = provenanceNote("https://example.com/r.md", new Uint8Array(86_203));
  assert.ok(sized.includes("· 86,203 bytes ·"), sized);
  const hostile = provenanceNote("https://example.com/a-->b<!--c.md?x=-->", body);
  assert.equal(hostile.indexOf("-->"), hostile.length - 3, "a URL can't close the comment");
});

test("outside an agent, the pipe instructions name the URL, quoted when it needs it", async () => {
  const plain = await run("add", `${origin}/RECIPE.md`);
  assert.equal(plain.code, 0, plain.all);
  assert.equal(plain.stdout, "", "nothing reaches stdout");
  assert.ok(plain.stderr.includes(`add ${origin}/RECIPE.md --print | claude`), plain.stderr);
  assert.ok(plain.stderr.includes("To install this recipe, pipe it to your coding agent"), plain.stderr);
  const query = await run("add", `${origin}/RECIPE.md?ref=v1&x=2`);
  assert.equal(query.code, 0, query.all);
  assert.ok(query.stderr.includes(`add '${origin}/RECIPE.md?ref=v1&x=2' --print | claude`), query.stderr);
});

test("a redirect is followed", async () => {
  const moved = await run("add", `${origin}/moved.md`, "--print");
  assert.equal(moved.code, 0, moved.all);
  assert.equal(moved.stdout, handedOver(`${origin}/moved.md`, RECIPE), "the note names the URL the user gave");
});

test("a redirect to another origin is named in the note", async () => {
  const moved = await run("add", `${origin}/elsewhere.md`, "--print");
  assert.equal(moved.code, 0, moved.all);
  const port = new URL(origin).port;
  assert.equal(
    moved.stdout,
    `${provenanceNote(`${origin}/elsewhere.md`, new TextEncoder().encode(RECIPE), `http://localhost:${port}`)}\n\n${RECIPE}`,
  );
  assert.match(moved.stdout, new RegExp(`served by http://localhost:${port} after a redirect\\.`));
});

test("plain http off this machine fails before any request", async () => {
  const before = requests;
  const plain = await run("add", "http://example.com/RECIPE.md", "--print");
  assert.equal(plain.code, 1);
  assert.match(plain.all, /http:\/\/example\.com\/RECIPE\.md isn't https/);
  assert.equal(requests, before);
});

test("a recipe over the size cap fails without reaching the agent", async () => {
  const huge = await run("add", `${origin}/huge.md`, "--print");
  assert.equal(huge.code, 1);
  assert.match(huge.all, /\/huge\.md is over 1,000,000 bytes, too big for a recipe/);
  assert.ok(!huge.stdout.includes("xxxx"), "nothing of it reaches the agent");
});

test("an HTML page, a 404 or an unreachable host fails naming the URL, without registry wording", async () => {
  const html = await run("add", `${origin}/blob.md`, "--print");
  assert.equal(html.code, 1);
  assert.match(html.all, /\/blob\.md returned an HTML page, not a recipe\. Use the raw file's URL \(on GitHub, the Raw button\)/);
  const missing = await run("add", `${origin}/gone.md`, "--print");
  assert.equal(missing.code, 1);
  assert.ok(missing.all.includes(`${origin}/gone.md returned 404.`), missing.all);
  // A port nothing listens on: bind one, then close it.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const unreachable = await run("add", `http://127.0.0.1:${port}/RECIPE.md`, "--print");
  assert.equal(unreachable.code, 1);
  assert.ok(unreachable.all.includes(`Could not fetch http://127.0.0.1:${port}/RECIPE.md:`), unreachable.all);
  const cut = await run("add", `${origin}/cut.md`, "--print");
  assert.equal(cut.code, 1);
  assert.ok(cut.all.includes(`Could not read ${origin}/cut.md:`), cut.all);
  assert.ok(!cut.stdout.includes("# Half"), "nothing half-read reaches the agent");
  for (const result of [html, missing, unreachable, cut]) {
    assert.doesNotMatch(result.all, /registry|NIMBUS_REGISTRY_URL|slug/i);
  }
});

test("a bad argument beside a URL fails before any request", async () => {
  const before = requests;
  const typo = await run("add", "not-a-thing", `${origin}/RECIPE.md`);
  assert.equal(typo.code, 1);
  assert.match(typo.all, /Unknown registry item: `not-a-thing`/);
  const twice = await run("add", `${origin}/RECIPE.md`, `${origin}/no-newline.md`, "--print");
  assert.equal(twice.code, 1);
  assert.match(twice.all, /`--print` takes one slug/);
  assert.equal(requests, before, "nothing was fetched");
});
