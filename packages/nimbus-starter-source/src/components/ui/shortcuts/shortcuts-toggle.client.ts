import {
  mount,
  SHORTCUTS_CHANGE,
  setSingleKeyShortcutsEnabled,
  singleKeyShortcutsEnabled,
  syncShortcutHints,
} from "@cloudflare/nimbus-docs/client";

mount("[data-nb-shortcuts-toggle]", (button) => {
  const sync = () => button.setAttribute("aria-pressed", String(singleKeyShortcutsEnabled()));
  const toggle = () => setSingleKeyShortcutsEnabled(!singleKeyShortcutsEnabled());
  sync();
  // The rest of the page follows the switch: hints hide, `aria-keyshortcuts` go.
  syncShortcutHints();
  button.addEventListener("click", toggle);
  document.addEventListener(SHORTCUTS_CHANGE, sync);
  return () => {
    button.removeEventListener("click", toggle);
    document.removeEventListener(SHORTCUTS_CHANGE, sync);
  };
});
