/** Shows the search shortcut as this platform writes it (⌘K on macOS, Ctrl K elsewhere). */

import { mount, syncShortcutHints } from "@cloudflare/nimbus-docs/client";

mount("[data-search-trigger]", (btn) => {
  syncShortcutHints(btn);
  return () => {};
});
