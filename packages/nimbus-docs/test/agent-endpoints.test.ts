import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as agentEndpoints from "../src/agent-endpoints.ts";
import * as buildApi from "../src/build.ts";
import * as publication from "../src/publication.ts";

test("agent endpoints retain the publication compatibility entrypoint", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> };
  assert.ok(packageJson.exports["./agent-endpoints"]);
  assert.ok(packageJson.exports["./build"]);
  assert.ok(packageJson.exports["./publication"]);
  assert.deepEqual(Object.keys(agentEndpoints).sort(), [
    "getLlmsPayload",
    "getLlmsStaticPaths",
    "getMarkdownPayload",
    "getMarkdownStaticPaths",
    "llmsFullRoute",
    "llmsRoute",
    "llmsSectionRoute",
    "markdownRoute",
    "markdownSourceRoute",
  ]);
  assert.deepEqual(Object.keys(publication).sort(), [
    "getPreparedLlmsRouteArtifact",
    "getPreparedLlmsRouteStaticPaths",
    "getPreparedMarkdownRouteArtifact",
    "getPreparedMarkdownRouteStaticPaths",
  ]);
  assert.deepEqual(Object.keys(buildApi).sort(), [
    "getPreparedLlmsArtifact",
    "getPreparedLlmsStaticPaths",
    "getPreparedMarkdownArtifact",
    "getPreparedMarkdownStaticPaths",
  ]);
  assert.equal(
    publication.getPreparedLlmsRouteArtifact,
    agentEndpoints.getLlmsPayload,
  );
  assert.equal(
    publication.getPreparedMarkdownRouteArtifact,
    agentEndpoints.getMarkdownPayload,
  );
});
