// The community recipes listing is checked when the site builds: a bad entry
// fails with a message naming it, before anything is fetched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { communityRecipes } from "./community-recipes";
import { parseRecipes, type CommunityRecipeEntry } from "./parse-recipes";
import { EMPTY_STATE, recipesMarkdown } from "../lib/community-recipes-markdown";

const raw = (path: string) => `https://raw.githubusercontent.com/${path}`;
const recipe = (name: string, url: string): CommunityRecipeEntry => ({ name, description: `${name}, one line.`, url });

test("the listing itself parses", () => {
  assert.ok(Array.isArray(communityRecipes));
});

test("a raw GitHub .md URL credits its owner, links its repo, and keeps a ref with /", () => {
  const [owner] = parseRecipes([recipe("Chat", raw("alice/mcp-chat/main/RECIPE.md"))]);
  assert.equal(owner!.owner, "alice");
  assert.equal(owner!.profileUrl, "https://github.com/alice");
  assert.equal(owner!.avatarUrl, "https://github.com/alice.png?size=64");
  assert.equal(owner!.recipes[0]!.repoUrl, "https://github.com/alice/mcp-chat");
  const [nested] = parseRecipes([recipe("Chat", raw("alice/mcp-chat/feature/new-ui/docs/RECIPE.md"))]);
  assert.equal(nested!.recipes[0]!.url, raw("alice/mcp-chat/feature/new-ui/docs/RECIPE.md"));
});

test("one owner's recipes group together, owners compared case-insensitively", () => {
  const owners = parseRecipes([
    recipe("Chat", raw("Alice/mcp-chat/main/RECIPE.md")),
    recipe("Badges", raw("alice/badges/v1.0.0/RECIPE.md")),
    recipe("Other", raw("bob/other/main/RECIPE.md")),
  ]);
  assert.deepEqual(
    owners.map((o) => [o.owner, o.recipes.map((r) => r.name)]),
    [["Alice", ["Chat", "Badges"]], ["bob", ["Other"]]],
    "spelled as the owner's first entry spells it",
  );
});

test("a URL that isn't a raw GitHub .md file with a ref and path fails, naming the entry", () => {
  const cases: Array<[string, RegExp]> = [
    ["https://github.com/alice/mcp-chat/blob/main/RECIPE.md", /must be a raw file on raw\.githubusercontent\.com/],
    ["https://github.com/alice/mcp-chat", /must be a raw file/],
    [raw("alice/mcp-chat/main/RECIPE.md?token=1"), /can't have a query or fragment/],
    [raw("alice/mcp-chat/main/RECIPE.md#top"), /can't have a query or fragment/],
    ["http://raw.githubusercontent.com/alice/mcp-chat/main/RECIPE.md", /must use https/],
    [raw("alice/mcp-chat/main/RECIPE.txt"), /must be a \.md file/],
    [raw("alice/mcp-chat/RECIPE.md"), /needs an owner, a repo, a ref and a file path/],
    ["not a url", /isn't a URL/],
    // One shell word, one spelling: nothing a shell or a URL decoder reads differently.
    [raw("alice/mcp-chat/main/$(printf%20x).md"), /can only use letters, digits/],
    [raw("alice/mcp-chat/main/my recipe.md"), /must be written as/],
    [raw("%61lice/mcp-chat/main/RECIPE.md"), /can only use letters, digits/],
    [raw("%/mcp-chat/main/RECIPE.md"), /can only use letters, digits/],
    [raw("alice/mcp-chat/main/it's.md"), /can only use letters, digits/],
    ["https://raw.githubusercontent.com:443/alice/mcp-chat/main/RECIPE.md", /must be written as https:\/\/raw\.githubusercontent\.com\/alice/],
    ["https://RAW.githubusercontent.com/alice/mcp-chat/main/RECIPE.md", /must be written as/],
    [raw("alice/mcp-chat/main/../RECIPE.md"), /must be written as/],
    ["https://$(id)@raw.githubusercontent.com/alice/mcp-chat/main/RECIPE.md", /no user, password or port/],
    ["https://user:pass@raw.githubusercontent.com/alice/mcp-chat/main/RECIPE.md", /no user, password or port/],
    ["https://raw.githubusercontent.com:8443/alice/mcp-chat/main/RECIPE.md", /no user, password or port/],
  ];
  for (const [url, message] of cases) {
    assert.throws(() => parseRecipes([recipe("Chat", url)]), (error: Error) => {
      assert.match(error.message, /^Community recipe "Chat": url /, url);
      assert.match(error.message, message, url);
      return true;
    });
  }
});

test("the same recipe under two names, or two names differing only in case, fail", () => {
  assert.throws(
    () => parseRecipes([recipe("Chat", raw("alice/mcp-chat/main/RECIPE.md")), recipe("Chat two", raw("ALICE/MCP-Chat/main/RECIPE.md"))]),
    /Community recipe "Chat two": the same recipe is already listed as "Chat"/,
  );
  assert.throws(
    () => parseRecipes([recipe("Chat", raw("alice/mcp-chat/main/RECIPE.md")), recipe("chat", raw("bob/chat/main/RECIPE.md"))]),
    /Community recipe "chat": the name is already used by "Chat"/,
  );
  // The ref and file path are case-sensitive, as GitHub treats them.
  assert.equal(
    parseRecipes([recipe("A", raw("alice/r/main/A.md")), recipe("B", raw("alice/r/main/a.md"))])[0]!.recipes.length,
    2,
  );
});

test("an entry with a missing, multi-line or unknown field fails, naming it", () => {
  assert.throws(() => parseRecipes([{ name: "", description: "x", url: raw("a/b/c/d.md") }]), /Community recipe #1: name/);
  assert.throws(
    () => parseRecipes([{ name: "Chat", description: "two\nlines", url: raw("a/b/c/d.md") }]),
    /Community recipe "Chat": description is one line/,
  );
  assert.throws(() => parseRecipes([{ name: "Two\nlines", description: "x", url: raw("a/b/c/d.md") }]), /name is one line/);
  assert.throws(
    () => parseRecipes([{ name: "Chat", description: "x", url: raw("a/b/c/d.md"), author: "me" } as CommunityRecipeEntry]),
    /Community recipe "Chat": /,
  );
});

test("the Markdown lists every recipe, with listing text kept as text", () => {
  assert.equal(recipesMarkdown([]), EMPTY_STATE);
  const markdown = recipesMarkdown(
    parseRecipes([
      { name: "Chat *bold*", description: "[a link](https://x.test) <b>html</b> & `code`", url: raw("alice/mcp-chat/main/RECIPE.md") },
      { name: "Badges", description: "Badges.", url: raw("Alice/__badges__/v1/RECIPE.md") },
    ]),
  );
  assert.equal(
    markdown,
    [
      "### [alice](https://github.com/alice)",
      "- **Chat \\*bold\\*** — \\[a link\\]\\(https://x.test\\) \\<b\\>html\\</b\\> \\& \\`code\\` ([alice/mcp-chat](https://github.com/alice/mcp-chat))\n\n  ```sh\n  npx @cloudflare/nimbus-docs add https://raw.githubusercontent.com/alice/mcp-chat/main/RECIPE.md\n  ```",
      "- **Badges** — Badges. ([Alice/\\_\\_badges\\_\\_](https://github.com/Alice/__badges__))\n\n  ```sh\n  npx @cloudflare/nimbus-docs add https://raw.githubusercontent.com/Alice/__badges__/v1/RECIPE.md\n  ```",
    ].join("\n\n"),
  );
});
