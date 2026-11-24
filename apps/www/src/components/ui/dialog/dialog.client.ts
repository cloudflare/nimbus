import { lockScroll, mount, unlockScroll } from "@cloudflare/nimbus-docs/client";

mount("[data-dialog]", (root) => {
  if (!(root instanceof HTMLDialogElement)) return () => {};
  const dialog = root;

  const sync = () => (dialog.open ? lockScroll() : unlockScroll());
  const observer = new MutationObserver(sync);
  observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });

  // Close on a backdrop click only when the press started there too: a text
  // selection dragged out of the dialog ends with a click on the backdrop.
  let pressedOn: EventTarget | null = null;
  const onPress = (e: PointerEvent) => {
    pressedOn = e.target;
  };
  const onBackdrop = (e: MouseEvent) => {
    if (e.target === dialog && pressedOn === dialog) dialog.close();
    pressedOn = null;
  };
  dialog.addEventListener("pointerdown", onPress);
  dialog.addEventListener("click", onBackdrop);

  return () => {
    observer.disconnect();
    dialog.removeEventListener("pointerdown", onPress);
    dialog.removeEventListener("click", onBackdrop);
    // A swap while open never fires `close`; balance the scroll lock.
    if (dialog.open) unlockScroll();
  };
});
