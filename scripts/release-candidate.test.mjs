// The release publishes exactly the candidate verify-release checked: the
// tarballs match the integrities fixed before verification ran, the
// regenerated templates match their digest, and a version that reaches npm
// after a failed publish counts only if it is that candidate.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { templatesDigest } from "../packages/create-nimbus-docs/scripts/copy-template.mjs";
import { checkCandidate, publishTarball, releaseCandidate, waitForPublished } from "./release.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const nimbus = readJson("../packages/nimbus-docs/package.json");
const cli = readJson("../packages/create-nimbus-docs/package.json");

const integrity = (file) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-candidate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A tarball holding `package/package.json`, like `pnpm pack` writes. */
function tarball(dir, pkg) {
  const work = mkdtempSync(join(dir, "pack-"));
  mkdirSync(join(work, "package"));
  writeFileSync(join(work, "package", "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version }));
  const file = join(dir, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
  assert.equal(spawnSync("tar", ["-czf", file, "-C", work, "package"]).status, 0);
  rmSync(work, { recursive: true });
  return file;
}

function templates(dir) {
  const root = join(dir, "templates");
  mkdirSync(join(root, "template", "src"), { recursive: true });
  writeFileSync(join(root, "template", "package.json"), "{}\n");
  writeFileSync(join(root, "template", "src", "index.md"), "# Home\n");
  return root;
}

function candidate(t) {
  const dir = scratch(t);
  const out = join(dir, "candidate");
  mkdirSync(out);
  const files = { nimbus: tarball(out, nimbus), cli: tarball(out, cli) };
  const generated = templates(dir);
  const env = {
    RELEASE_NIMBUS_INTEGRITY: integrity(files.nimbus),
    RELEASE_CLI_INTEGRITY: integrity(files.cli),
    RELEASE_TEMPLATES_DIGEST: templatesDigest(generated),
  };
  return { out, files, generated, env, generate: () => generated };
}

test("templatesDigest changes with any added, removed, renamed, edited or newly executable file", (t) => {
  const base = templatesDigest(templates(scratch(t)));
  const file = (root) => join(root, "template", "src", "index.md");
  const changes = {
    added: (root) => writeFileSync(join(root, "template", "extra.md"), ""),
    removed: (root) => rmSync(join(root, "template", "package.json")),
    renamed: (root) => renameSync(file(root), join(root, "template", "src", "home.md")),
    edited: (root) => writeFileSync(file(root), "# Home!\n"),
    executable: (root) => chmodSync(file(root), 0o755),
  };
  for (const [name, change] of Object.entries(changes)) {
    const root = templates(scratch(t));
    assert.equal(templatesDigest(root), base);
    change(root);
    assert.notEqual(templatesDigest(root), base, name);
  }
});

test("templatesDigest refuses a symlink", (t) => {
  const root = templates(scratch(t));
  symlinkSync("index.md", join(root, "template", "src", "link.md"));
  assert.throws(() => templatesDigest(root), /is not a regular file/);
});

test("a candidate that matches its digests passes; any changed byte, template or missing value stops it", (t) => {
  const ok = candidate(t);
  const checked = checkCandidate(ok.out, ok.env, { generate: ok.generate });
  assert.equal(checked.nimbusTarball, ok.files.nimbus);
  assert.equal(checked.expected.cli, ok.env.RELEASE_CLI_INTEGRITY);

  const tampered = candidate(t);
  const bytes = readFileSync(tampered.files.cli);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(tampered.files.cli, bytes);
  assert.throws(() => checkCandidate(tampered.out, tampered.env, { generate: tampered.generate }), /no tarball in .* has integrity/);

  const edited = candidate(t);
  writeFileSync(join(edited.generated, "template", "src", "index.md"), "# Changed\n");
  assert.throws(() => checkCandidate(edited.out, edited.env, { generate: edited.generate }), /regenerated templates have digest/);

  const linked = candidate(t);
  symlinkSync("index.md", join(linked.generated, "template", "src", "link.md"));
  assert.throws(() => checkCandidate(linked.out, linked.env, { generate: linked.generate }), /not a regular file/);

  for (const name of Object.keys(ok.env)) {
    const missing = { ...ok.env };
    delete missing[name];
    assert.throws(() => checkCandidate(ok.out, missing, { generate: ok.generate }), new RegExp(`${name} is missing or malformed`));
    assert.throws(
      () => checkCandidate(ok.out, { ...ok.env, [name]: "sha512-nope" }, { generate: ok.generate }),
      new RegExp(`${name} is missing or malformed`),
    );
  }
});

test("a candidate packed at another version stops it", (t) => {
  const dir = scratch(t);
  const out = join(dir, "candidate");
  mkdirSync(out);
  const wrong = tarball(out, { ...nimbus, version: "0.0.1" });
  const right = tarball(out, cli);
  const generated = templates(dir);
  const env = {
    RELEASE_NIMBUS_INTEGRITY: integrity(wrong),
    RELEASE_CLI_INTEGRITY: integrity(right),
    RELEASE_TEMPLATES_DIGEST: templatesDigest(generated),
  };
  assert.throws(() => checkCandidate(out, env, { generate: () => generated }), /contains .*@0\.0\.1, expected/);
});

test("after a failed npm publish, the version counts only if npm holds the candidate's integrity", async () => {
  const pkg = { name: "pkg", version: "1.2.3" };
  const failed = () => ({ status: 1 });
  const registryWith = (value) => ({
    wait: (name, version, options) =>
      waitForPublished(name, version, {
        ...options,
        getRegistryVersion: async () => ({ state: "published", integrity: value }),
        timeoutMs: 100,
        intervalMs: 0,
      }),
  });
  assert.equal(
    await publishTarball("/pkg", pkg, "/pkg.tgz", { spawn: failed, expectedIntegrity: "sha512-candidate", ...registryWith("sha512-candidate") }),
    false,
  );
  await assert.rejects(
    publishTarball("/pkg", pkg, "/pkg.tgz", { spawn: failed, expectedIntegrity: "sha512-candidate", ...registryWith("sha512-other") }),
    /integrity sha512-other, expected sha512-candidate/,
  );
});

/** releaseCandidate with npm, git and GitHub replaced by a recording fake. */
function fakeRelease({ published = [], tagged = [] } = {}) {
  const events = [];
  const onNpm = new Set(published);
  const tags = new Set(tagged);
  const deps = {
    registryLatest: async () => ({ state: "published", version: "0.0.0" }),
    registryVersion: async (name) => (onNpm.has(name) ? { state: "published" } : { state: "absent" }),
    tagExists: (tag) => tags.has(tag),
    sync: async ({ version }) => (events.push(`sync ${version}`), { reason: "synced", tag: `templates-v${version}` }),
    publishTarball: async (_dir, pkg, _tarball, { expectedIntegrity }) => {
      events.push(`publish ${pkg.name} ${expectedIntegrity}`);
      tags.add(`${pkg.name}@${pkg.version}`);
      return true;
    },
    tag: () => events.push("changeset tag"),
    dispatchSmoke: async (tag) => events.push(`smoke ${tag}`),
  };
  const release = {
    nimbus,
    cli,
    nimbusTarball: "/nimbus.tgz",
    cliTarball: "/cli.tgz",
    generatedDir: "/templates",
    expected: { nimbus: "sha512-nimbus", cli: "sha512-cli" },
  };
  return { events, run: () => releaseCandidate(release, deps) };
}

const nimbusTag = `${nimbus.name}@${nimbus.version}`;
const cliTag = `${cli.name}@${cli.version}`;

test("orchestration: framework only, CLI only, both, nothing, and a rerun after the framework published", async () => {
  const both = fakeRelease();
  assert.deepEqual(await both.run(), ["publish", "publish"]);
  assert.deepEqual(both.events, [
    `sync ${cli.version}`,
    `publish ${nimbus.name} sha512-nimbus`,
    `publish ${cli.name} sha512-cli`,
    "changeset tag",
    `smoke templates-v${cli.version}`,
  ]);

  const frameworkOnly = fakeRelease({ published: [cli.name], tagged: [cliTag] });
  assert.deepEqual(await frameworkOnly.run(), ["publish", "skip"]);
  assert.deepEqual(frameworkOnly.events, [`publish ${nimbus.name} sha512-nimbus`, "changeset tag"]);

  const cliOnly = fakeRelease({ published: [nimbus.name], tagged: [nimbusTag] });
  assert.deepEqual(await cliOnly.run(), ["skip", "publish"]);
  assert.deepEqual(cliOnly.events, [
    `sync ${cli.version}`,
    `publish ${cli.name} sha512-cli`,
    "changeset tag",
    `smoke templates-v${cli.version}`,
  ]);

  const nothing = fakeRelease({ published: [nimbus.name, cli.name], tagged: [nimbusTag, cliTag] });
  assert.deepEqual(await nothing.run(), ["skip", "skip"]);
  assert.deepEqual(nothing.events, []);
});

test("changeset tag prints the `New tag:` lines changesets/action reads to set `published`", (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-pkg", version: "1.2.3" }));
  mkdirSync(join(dir, ".changeset"));
  writeFileSync(join(dir, ".changeset", "config.json"), JSON.stringify({ baseBranch: "main" }));
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: dir }).status, 0, `git ${args.join(" ")}`);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture");
  const changeset = new URL("../node_modules/.bin/changeset", import.meta.url).pathname;
  const tag = spawnSync(changeset, ["tag"], { cwd: dir, encoding: "utf8" });
  assert.equal(tag.status, 0, tag.stderr);
  assert.match(tag.stdout + tag.stderr, /New tag:\s+v1\.2\.3/);
});
