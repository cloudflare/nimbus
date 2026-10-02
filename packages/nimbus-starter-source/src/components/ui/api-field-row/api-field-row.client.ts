/** Wires each API field group: expand/collapse-all + hash deep-linking, and the
 *  { n properties } buttons that toggle each row's <details>. */

import { mount, initDisclosureGroup } from "@cloudflare/nimbus-docs/client";

mount("[data-api-section]", (root) => {
  const instance = initDisclosureGroup({
    root,
    toggleAll: root.querySelector<HTMLElement>("[data-api-toggle-all]"),
    deepLink: true,
  });
  return () => instance.destroy();
});

// The row's <details> is a sibling of the signature line holding the button.
const rowDetails = (el: Element) =>
  el.closest(".fl-body")?.querySelector<HTMLDetailsElement>(":scope > details.fl-expandable");

document.addEventListener("click", (event) => {
  const button = (event.target as Element).closest?.("[data-fl-toggle]");
  const details = button && rowDetails(button);
  if (details) details.open = !details.open;
});

// Keep aria-expanded true to the details, however it was toggled (button,
// Expand all, deep link, find-in-page).
document.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.matches(".fl-expandable")) return;
    details.parentElement
      ?.querySelector(":scope > .fl-sig [data-fl-toggle]")
      ?.setAttribute("aria-expanded", String(details.open));
  },
  true,
);
