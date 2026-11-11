/**
 * The Try it button. The panel and its plan load on the first press (from the
 * moment a finger or button goes down); until then nothing else runs. Without JavaScript the button is hidden (try-it-button.css).
 */
import { mount } from "@cloudflare/nimbus-docs/client";

type Panel = { open(): void; destroy(): void };

mount("[data-nb-tryit-open]", (button) => {
  if (!(button instanceof HTMLButtonElement)) return () => {};
  let panel: Panel | null = null;
  let loading = false;
  let gone = false;
  // A press starts the load, so the click that follows waits less.
  let code: Promise<typeof import("./panel")> | null = null;
  // A load that failed (offline) is forgotten, so the next press or key tries again.
  const load = () =>
    (code ??= import("./panel").catch((error: unknown) => {
      code = null;
      throw error;
    }));
  const onPress = () => void load().catch(() => {});
  const onClick = async () => {
    if (panel) return panel.open();
    if (loading) return;
    loading = true;
    button.setAttribute("aria-busy", "true");
    const label = button.textContent;
    try {
      const { createPanel } = await load();
      const created = await createPanel(button);
      // The page moved on while the form loaded: don't leave it behind.
      if (gone) return created.destroy();
      panel = created;
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
  button.addEventListener("pointerdown", onPress);
  button.addEventListener("click", onClick);
  return () => {
    gone = true;
    button.removeEventListener("pointerdown", onPress);
    button.removeEventListener("click", onClick);
    panel?.destroy();
  };
});
