import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectDeploySignals,
  expandDynamicRedirects,
  formatRedirectsFile,
  normalizeRedirects,
  shouldEmitRedirects,
  type RedirectConfigLike,
} from "../src/_internal/redirect-emitters.js";

test("shouldEmitRedirects: Cloudflare or Netlify signal opts in", () => {
  assert.equal(shouldEmitRedirects({ cloudflare: true, netlify: false }), true);
  assert.equal(shouldEmitRedirects({ cloudflare: false, netlify: true }), true);
  assert.equal(shouldEmitRedirects({ cloudflare: false, netlify: false }), false);
});

test("detectDeploySignals reads repo files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-redir-"));
  try {
    assert.deepEqual(detectDeploySignals(dir), {
      cloudflare: false,
      netlify: false,
    });
    fs.writeFileSync(path.join(dir, "wrangler.jsonc"), "{}");
    assert.equal(detectDeploySignals(dir).cloudflare, true);
    fs.writeFileSync(path.join(dir, "netlify.toml"), "");
    assert.equal(detectDeploySignals(dir).netlify, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeRedirects: default status is 301, object form keeps its status", () => {
  const redirects: Record<string, RedirectConfigLike> = {
    "/old/": "/new/",
    "/temp/": { status: 302, destination: "/dest/" },
  };
  const { redirects: out, skipped } = normalizeRedirects(redirects, "");
  assert.deepEqual(skipped, []);
  assert.deepEqual(out, [
    { from: "/old/", to: "/new/", status: 301 },
    { from: "/temp/", to: "/dest/", status: 302 },
  ]);
});

test("normalizeRedirects: base is prefixed onto both source and destination", () => {
  const { redirects: out } = normalizeRedirects(
    { "/v1/foo/": "/foo/", "/": "/home/" },
    "/docs",
  );
  assert.deepEqual(out, [
    { from: "/docs/v1/foo/", to: "/docs/foo/", status: 301 },
    { from: "/docs/", to: "/docs/home/", status: 301 },
  ]);
});

test("normalizeRedirects: bare '/' base is a no-op prefix", () => {
  const { redirects: out } = normalizeRedirects({ "/v1/foo/": "/foo/" }, "/");
  assert.deepEqual(out, [{ from: "/v1/foo/", to: "/foo/", status: 301 }]);
});

test("normalizeRedirects: external destinations are not base-prefixed", () => {
  const { redirects: out } = normalizeRedirects(
    { "/gh/": "https://github.com/x", "/cdn/": "//cdn.example.com/a" },
    "/docs",
  );
  assert.deepEqual(out, [
    { from: "/docs/gh/", to: "https://github.com/x", status: 301 },
    { from: "/docs/cdn/", to: "//cdn.example.com/a", status: 301 },
  ]);
});

test("normalizeRedirects: dynamic patterns are skipped, self-redirects dropped", () => {
  const { redirects: out, skipped } = normalizeRedirects(
    {
      "/blog/[slug]/": "/news/[slug]/",
      "/loop/": "/loop/",
      "/ok/": "/fine/",
    },
    "",
  );
  assert.deepEqual(out, [{ from: "/ok/", to: "/fine/", status: 301 }]);
  assert.deepEqual(skipped, ["/blog/[slug]/"]);
});

test("expandDynamicRedirects: one page per built route a dynamic source matches", () => {
  const redirects: Record<string, RedirectConfigLike> = {
    "/sdk/[...slug]": "/products/kit/[...slug]",
    "/blog/[year]/[slug]": { status: 302, destination: "/news/[slug]" },
    "/old": "/new",
    "/ext/[...slug]": "https://example.com/[...slug]",
  };
  const routes = ["/sdk", "/sdk/setup", "/sdk/guides/install", "/sdkx/setup", "/blog/2024/launch", "/blog/2024", "/ext/a", "/products/kit/setup"];
  assert.deepEqual(expandDynamicRedirects(redirects, routes, "/docs"), [
    { from: "/docs/sdk", to: "/docs/products/kit", status: 301 },
    { from: "/docs/sdk/setup", to: "/docs/products/kit/setup", status: 301 },
    { from: "/docs/sdk/guides/install", to: "/docs/products/kit/guides/install", status: 301 },
    { from: "/docs/blog/2024/launch", to: "/docs/news/launch", status: 302 },
  ]);
});

test("formatRedirectsFile: fresh file, ordering preserved", () => {
  const content = formatRedirectsFile(null, [
    { from: "/v1/a/", to: "/a/", status: 301 },
    { from: "/v1/b/", to: "/b/", status: 308 },
  ]);
  assert.equal(content, "/v1/a/ /a/ 301\n/v1/b/ /b/ 308\n");
});

test("formatRedirectsFile: merges with existing, existing sources win (no dup)", () => {
  const existing = "# hand-authored\n/v1/a/ /custom/ 302\n";
  const content = formatRedirectsFile(existing, [
    { from: "/v1/a/", to: "/a/", status: 301 },
    { from: "/v1/b/", to: "/b/", status: 301 },
  ]);
  assert.equal(
    content,
    "# hand-authored\n/v1/a/ /custom/ 302\n/v1/b/ /b/ 301\n",
  );
});

test("formatRedirectsFile: re-running over its own output is idempotent", () => {
  const redirects = [
    { from: "/v1/a/", to: "/a/", status: 301 },
    { from: "/v1/b/", to: "/b/", status: 308 },
  ];
  const first = formatRedirectsFile(null, redirects);
  const second = formatRedirectsFile(first, redirects);
  assert.equal(second, first);
});

test("formatRedirectsFile: empty input with no existing yields empty string", () => {
  assert.equal(formatRedirectsFile(null, []), "");
});

test("formatRedirectsFile: a path with whitespace or a line break stays one field of one rule", () => {
  const { redirects } = normalizeRedirects({ "/old page": "/getting started", "/a\nb": "/c\td", "/café": "/déjà%20vu" }, "/");
  const file = formatRedirectsFile(null, redirects);
  const rules = file.trim().split("\n").map((line) => line.split(/\s+/));
  assert.deepEqual(rules, [
    ["/old%20page", "/getting%20started", "301"],
    ["/a%0Ab", "/c%09d", "301"],
    ["/caf%C3%A9", "/d%C3%A9j%C3%A0%20vu", "301"],
  ]);
  // A rule the file already has, written encoded, still wins.
  assert.equal(formatRedirectsFile("/old%20page /kept 302\n", redirects).split("\n")[0], "/old%20page /kept 302");
  assert.equal(formatRedirectsFile("/old%20page /kept 302\n", redirects).match(/old%20page/g)?.length, 1);
});

test("formatRedirectsFile: a line that is no rule reserves no source", () => {
  // An older file's unencoded space split the rule; `/old` itself was never redirected.
  const { redirects } = normalizeRedirects({ "/old": "/new" }, "/");
  const file = formatRedirectsFile("/old page /getting started 301\n", redirects);
  assert.deepEqual(file.trim().split("\n"), ["/old page /getting started 301", "/old /new 301"]);
});
