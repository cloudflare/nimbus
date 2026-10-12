/** Wraps each content image that would get meaningfully bigger in a button
 *  that opens it in the zoom dialog, and keeps that right as images load,
 *  appear (a tab or disclosure opening) or the viewport changes. */

import { lockScroll, mount, unlockScroll } from "@cloudflare/nimbus-docs/client";

// Below this gain, zooming isn't worth a button (a phone screenshot already
// fills the column).
const MIN_GAIN = 1.2;
const TRIGGER = "[data-nb-zoom-trigger]";

mount("[data-nb-image-zoom]", (root) => {
  const dialog = root as HTMLDialogElement;
  const content = document.querySelector<HTMLElement>("article.docs-content");
  const initial = dialog.querySelector<HTMLElement>(".nb-zoom-img");
  if (!content || !initial) return () => {};
  let media: HTMLElement = initial;
  let opener: HTMLElement | null = null;

  const worthZooming = (img: HTMLImageElement): boolean => {
    if (img.closest(`a, button:not(${TRIGGER}), [data-nb-zoom="off"]`)) return false;
    // The dialog shows the file at its own size, which can beat the attribute.
    const width = Math.max(Number(img.getAttribute("width")) || 0, img.naturalWidth);
    const height = Math.max(Number(img.getAttribute("height")) || 0, img.naturalHeight);
    if (!width || !height) return false;
    const shown = img.getBoundingClientRect().width;
    if (!shown) return false;
    const fit = Math.min((innerWidth * 0.95) / width, (innerHeight * 0.95) / height, 1);
    return width * fit >= shown * MIN_GAIN;
  };

  const wrap = (img: HTMLImageElement, display: string) => {
    const target = img.parentElement instanceof HTMLPictureElement ? img.parentElement : img;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-nb-zoom-trigger", "");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", img.alt ? `Enlarge image: ${img.alt}` : "Enlarge image");
    button.style.display = display === "inline" ? "inline-block" : "block";
    target.replaceWith(button);
    button.append(target);
  };

  const images = [...content.querySelectorAll<HTMLImageElement>("img")];
  // All measuring first, then all DOM changes, so layout runs once.
  const sync = () => {
    const plan = images.map((img) => {
      const trigger = img.closest<HTMLElement>(TRIGGER);
      const zoom = worthZooming(img);
      const target = img.parentElement instanceof HTMLPictureElement ? img.parentElement : img;
      return { img, trigger, zoom, display: zoom && !trigger ? getComputedStyle(target).display : "" };
    });
    for (const { img, trigger, zoom, display } of plan) {
      if (zoom && !trigger) wrap(img, display);
      else if (!zoom && trigger) trigger.replaceWith(...trigger.childNodes);
    }
  };

  const open = (trigger: HTMLElement) => {
    const img = trigger.querySelector("img");
    if (!img) return;
    // A clone of the image or its <picture>, sized for the viewport, so the
    // browser picks the largest source that fits.
    const source = img.parentElement instanceof HTMLPictureElement ? img.parentElement : img;
    const clone = source.cloneNode(true) as HTMLElement;
    const view = clone instanceof HTMLImageElement ? clone : clone.querySelector("img")!;
    for (const el of [clone, ...clone.querySelectorAll("source, img")]) {
      if (el.hasAttribute("srcset")) el.setAttribute("sizes", "100vw");
    }
    for (const name of ["loading", "width", "height", "style", "class"]) view.removeAttribute(name);
    view.className = "nb-zoom-img";
    media.replaceWith(clone);
    media = clone;
    opener = trigger;
    dialog.showModal();
    lockScroll();
  };

  const onContentClick = (event: MouseEvent) => {
    const trigger = (event.target as Element).closest<HTMLElement>(TRIGGER);
    if (trigger && content.contains(trigger)) open(trigger);
  };
  // Esc, the close button, or a click anywhere closes it.
  const onDialogClick = () => dialog.close();
  const onClose = () => {
    unlockScroll();
    opener?.focus();
    opener = null;
  };
  // An image's box changes when it loads, when a hidden tab or disclosure
  // shows it, and when the viewport does; the viewport also moves the cap.
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };
  const observer = new ResizeObserver(schedule);
  for (const img of images) observer.observe(img);

  content.addEventListener("click", onContentClick);
  dialog.addEventListener("click", onDialogClick);
  dialog.addEventListener("close", onClose);
  addEventListener("resize", schedule);

  return () => {
    content.removeEventListener("click", onContentClick);
    dialog.removeEventListener("click", onDialogClick);
    dialog.removeEventListener("close", onClose);
    removeEventListener("resize", schedule);
    observer.disconnect();
    cancelAnimationFrame(frame);
    // `close` fires later, after the page has gone; release the lock now.
    if (dialog.open) {
      dialog.close();
      unlockScroll();
    }
  };
});
