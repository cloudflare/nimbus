/** Add hoverable self-links to markdown headings with ids. */

let liveRegion: HTMLElement | null = null;

/**
 * Singleton polite live region for the "copied" announcement.
 * Visually hidden via inline styles so the framework doesn't depend on
 * a starter utility class.
 */
function announce(message: string) {
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    Object.assign(liveRegion.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      padding: "0",
      margin: "-1px",
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
      border: "0",
    });
    document.body.appendChild(liveRegion);
  }
  // Clear first so repeating the same message re-announces.
  liveRegion.textContent = "";
  liveRegion.textContent = message;
}

function applyHeadingAnchors() {
  document.querySelectorAll<HTMLElement>(".docs-content :is(h2, h3, h4)[id]").forEach((heading) => {
    if (heading.hasAttribute("data-heading-anchor-ready")) return;
    heading.setAttribute("data-heading-anchor-ready", "true");

    const link = document.createElement("a");
    link.href = `#${heading.id}`;
    link.className = "heading-anchor";
    link.setAttribute("aria-label", `Copy link to ${heading.textContent?.trim() ?? "section"}`);
    link.textContent = "#";

    // Copy the deep link on click. Default navigation is preserved so
    // the URL bar updates; the clipboard write rides alongside. No-op
    // outside secure contexts.
    link.addEventListener("click", () => {
      const url = new URL(link.getAttribute("href") ?? `#${heading.id}`, location.href).href;
      navigator.clipboard?.writeText(url).then(
        () => announce("Link copied to clipboard"),
        () => {},
      );
    });

    heading.appendChild(link);
  });
}

/**
 * Add hoverable `#` self-links to all `h2`–`h4` headings in `.docs-content`.
 * Clicking one navigates (hash) *and* copies the absolute deep link, with an
 * `aria-live` announcement for screen readers. Re-runs on `astro:page-load`
 * for View Transitions. Call once (e.g. from BaseLayout).
 */
export function headingAnchors(): void {
  applyHeadingAnchors();
  document.addEventListener("astro:page-load", applyHeadingAnchors);
}
