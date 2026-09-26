import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { latestTemplatesTag } from "../src/cli/_templates.js";

const originalFetch = globalThis.fetch;
const originalAuth = process.env.GIGET_AUTH;
const SKIP = "skip the lookup with --to <templates-vX.Y.Z> or --template-dir <path>.";
const ANONYMOUS =
  "GitHub refused the template lookup (anonymous requests are limited to 60 per hour). " +
  `Set GIGET_AUTH to a GitHub token, or ${SKIP}`;
const WITH_TOKEN = `GitHub refused the template lookup with the token in GIGET_AUTH. Check the token, or ${SKIP}`;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAuth === undefined) delete process.env.GIGET_AUTH;
  else process.env.GIGET_AUTH = originalAuth;
});

async function lookupError(respond: () => Response, auth?: string): Promise<string> {
  if (auth === undefined) delete process.env.GIGET_AUTH;
  else process.env.GIGET_AUTH = auth;
  globalThis.fetch = (async () => respond()) as typeof fetch;
  return latestTemplatesTag().then(
    () => assert.fail("expected the tags lookup to fail"),
    (err: Error) => err.message,
  );
}

const reset = Math.floor(Date.now() / 1000) + 600;
const resetAt = new Date(reset * 1000).toLocaleString(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const limited = (status: number, resetHeader: string) =>
  new Response("{}", { status, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetHeader } });

const cases: Array<{ name: string; respond: () => Response; auth?: string; expected: string }> = [
  { name: "403 at the rate limit", respond: () => limited(403, String(reset)), expected: `${ANONYMOUS} The limit resets at ${resetAt}.` },
  { name: "429 at the rate limit", respond: () => limited(429, String(reset)), expected: `${ANONYMOUS} The limit resets at ${resetAt}.` },
  { name: "unusable reset header", respond: () => limited(403, "Infinity"), expected: ANONYMOUS },
  { name: "429 without headers", respond: () => new Response("", { status: 429 }), expected: ANONYMOUS },
  { name: "non-JSON 403 body", respond: () => new Response("<html>denied</html>", { status: 403 }), expected: ANONYMOUS },
  {
    name: "403 with GitHub's reason",
    respond: () => Response.json({ message: "Resource protected by SAML enforcement." }, { status: 403 }),
    expected: `${ANONYMOUS} GitHub said: "Resource protected by SAML enforcement."`,
  },
  {
    name: "401 with GIGET_AUTH set",
    respond: () => Response.json({ message: "Bad credentials" }, { status: 401 }),
    auth: "ghp_example",
    expected: `${WITH_TOKEN} GitHub said: "Bad credentials"`,
  },
  {
    name: "other statuses keep the old message",
    respond: () => new Response("", { status: 502 }),
    expected: "GitHub tags API returned 502 for cloudflare/nimbus. Pass --to <tag> to skip the lookup.",
  },
];

for (const { name, respond, auth, expected } of cases) {
  test(`refused tag lookup: ${name}`, async () => {
    assert.equal(await lookupError(respond, auth), expected);
  });
}

test("a network failure keeps the old message", async () => {
  delete process.env.GIGET_AUTH;
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as typeof fetch;
  await assert.rejects(latestTemplatesTag(), /^Error: Couldn't reach GitHub to find the latest template tag \(getaddrinfo ENOTFOUND/);
});
