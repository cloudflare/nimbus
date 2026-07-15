/**
 * code-copy.ts — Injects a Nimbus-styled copy button into every Shiki
 * code block rendered by Astro's built-in `<Code>` and fenced
 * code blocks in MDX.
 *
 * Astro emits `<pre class="astro-code shiki ...">` for syntax-highlighted
 * blocks. We attach a copy button positioned in the top-right corner.
 *
 * Page-wide enhancement, not tied to a single component. Call `codeCopy()`
 * once (e.g. from BaseLayout). Uses `mount` for lifecycle so the buttons
 * are torn down on view transitions and re-added against the new DOM.
 *
 * The original code text comes from the `<code>` element's textContent —
 * Shiki's wrapper spans flatten down to the raw source.
 *
 * Code blocks rendered inside [data-cg-row] (CodeGroup) are skipped
 * because CodeGroup brings its own copy button per panel.
 */

import { mount } from "./mount";

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>`;
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34Z"/></svg>`;

function getCodeText(pre: HTMLElement): string {
  const codeEl = pre.querySelector<HTMLElement>("code");
  return codeEl?.textContent ?? pre.textContent ?? "";
}

function initCodeCopy(pre: HTMLElement): () => void {
  // Skip code blocks owned by CodeGroup. `data-cg-panels-raw` is SSR'd
  // (catches pres before CodeGroup's client script reparents them);
  // `data-cg-row` catches them after reparenting.
  if (pre.closest("[data-cg-panels-raw], [data-cg-row]")) return () => {};

  // Append the button to the figure wrapper, not the pre. The pre has
  // `overflow-x: auto`, and absolutely-positioned children of overflow:auto
  // containers slide along with horizontal scroll on iOS Safari. The figure
  // is the non-scrolling wrapper emitted by titleAndLangTransformer.
  const host = (pre.closest(".nb-code-figure") as HTMLElement | null) ?? pre;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nb-code-copy";
  btn.setAttribute("aria-label", "Copy code to clipboard");
  btn.innerHTML = COPY_ICON;

  let resetTimer: number | undefined;

  async function handleClick() {
    const text = getCodeText(pre);
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }

    btn.innerHTML = CHECK_ICON;
    btn.dataset.state = "copied";
    btn.setAttribute("aria-label", "Copied!");

    if (resetTimer) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      delete btn.dataset.state;
      btn.setAttribute("aria-label", "Copy code to clipboard");
    }, 1500);
  }

  btn.addEventListener("click", handleClick);

  // Pure write, never a read. Reading `getComputedStyle(host).position` here —
  // right after appending the previous block's button — forces a synchronous
  // style/layout recalc on every iteration (a forced reflow). On pages with
  // hundreds of code blocks that compounds into multi-second main-thread hangs.
  // Both possible hosts (`pre.astro-code` and `.nb-code-figure`) are already
  // `position: relative` via CSS, so the assignment is idempotent; set it
  // unconditionally to keep the appends batched into a single recalc.
  host.style.position = "relative";
  host.appendChild(btn);

  return () => {
    if (resetTimer) window.clearTimeout(resetTimer);
    btn.removeEventListener("click", handleClick);
    btn.remove();
  };
}

/** Wire copy buttons onto all Shiki code blocks on the page. Call once. */
export function codeCopy(): void {
  mount("pre.astro-code", initCodeCopy);
}
