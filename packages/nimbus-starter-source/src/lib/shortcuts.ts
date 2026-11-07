import type { Shortcuts } from "@cloudflare/nimbus-docs/client";

/**
 * Keyboard shortcuts. Change a key, or set it to `false` to remove it.
 * `Mod` is ⌘ on macOS and Ctrl elsewhere. Readers can turn single-key
 * shortcuts (no Ctrl, ⌘ or Alt) off from the search dialog.
 */
export const shortcuts = {
  search: "Mod+K",
  filterSidebar: "/",
  previousPage: "[",
  nextPage: "]",
} satisfies Shortcuts;
