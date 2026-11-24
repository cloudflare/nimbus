import { mount } from "@cloudflare/nimbus-docs/client";

// A click flips the switch and tells the page with a bubbling `change` event.
mount("[data-nb-switch]", (button) => {
  const flip = () => {
    button.setAttribute("aria-checked", String(button.getAttribute("aria-checked") !== "true"));
    button.dispatchEvent(new Event("change", { bubbles: true }));
  };
  button.addEventListener("click", flip);
  return () => button.removeEventListener("click", flip);
});
