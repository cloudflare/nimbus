/**
 * Single source of truth for the drift policy between the fat starter
 * source and the thin shipped templates.
 *
 * `packages/nimbus-starter-source/` is the *fat* tree (every component,
 * dev-only routes, kitchen-sink demo content). The shipped templates
 * under `packages/create-nimbus-docs/template{,-empty}/` are *thin*
 * derived artifacts emitted by `packages/create-nimbus-docs/scripts/copy-template.mjs`.
 *
 * The generator reads this manifest and uses it to decide what to strip
 * (registry-only components, dev-only routes) and what to replace
 * (per-template content overrides).
 *
 * Written as `.mjs` (with JSDoc types) so both the plain-node generator
 * and the tsx-run registry generator can import it without ts-tooling
 * gymnastics.
 *
 * @typedef {Object} TemplateVariant
 * @property {string} contentDir Path under packages/nimbus-starter-source/
 *   whose contents replace src/content/docs/ for that variant.
 *
 * @typedef {Object} StarterManifest
 * @property {string[]} registryOnlyComponents UI slugs present in the
 *   fat tree but not shipped to users by default; installable via
 *   `nimbus-docs add <slug>`. Must align with the registry:ui entries
 *   in apps/www/registry/manifests.ts that are not in the day-1 set.
 * @property {string[]} registryOnlyPaths Path prefixes (relative to the
 *   starter root) present in the fat tree as registry source but stripped
 *   from shipped templates; delivered via `nimbus-docs add <slug>`.
 * @property {string[]} registryOnlyDependencies package.json dependency
 *   names that the fat tree needs (the kitchen-sink builds the registry
 *   source) but which are dead weight in shipped templates because the
 *   code that uses them lives under `registryOnlyPaths`. Stripped from the
 *   template package.json; re-added by the registry slug that ships the
 *   corresponding source via `nimbus-docs add <slug>`.
 * @property {string[]} devOnlyPaths Path prefixes (relative to the
 *   starter root) stripped from shipped templates. Use directory paths
 *   ending with "/" to filter whole trees.
 * @property {string[]} declinedBuildScripts Dependency names whose install
 *   scripts the generator declines in the shipped template's
 *   pnpm-workspace.yaml (pnpm's build-scripts gate). Named exactly, never a
 *   blanket approval; both ship working prebuilds.
 * @property {Record<string, TemplateVariant>} templates Per-template
 *   content overrides. Key = output dir name under create-nimbus-docs/
 *   (e.g. "template" → packages/create-nimbus-docs/template/).
 */

/** @type {StarterManifest} */
export const STARTER_MANIFEST = {
  registryOnlyComponents: [
    "accordion",
    "callout",
    "code-group",
    "embed",
    "file-tree",
    "frame",
    "link-card",
    "popover",
    "version-switcher",
  ],

  // React diagram chrome ships via the `diagram` / `diagram-scene`
  // registry slugs (which also add the react deps), never in day-1
  // templates. The fat tree keeps it as the registry source.
  registryOnlyPaths: ["src/components/react/"],

  // React is only imported by the `src/components/react/` tree above (and
  // referenced inside a fenced example in components.mdx, which never
  // executes). With that tree stripped, these deps are dead weight in the
  // shipped template — the `diagram` registry slug re-adds them on install.
  registryOnlyDependencies: [
    "react",
    "react-dom",
    "@types/react",
    "@types/react-dom",
  ],

  // Add path prefixes here (ending with "/") to strip whole trees from
  // shipped templates while keeping them in the canonical kitchen-sink
  // dev tree. Empty by default.
  devOnlyPaths: [],

  // Install scripts declined in shipped templates to clear pnpm's build-scripts
  // gate. Both ship prebuilds, so declining is strictly narrower than allowing.
  declinedBuildScripts: ["esbuild", "sharp"],

  templates: {
    template: {
      // The default template ships the kitchen-sink content (welcome /
      // getting-started / components). Reusing src/content/docs/ keeps
      // a single canonical copy; no override needed.
      contentDir: "src/content/docs/",
    },
    "template-empty": {
      contentDir: "templates/empty/content/docs/",
    },
  },
};
