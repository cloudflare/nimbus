/**
 * Ambient declarations for virtual modules referenced from this package.
 *
 *   - `virtual:nimbus/config` — emitted by the integration's Vite plugin
 *     at build time; resolves at runtime in the consuming Astro project.
 *   - `astro:content` — Astro's content-layer virtual module, generated
 *     per-project from the user's `content.config.ts`. Stubbed here so
 *     this package typechecks in isolation. Consuming projects have
 *     Astro's project-emitted types take precedence via TS declaration
 *     merging — the shapes below match Astro's public API for the
 *     subset this package consumes.
 *
 * This file has no top-level imports/exports so the declarations are
 * ambient (resolvable from dynamic `await import("…")` calls, not just
 * static imports).
 */

declare module "virtual:nimbus/config" {
  export const config: import("../types.js").NimbusConfig;
  export const indexedCollections: readonly string[];
  export const versionAlternates: import("../_internal/version-alternates.js").VersionAlternatesTable;
}

declare module "astro:content" {
  // In a real project this is `keyof DataEntryMap` (the union of every
  // registered collection name). Stubbed loose here so the package
  // typechecks in isolation; the consumer's project-emitted types take
  // precedence via declaration merging.
  export type CollectionKey = string;

  export interface CollectionEntry<C extends string = string> {
    id: string;
    collection: C;
    data: Record<string, unknown>;
    body?: string;
  }

  export interface SchemaContext {
    image: () => unknown;
  }

  export function getCollection<C extends string = string>(
    collection: C,
    filter?: (entry: CollectionEntry<C>) => boolean,
  ): Promise<CollectionEntry<C>[]>;

  export function render(entry: CollectionEntry<string>): Promise<{
    Content: import("astro/runtime/server/index.js").AstroComponentFactory;
    headings: { depth: number; text: string; slug: string }[];
  }>;
}

// Vite extends `ImportMeta` with `env`. Astro inherits this. Declared here
// so isolated-package tsc can resolve `import.meta.env.PROD`; consuming
// projects already have Vite's identical declaration via @types augmentation.
interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly SSR: boolean;
  readonly BASE_URL: string;
  readonly [key: string]: unknown;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
