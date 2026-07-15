/**
 * Shared navigation fixtures for the tree-derived navigation tests.
 *
 * Three hard shapes the spec must satisfy, expressed as mock content
 * entries + config that feed `buildSidebarTree`:
 *
 *   (a) AI synthetic section — a manual group with a `landing` (/ai/models/)
 *       and no page at the bare /ai/ segment.
 *   (b) learning-paths index-less module groups — folders with no index page,
 *       so their groups carry no `indexHref` (non-interactive crumbs).
 *   (c) a versioned `docs-v0` shape for the D6 version-prefix tests.
 *
 * No Cloudflare strings leak into framework source — they live here only.
 */

export type Entry = { id: string; data: { title: string; sidebar?: Record<string, unknown> } };

// (b) learning-paths: a wrapper section + two index-less module folders.
// Note: no `learning-paths/index`, no `learning-paths/workers/index` —
// module groups are deliberately index-less.
export const lpEntries: Entry[] = [
  { id: "learning-paths/workers/series/intro", data: { title: "Intro", sidebar: { order: 1 } } },
  { id: "learning-paths/workers/series/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
  { id: "learning-paths/dns/series/setup", data: { title: "Setup", sidebar: { order: 1 } } },
];

export const lpConfig = {
  items: [
    { label: "Learning paths", items: [{ autogenerate: { directory: "learning-paths" } }] },
  ],
  scope: "section",
} as const;

// (a) AI synthetic section — pages live under /ai/models/, nothing at /ai/.
export const aiEntries: Entry[] = [
  { id: "ai/models/runwayml/gen-4", data: { title: "Gen-4", sidebar: { order: 1 } } },
  { id: "ai/models/openai/gpt", data: { title: "GPT", sidebar: { order: 2 } } },
];

// AI config uses a manual group with the Phase-3 `segment`/`landing` keys.
export const aiConfig = {
  items: [
    {
      label: "AI",
      segment: "/ai",
      landing: "/ai/models/",
      items: [{ label: "Models", link: "/ai/models/" }],
    },
  ],
} as const;

// (c) versioned shape — a `docs-v0` collection mounted at /v0.
export const v0Entries: Entry[] = [
  { id: "getting-started", data: { title: "Getting started", sidebar: { order: 1 } } },
  { id: "guides/deploy", data: { title: "Deploy", sidebar: { order: 2 } } },
];
