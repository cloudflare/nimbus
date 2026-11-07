import {
  mount,
  SHORTCUTS_CHANGE,
  setSingleKeyShortcutsEnabled,
  singleKeyShortcutsEnabled,
  syncShortcutHints,
} from "@cloudflare/nimbus-docs/client";

// The switch flips itself; this keeps it and the reader's setting in step.
mount("[data-nb-shortcuts-toggle]", (button) => {
  const sync = () => button.setAttribute("aria-checked", String(singleKeyShortcutsEnabled()));
  const change = () => setSingleKeyShortcutsEnabled(button.getAttribute("aria-checked") === "true");
  sync();
  // The rest of the page follows the switch: hints hide, `aria-keyshortcuts` go.
  syncShortcutHints();
  button.addEventListener("change", change);
  document.addEventListener(SHORTCUTS_CHANGE, sync);
  return () => {
    button.removeEventListener("change", change);
    document.removeEventListener(SHORTCUTS_CHANGE, sync);
  };
});
