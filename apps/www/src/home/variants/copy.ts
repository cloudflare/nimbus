export const cmd = "npx @cloudflare/create-nimbus-docs@latest";

export const hero = {
  line1: "Meet Nimbus",
  line2: "The authoring tool for docs",
  body: "Documentation is now written by people and agents, and read by both. Nimbus is the authoring tool built for that: one workflow, native tools for each kind of author, and quality that holds all the way to publish.",
};

export const sections = {
  write: {
    label: "Write",
    h1: "Write with people. Write with agents.",
    h2: "One standard for every page.",
    body: "Write in your repo, in your editor, or in the tools your team already uses. Hand a change to an agent and get a draft back in your structure and your voice, or write it yourself. Review it, ship it when it's right. Nimbus gives each author the tools they need and holds every page to the same standard.",
    cards: [
      { title: "Human-native", body: "Interactive diagrams, reusable snippets, tabs that remember the reader's choice. The things that make a page worth reading, built in.", shot: "An interactive diagram inside a docs page.", for: "People", ships: "Built in" },
      { title: "Built for agents", body: "Briefs an agent can act on, checks it can read as data, a site it can reason about. Any agent is a first-class author. None is required.", shot: "An agent drafting a page from a brief.", for: "Agents", ships: "Built in" },
      { title: "Quality that holds", body: "Every page is checked before it ships and tagged while it's a draft. Nothing is trusted just because it rendered.", shot: "A draft page with its badge, and the check that cleared it.", for: "Both", ships: "Built in" },
    ],
  },
  read: {
    label: "Read",
    h1: "Agent-native docs.",
    h2: "One page, served the way each reader needs it.",
    body: "Every page you publish is also served as Markdown at the same address, with a site index an agent can read first. No second pipeline, no export step. One source, both readers.",
    shot: "The same page twice: rendered for a person, and as the Markdown an agent receives.",
  },
  own: {
    label: "Own",
    h1: "Nothing to fork. Nothing to wait on.",
    h2: "It's your site. All of it.",
    body: "The scaffold puts the whole site in your repo. Layouts, components, styles, routes and content are plain files you edit. Nimbus stays an npm dependency underneath, so an upgrade changes the dependency and leaves your files alone.",
    shot: "A scaffolded site before and after an edit to globals.css: same content, a different house style.",
  },
  extend: {
    label: "Extend",
    h1: "Add what you need, when you need it.",
    h2: "Components land as files. Features land as briefs.",
    body: "The registry installs in two modes. Components copy into your repo as source. Features arrive as a brief that an agent applies to your site.",
    component: { title: "Component", sub: "Resolves its dependencies and lands as files.", lines: ["$ nimbus-docs add accordion", "Resolving accordion → collapsible, cn", "wrote src/lib/cn.ts", "wrote src/components/ui/collapsible/", "wrote src/components/ui/accordion/"] },
    feature: { title: "Feature", sub: "Prints a brief. An agent applies it to your site.", lines: ["$ nimbus-docs add changelog --print", "# Feature: changelog", "Add a dated /changelog feed with tags, RSS and permalinks.", "1. Register a changelog collection in content.config.ts", "2. Add src/pages/changelog/ using the site's DocsLayout…"] },
  },
  ship: {
    label: "Ship",
    h1: "Type one line. Five minutes later, your docs are live.",
    h2: "Not a theme you rent. A site you own.",
    body: "One command. A few questions. A complete documentation site lands in your repo, and it already does everything on this list. Deploy it anywhere. On Cloudflare, that's one more line.",
    tilesLabel: "It comes with everything.",
    tiles: [
      { name: "Agents", body: "Markdown for every page and a site‑wide index." },
      { name: "MCP server", body: "Your docs as a tool agents can call." },
      { name: "AI search", body: "Ask the docs. Get an answer." },
      { name: "API reference", body: "From your OpenAPI spec. Every endpoint." },
      { name: "Try it", body: "Run API calls from the page." },
      { name: "Content loaders", body: "Write in the tools your team already uses." },
      { name: "Diagrams", body: "Interactive. Yours to style." },
      { name: "Versions", body: "Ship v2 while v1 stays live." },
    ],
  },
};

export const variants = [
  { id: "a", name: "Restraint", note: "Statements and plain lists. No tiles, one figure." },
  { id: "e", name: "Product first", note: "One window with tabs under the hero, then short sections." },
  { id: "g", name: "Synthesis", note: "Product window under the hero as a card, editorial cards below, a plain list to ship." },
  { id: "j", name: "Agent first", note: "One page for four readers in the hero; install is one line pasted into any agent; the workflow as a transcript." },
  { id: "k", name: "Editorial", note: "A showcase strip of sites, then what's new as dated cards. The roadmap becomes content." },
  { id: "m", name: "Two workflows", note: "People and agents as two columns on one shared window, a feature strip, a results panel." },
  { id: "n", name: "Story", note: "Sticky list of the five verbs, one stage each, then the fine print." },
  { id: "q", name: "Bento", note: "J's hero with real mocks, then the whole product as one bento grid." },
  { id: "u", name: "Bento, alive", note: "Q's bento where every cell is a small stage: a window bleeding off the edge, a control overlapping it, and it works." },
  { id: "v", name: "Combined", note: "The story with screenshot placeholders: Write, Read, Own, Extend. Then the interactive bento, quotes, fine print, Ship." },
  { id: "t", name: "Playground", note: "A CLI hero you can operate, the registry as a catalog, a wall of quotes." },
];
