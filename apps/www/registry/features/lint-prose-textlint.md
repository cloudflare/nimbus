---
{
  "name": "lint-prose-textlint",
  "type": "registry:feature",
  "title": "Prose linting with textlint",
  "description": "Add textlint with write-good, alex, and terminology rules — npm-native prose linting that runs alongside nimbus-docs lint.",
  "markers": [".textlintrc"]
}
---

# Prose linting with textlint

You are wiring [textlint](https://textlint.org) into a Nimbus docs site so it catches weasel words, passive voice, insensitive language, and capitalization issues that `nimbus-docs lint` doesn't cover. textlint runs as a sibling tool — separate CLI, separate config — because the two layers don't overlap.

Read this whole file before touching anything.

## What to add

### 1. Drop `.textlintrc` at the project root

Create `.textlintrc` next to `astro.config.ts` with these contents:

```json
{
  "plugins": {
    "@textlint/markdown": { "extensions": [".md"] },
    "mdx": { "extensions": [".mdx"] }
  },
  "rules": {
    "write-good": {
      "weasel": true,
      "passive": true,
      "tooWordy": true,
      "adverb": true,
      "cliches": true,
      "illusion": true,
      "thereIs": true,
      "so": true,
      "eprime": false
    },
    "alex": {
      "allow": ["easy", "simple", "obvious", "straightforward", "just"]
    },
    "terminology": {
      "defaultTerms": true
    }
  }
}
```

What each block does:

- `plugins` — `@textlint/markdown` parses `.md`; `textlint-plugin-mdx` parses `.mdx` including JSX, imports, and inline code. No bridge or remap needed.
- `write-good` — weasel words, passive voice, wordiness, adverbs, cliches, illusions. The `eprime: false` is deliberate — eprime forbids any "to be" verb and is too restrictive for tech docs.
- `alex` — inclusive language (catches `whitelist`/`blacklist`/etc.). The `allow` list silences common dev-doc false positives (`easy`, `simple`, `obvious`, `straightforward`, `just`) while keeping the real catches.
- `terminology.defaultTerms` — capitalization conventions (e.g. `yarn` → `Yarn`, `javascript` → `JavaScript`). Auto-fixable.

### 2. Add the devDependencies and script

Edit the user's `package.json`:

In `devDependencies`, add:

```json
{
  "textlint": "^14.0.0",
  "textlint-plugin-mdx": "^1.0.1",
  "textlint-rule-write-good": "^2.0.0",
  "textlint-rule-alex": "^5.0.0",
  "textlint-rule-terminology": "^5.2.0"
}
```

In `scripts`, add both of these:

```json
{
  "lint:prose": "textlint 'src/content/**/*.{md,mdx}'",
  "lint:prose:fix": "textlint --fix 'src/content/**/*.{md,mdx}'"
}
```

Two scripts because pnpm's flag forwarding (`pnpm lint:prose -- --fix`) is unreliable across versions and shells — a sibling `:fix` script is the standard idiom (ESLint, prettier, etc.) and avoids the footgun.

If the user already has a `lint` script (ESLint, etc.), leave it alone — keep prose under its own namespace. To chain prose into the main lint flow: `"lint": "eslint && nimbus-docs lint && pnpm lint:prose"`.

### 3. Install

```sh
pnpm install
```

That's the entire installation. No system tools, no global state, no separate sync step.

## Verification

From the project root:

```sh
pnpm lint:prose
```

You should see colored diagnostics with file paths, line and column numbers, and rule IDs. Exit code is `0` if clean, `1` if there are diagnostics.

Try it on a clean file — confirm zero output. Try it on a file with `firstly` or `whitelist` — confirm hits land on the right lines.

Auto-fix mode:

```sh
pnpm lint:prose:fix
```

The `terminology` rule has surgical fixes (capitalization) and `--fix` applies them. `write-good` and `alex` are detect-only — they still appear in the report after fix.

JSON output for agent loops:

```sh
pnpm exec textlint --format=json 'src/content/**/*.{md,mdx}'
```

## What to tell the user

Be upfront about the trade-offs:

- **No brand-style enforcement.** This recipe ships `write-good` + `alex` + `terminology` only. If the user wants Microsoft / Google / GitLab style enforcement, that's Vale territory; textlint doesn't have first-class equivalents.
- **textlint runs separately from `nimbus-docs lint`.** Two CLIs, two reports. The rule sets don't overlap — `nimbus-docs lint` covers structural rules (frontmatter, internal links, heading hierarchy, sidebar correctness), textlint covers prose style. Both layers are opt-in independently.
- **Per-line / per-file disables are textlint-native.** Comments like `<!-- textlint-disable write-good -->` and `<!-- textlint-disable-next-line alex -->` work. They have nothing to do with `nimbusDisableRules`.
- **Adding more rules.** textlint's ecosystem is on npm. `pnpm add -D textlint-rule-<name>` and add to `.textlintrc.rules`. We're shipping a conservative baseline; the user expands from there.

Do **not** add a `prose` TypeScript option to `astro.config.ts`. Do not wire textlint into `nimbus-docs lint`. Do not build any framework code. The whole feature lives in the user's `.textlintrc` and `package.json`.
