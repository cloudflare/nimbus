---
"nimbus-docs": minor
"create-nimbus-docs": minor
---

Ship the static agent-surface layer: full corpus, raw-source twins, version labels

- **`/llms-full.txt`** — the whole published site as one deterministic
  markdown document, via the new `renderCorpusMarkdown()` helper behind a
  ten-line starter route. Scope matches the root `llms.txt` (primary +
  secondary collections, non-current doc versions excluded); collation is
  sorted and timestamp-free, so output is byte-identical across rebuilds.
  `/llms.txt` links to it.
- **Raw-source twin at `<page>/index.mdx`** — the authored MDX body served
  verbatim with the same canonical frontmatter block as the `.md` twin.
  Twin grammar: `index.md` is the downleveled render for reading,
  `index.mdx` is the source. The `.md` twin's `Source:` line now points at
  the `.mdx` twin instead of itself.
- **`IndexedEntry` gains `sourceUrl`** (site-relative URL of the raw-source
  twin; `undefined` for entries without a string body) **and `version`**
  (the entry's version label resolved from the `versions` manifest;
  `undefined` on unversioned sites and non-docs collections). On versioned
  sites every twin's frontmatter carries a `version:` label so agents can
  pin a version; unversioned sites are byte-for-byte unchanged.
- **`astro` peer range is now `>=6.4.0 <7.0.0`**, declaring the Astro 6
  requirement that `@astrojs/mdx@6` always implied. Astro 7 support lands
  as its own release.
