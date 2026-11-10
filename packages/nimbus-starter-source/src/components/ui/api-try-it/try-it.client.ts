/**
 * The Try it button. The panel and its plan load on the first click; until
 * then nothing else runs. Without JavaScript the button stays hidden.
 */
import { mount } from "@cloudflare/nimbus-docs/client";

type Panel = { open(): void; destroy(): void };

mount("[data-nb-tryit-open]", (button) => {
  if (!(button instanceof HTMLButtonElement)) return () => {};
  button.hidden = false;
  let panel: Panel | null = null;
  let loading = false;
  const onClick = async () => {
    if (panel) return panel.open();
    if (loading) return;
    loading = true;
    button.setAttribute("aria-busy", "true");
    const label = button.textContent;
    try {
      const { createPanel } = await import("./panel");
      panel = await createPanel(button);
      panel.open();
      button.textContent = label;
    } catch {
      // The form couldn't load: say so on the button; a click retries.
      button.textContent = "Couldn't load the request form. Retry";
    } finally {
      loading = false;
      button.removeAttribute("aria-busy");
    }
  };
  button.addEventListener("click", onClick);
  return () => {
    button.removeEventListener("click", onClick);
    panel?.destroy();
  };
});
