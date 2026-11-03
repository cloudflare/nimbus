// Copy shared by the homepage (WwwBody.astro) and its Markdown version
// (src/pages/index.md.ts), so the two say the same thing. Copy pass, Oct 9
// 2026; local to www so the variant pages keep their exploration copy.
export const workflows = [
  { label: "For people", title: "Pages worth reading.", items: ["Interactive diagrams readers can explore", "Reusable snippets and personalised tabs", "Write wherever your content already lives", "A preview that matches production"] },
  { label: "For agents", title: "Pages an agent can write.", items: ["Recipes an agent can follow", "Writing mistakes it finds and fixes, just like code", "Aware of your conventions before it writes", "Nothing ships without your sign-off"] },
];

export const faq: [string, string][] = [
  ["Does it work with the Markdown I already have?", "Yes. Drop your pages in. Each page needs a title. The checks tell you what else is missing."],
  ["Do I need an agent to use it?", "No. Every feature works by hand. Agents are first-class authors, not required ones."],
  ["Which agents can author with it?", "Any that can read a file. Recipes are plain Markdown, checks are JSON, and the site index is a text file at a fixed address."],
  ["Where can I deploy it?", "Anywhere that serves static files. On Cloudflare, deploying is one more line."],
  ["Is it free?", "MIT licensed, no hosted tier required. The registry is free too."],
];

/** The homepage's description, in its head and its Markdown version. */
export const description =
  "The authoring tool for docs. Write with your team and your agents, held to your standard, on a site you can customise completely.";
