#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), "..");
const RELEASE_PACKAGES = [
  resolve(ROOT, "packages", "nimbus-docs"),
  resolve(ROOT, "packages", "create-nimbus-docs"),
];

export function changelogEntry(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

async function githubRequest(fetchImpl, token, owner, repo, path, options = {}) {
  return fetchImpl(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      ...options.headers,
    },
  });
}

export async function reconcileGithubReleases({
  token,
  owner = "cloudflare",
  repo = "nimbus",
  packageDirs = RELEASE_PACKAGES,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");

  for (const packageDir of packageDirs) {
    const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
    const tag = `${pkg.name}@${pkg.version}`;
    const encodedTag = encodeURIComponent(tag);
    const tagResponse = await githubRequest(
      fetchImpl,
      token,
      owner,
      repo,
      `/git/ref/tags/${encodedTag}`,
    );
    if (tagResponse.status === 404) continue;
    if (!tagResponse.ok) throw new Error(`could not inspect GitHub tag ${tag} (HTTP ${tagResponse.status})`);

    const releasePath = `/releases/tags/${encodedTag}`;
    const releaseResponse = await githubRequest(fetchImpl, token, owner, repo, releasePath);
    if (releaseResponse.ok) continue;
    if (releaseResponse.status !== 404) {
      throw new Error(`could not inspect GitHub Release ${tag} (HTTP ${releaseResponse.status})`);
    }

    const body = changelogEntry(readFileSync(resolve(packageDir, "CHANGELOG.md"), "utf8"), pkg.version);
    const createResponse = await githubRequest(fetchImpl, token, owner, repo, "/releases", {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, name: tag, body }),
    });
    if (!createResponse.ok) {
      const retry = await githubRequest(fetchImpl, token, owner, repo, releasePath);
      if (!retry.ok) throw new Error(`could not create GitHub Release ${tag} (HTTP ${createResponse.status})`);
    }
    console.log(`[release] GitHub Release ready: ${tag}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  reconcileGithubReleases({ token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN }).catch((error) => {
    console.error(`[release] FAIL - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
