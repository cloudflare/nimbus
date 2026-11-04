import { MANIFESTS } from "../../registry/manifests";
import { STARTER_MANIFEST } from "../../../../packages/nimbus-starter-source/starter.manifest.mjs";

/**
 * Where a component comes from, for its Installation section: the package
 * itself, the starter every new site ships, or the registry, installed with
 * `nimbus-docs add`. Shared by the page and its Markdown.
 */
export type InstallState = "builtin" | "included" | "install";

export function installState(slug: string): InstallState {
  const manifest = MANIFESTS[slug as keyof typeof MANIFESTS];
  if (!manifest || manifest.type !== "registry:ui") return "builtin";
  return (STARTER_MANIFEST.registryOnlyComponents as readonly string[]).includes(slug) ? "install" : "included";
}

/** The name the catalog shows: the manifest's title for registry components. */
export function componentName(slug: string, fallback: string): string {
  const manifest = MANIFESTS[slug as keyof typeof MANIFESTS];
  return manifest?.type === "registry:ui" ? manifest.title : fallback;
}
