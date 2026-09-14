import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileGithubReleases } from "./reconcile-github-releases.mjs";
import {
  publicationAction,
  publishedByThisRun,
  publishInOrder,
  publishTarball,
  waitForPublished,
} from "./release.mjs";

test("waitForPublished tolerates delayed registry visibility", async () => {
  const states = ["absent", "unknown", "published"];
  let calls = 0;

  await waitForPublished("@cloudflare/nimbus-docs", "1.2.3", {
    getRegistryVersion: async () => {
      calls += 1;
      return { state: states.shift() };
    },
    timeoutMs: 100,
    intervalMs: 0,
  });

  assert.equal(calls, 3);
});

test("waitForPublished fails when registry visibility times out", async () => {
  await assert.rejects(
    waitForPublished("@cloudflare/nimbus-docs", "1.2.3", {
      getRegistryVersion: async () => ({ state: "absent" }),
      timeoutMs: 0,
      intervalMs: 0,
    }),
    /did not become visible on npm within 0ms \(last state: absent\)/,
  );
});

test("waitForPublished rejects a different published artifact", async () => {
  await assert.rejects(
    waitForPublished("@cloudflare/nimbus-docs", "1.2.3", {
      getRegistryVersion: async () => ({ state: "published", integrity: "sha512-other" }),
      expectedIntegrity: "sha512-expected",
      timeoutMs: 100,
      intervalMs: 0,
    }),
    /is on npm with integrity sha512-other, expected sha512-expected/,
  );
});

test("publicationAction publishes only absent exact versions", () => {
  const pkg = { name: "pkg", version: "1.2.3" };
  const absent = { state: "absent" };
  assert.equal(publicationAction({ pkg, latest: absent, exact: absent }), "publish");

  assert.equal(publicationAction({
    pkg,
    latest: { state: "published", version: "1.2.3" },
    exact: { state: "published", integrity: "sha512-different-pack" },
    hasTag: true,
  }), "skip");
});

test("publicationAction rejects stale, ambiguous, and untagged states", () => {
  const pkg = { name: "pkg", version: "1.2.3" };
  const latest = { state: "published", version: "1.2.3" };
  const exact = { state: "published", integrity: "sha512-expected" };
  const input = { pkg, latest, exact, hasTag: true };

  assert.throws(
    () => publicationAction({ ...input, latest: { state: "published", version: "1.2.4" } }),
    /refusing to publish stale pkg@1.2.3/,
  );
  assert.throws(
    () => publicationAction({ ...input, latest: { state: "unknown" } }),
    /could not determine npm latest/,
  );
  assert.throws(
    () => publicationAction({ ...input, exact: { state: "unknown" } }),
    /could not determine whether pkg@1.2.3 is on npm/,
  );
  assert.throws(
    () => publicationAction({ ...input, hasTag: false }),
    /git tag is missing; recover it manually/,
  );
});

test("publishTarball distinguishes a reconciled failure from a successful publish", async () => {
  const events = [];
  const published = await publishTarball("/pkg", { name: "pkg", version: "1.2.3" }, "/pkg.tgz", {
    spawn: () => {
      events.push("publish");
      return { status: 1 };
    },
    integrity: () => "sha512-expected",
    wait: async (name, version, options) => {
      events.push("visible");
      assert.equal(name, "pkg");
      assert.equal(version, "1.2.3");
      assert.equal(options.expectedIntegrity, undefined);
    },
  });
  assert.deepEqual(events, ["publish", "visible"]);
  assert.equal(published, false);

  const successful = await publishTarball("/pkg", { name: "pkg", version: "1.2.3" }, "/pkg.tgz", {
    spawn: () => ({ status: 0 }),
    integrity: () => "sha512-expected",
    wait: async (name, version, options) => {
      assert.equal(name, "pkg");
      assert.equal(version, "1.2.3");
      assert.equal(options.expectedIntegrity, "sha512-expected");
    },
  });
  assert.equal(successful, true);
});

test("Nimbus visibility is required before CLI publication", async () => {
  const events = [];
  await publishInOrder({
    publishNimbus: async () => events.push("nimbus"),
    publishCli: async () => events.push("cli"),
  });
  assert.deepEqual(events, ["nimbus", "cli"]);

  await assert.rejects(
    publishInOrder({
      publishNimbus: async () => {
        publishedByThisRun({ name: "nimbus", version: "1.2.3" }, false, false);
      },
      publishCli: async () => events.push("should-not-publish"),
    }),
    /became visible after npm publish failed; recover its git tag manually/,
  );
  assert.ok(!events.includes("should-not-publish"));
  assert.equal(publishedByThisRun({ name: "nimbus", version: "1.2.3" }, false, true), false);
  assert.equal(publishedByThisRun({ name: "nimbus", version: "1.2.3" }, true, false), true);
});

test("GitHub Release reconciliation tolerates a concurrent creator", async () => {
  const packageDir = mkdtempSync(join(tmpdir(), "nimbus-release-test-"));
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pkg", version: "1.2.3" }));
  writeFileSync(join(packageDir, "CHANGELOG.md"), "# pkg\n\n## 1.2.3\n\nRelease notes.\n");
  const responses = [
    { status: 200, ok: true },
    { status: 404, ok: false },
    { status: 422, ok: false },
    { status: 200, ok: true },
  ];
  const requests = [];

  try {
    await reconcileGithubReleases({
      token: "test",
      packageDirs: [packageDir],
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return responses.shift();
      },
    });
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }

  assert.equal(requests[2].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    tag_name: "pkg@1.2.3",
    name: "pkg@1.2.3",
    body: "Release notes.",
  });
  assert.match(requests[3].url, /releases\/tags\/pkg%401.2.3$/);
});
