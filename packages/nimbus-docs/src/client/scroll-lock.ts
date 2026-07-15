/**
 * scroll-lock.ts — Body scroll lock with scrollbar-width compensation.
 *
 * Prevents background scrolling when a modal/overlay is open.
 * Compensates for the scrollbar disappearing to avoid layout shift
 * (visible on Windows/Linux where scrollbars have width).
 *
 * Uses a data attribute + CSS for the overflow lock, and inline
 * paddingRight for the scrollbar compensation.
 *
 * Used by: Dialog (and any future overlay primitive).
 */

const ATTR = "data-scroll-locked";

let lockCount = 0;
let savedPaddingRight = "";

export function lockScroll(): void {
  lockCount++;
  if (lockCount > 1) return;

  const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
  savedPaddingRight = document.body.style.paddingRight;

  document.body.setAttribute(ATTR, "");
  if (scrollbarW > 0) {
    document.body.style.paddingRight = `${scrollbarW}px`;
  }
}

export function unlockScroll(): void {
  if (lockCount === 0) return;
  lockCount--;
  if (lockCount > 0) return;

  document.body.removeAttribute(ATTR);
  document.body.style.paddingRight = savedPaddingRight;
}
