---
{
  "name": "mermaid",
  "type": "registry:feature",
  "title": "Mermaid diagrams",
  "description": "Add lazy-loaded, theme-aware Mermaid.js diagram rendering with a skeleton loading state, safe color fallbacks, and a full-screen expand dialog.",
  "markers": ["src/scripts/mermaid.ts", "src/styles/mermaid.css"]
}
---

# Mermaid diagrams

You are helping the user add Mermaid.js diagram rendering to an existing Nimbus docs site.

Read this entire file before changing code.

The integration is plain DOM + a dynamic import — no React, no framework. It delivers:

- Diagrams styled to the site's theme: white node fills / mid-gray borders in light mode, near-black fills / lighter borders in dark mode, transparent container.
- A shimmering skeleton box while the ~2.5 MB mermaid bundle downloads, so unprocessed diagrams don't render as walls of raw source.
- A subtle bordered frame around rendered diagrams.
- A hover-revealed expand button that opens the diagram in a full-screen `<dialog>` with backdrop blur.
- Live re-rendering when `data-mode` on `<html>` flips between light and dark.
- Pay-per-use bundle weight: pages without diagrams load zero mermaid code.
- A safe error state if Mermaid fails to load or render — readers see a small placeholder, not raw diagram source.

## What to add

Add `mermaid` as a dependency:

```sh
pnpm add mermaid
```

Then create the two files below verbatim.

### `src/styles/mermaid.css`

```css
/* Unprocessed diagrams sit at a compact skeleton height instead of
 * reserving the raw source text's full vertical space, so a page with
 * many diagrams doesn't show towers of empty mermaid source while the
 * runtime is still loading. We hide the text via clip-path and give the
 * box a modest min-height so the layout stays calm. */
pre.mermaid:not([data-processed]) {
	min-height: 4rem;
	max-height: 4rem;
	overflow: hidden;
	color: transparent;
	background: color-mix(
		in oklch,
		var(--nb-muted, #f3f4f6) 100%,
		transparent
	);
	border-radius: 0.375rem;
	position: relative;
}
pre.mermaid:not([data-processed])::after {
	content: "";
	position: absolute;
	inset: 0;
	background: linear-gradient(
		90deg,
		transparent,
		color-mix(in oklch, var(--nb-card, #fff) 60%, transparent),
		transparent
	);
	transform: translateX(-100%);
	animation: nb-mermaid-shimmer 1.4s ease-in-out infinite;
}
@keyframes nb-mermaid-shimmer {
	100% {
		transform: translateX(100%);
	}
}
@media (prefers-reduced-motion: reduce) {
	pre.mermaid:not([data-processed])::after {
		animation: none;
	}
}

/* Container wrapper for diagram + annotation */
.mermaid-container {
	position: relative;
	background: transparent;
	overflow: hidden;
	margin: 1rem 0;
	border: 1px solid var(--nb-border);
	border-radius: 0.5rem;
	box-shadow: none;
}

/* Expand button */
.mermaid-expand {
	position: absolute;
	top: 0.5rem;
	right: 0.5rem;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	padding: 0;
	margin: 0;
	border: 1px solid var(--nb-border);
	border-radius: 6px;
	background: var(--nb-card);
	color: var(--nb-muted-foreground);
	cursor: pointer;
	opacity: 0;
	box-sizing: border-box;
	line-height: 1;
	outline-offset: 2px;
	-webkit-appearance: none;
	appearance: none;
	text-decoration: none;
	box-shadow: none;
	transition:
		opacity 0.15s ease,
		background 0.15s ease,
		color 0.15s ease;
}

.mermaid-container:hover .mermaid-expand {
	opacity: 1;
}

.mermaid-expand:focus-visible {
	opacity: 1;
	outline: 2px solid var(--nb-foreground);
}

@media (hover: none) {
	.mermaid-expand {
		opacity: 1;
	}
}

.mermaid-expand:hover {
	background: var(--nb-accent);
	color: var(--nb-foreground);
}

/* Full-screen dialog */
.mermaid-dialog {
	border: none;
	background: transparent;
	padding: 0;
	max-width: 100vw;
	max-height: 100vh;
	width: 100vw;
	height: 100vh;
	overflow: hidden;
}

@keyframes mermaid-dialog-in {
	from {
		opacity: 0;
		transform: scale(0.95);
	}
	to {
		opacity: 1;
		transform: scale(1);
	}
}

@keyframes mermaid-dialog-out {
	from {
		opacity: 1;
		transform: scale(1);
	}
	to {
		opacity: 0;
		transform: scale(0.95);
	}
}

@keyframes mermaid-backdrop-in {
	from {
		opacity: 0;
	}
	to {
		opacity: 1;
	}
}

@keyframes mermaid-backdrop-out {
	from {
		opacity: 1;
	}
	to {
		opacity: 0;
	}
}

.mermaid-dialog[open] {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 2rem;
	animation: mermaid-dialog-in 150ms ease-out;
}

.mermaid-dialog[open]::backdrop {
	background: rgba(0, 0, 0, 0.8);
	backdrop-filter: blur(4px);
	animation: mermaid-backdrop-in 150ms ease-out;
}

.mermaid-dialog.closing {
	animation: mermaid-dialog-out 150ms ease-in forwards;
}

.mermaid-dialog.closing::backdrop {
	animation: mermaid-backdrop-out 150ms ease-in forwards;
}

.mermaid-dialog-body {
	width: 92vw;
	max-height: 92vh;
	overflow: auto;
	border-radius: 10px;
	box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4);
}

/* The cloned container inside the dialog — give it a proper background */
.mermaid-dialog-body .mermaid-container {
	margin: 0;
	background: var(--nb-card);
	border-radius: 10px;
	overflow: hidden;
}

/* Scale the SVG larger in the dialog */
.mermaid-dialog-body pre.mermaid[data-processed] {
	padding: 3rem;
}

.mermaid-dialog-body pre.mermaid[data-processed] svg {
	max-height: calc(92vh - 120px);
	width: 100%;
}

.mermaid-dialog-close {
	position: fixed;
	top: 1rem;
	right: 1rem;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border: 1px solid rgba(255, 255, 255, 0.2);
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.5);
	color: rgba(255, 255, 255, 0.7);
	cursor: pointer;
	transition:
		background 0.15s ease,
		color 0.15s ease;
}

.mermaid-dialog-close:hover {
	background: rgba(0, 0, 0, 0.7);
	color: #ffffff;
}

/* The diagram itself */
pre.mermaid[data-processed]:not([data-error]) {
	padding: 1.5rem;
	margin: 0;
	background: transparent;
	border-radius: 0;
	box-shadow: none;
	display: block;
	line-height: 0;
	border-color: var(--nb-border) !important;
}

pre.mermaid[data-error] {
	visibility: visible;
	line-height: 1.5;
	padding: 1rem;
	margin: 1rem 0;
	border: 1px solid var(--nb-danger, #dc2626);
	border-radius: 0.5rem;
	background: var(--nb-danger-muted, #fef2f2);
	color: var(--nb-danger, #dc2626);
}

/* Ensure SVG fills the width nicely */
pre.mermaid[data-processed] svg {
	max-width: 100%;
	height: auto;
	display: block;
	margin: 0;
	padding: 0;
	vertical-align: top;
}

/* Remove any box shadow from SVG elements (excluding edge labels) */
pre.mermaid[data-processed] svg :not(foreignObject *) {
	box-shadow: none !important;
}
```

### `src/scripts/mermaid.ts`

This version assumes the layout uses Astro's `ClientRouter` (the Nimbus starter does — check the user's `BaseLayout.astro` for `import { ClientRouter } from "astro:transitions"`). Setup re-runs on `astro:page-load`, which fires on initial load and after every client-side navigation; the body swap also destroys the dialog singleton, so it is reset per page.

If the user's site does NOT use `ClientRouter`, replace the final `document.addEventListener("astro:page-load", setup);` line with a direct `setup();` call — `astro:page-load` never fires without the router.

```ts
let diagrams: HTMLPreElement[] = [];
const captured = new WeakSet<HTMLPreElement>();

// Full-screen expand dialog (lazy — only created when needed)
let dialog: HTMLDialogElement | null = null;

function uniqueMermaidId(): string {
	const random =
		globalThis.crypto?.randomUUID?.() ??
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `mermaid-${random}`;
}

function captureDiagramSource(diagram: HTMLPreElement): void {
	if (captured.has(diagram)) return;
	diagram.setAttribute("data-diagram", diagram.textContent as string);
	captured.add(diagram);
}

function showRenderError(diagram: HTMLPreElement): void {
	captureDiagramSource(diagram);
	diagram.textContent = "Diagram failed to render.";
	diagram.setAttribute("data-error", "true");
	diagram.setAttribute("data-processed", "true");
}

function getDialog(): HTMLDialogElement {
	if (dialog) return dialog;

	dialog = document.createElement("dialog");
	dialog.className = "mermaid-dialog";
	dialog.innerHTML = `
		<div class="mermaid-dialog-body"></div>
		<button class="mermaid-dialog-close" aria-label="Close">
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="18" y1="6" x2="6" y2="18"></line>
				<line x1="6" y1="6" x2="18" y2="18"></line>
			</svg>
		</button>
	`;
	document.body.appendChild(dialog);

	function closeWithAnimation() {
		if (!dialog || !dialog.open) return;
		dialog.classList.add("closing");
		dialog.addEventListener(
			"animationend",
			() => {
				dialog!.classList.remove("closing");
				dialog!.close();
				document.documentElement.style.overflow = "";
			},
			{ once: true },
		);
	}

	dialog.addEventListener("click", (e) => {
		if (e.target === dialog) closeWithAnimation();
	});
	dialog
		.querySelector(".mermaid-dialog-close")
		?.addEventListener("click", () => {
			closeWithAnimation();
		});
	// Handle Escape key — native dialog closes immediately,
	// so we intercept cancel to animate first
	dialog.addEventListener("cancel", (e) => {
		e.preventDefault();
		closeWithAnimation();
	});

	return dialog;
}

function openDiagram(container: HTMLElement) {
	const d = getDialog();
	const clone = container.cloneNode(true) as HTMLElement;

	// Remove the expand button from the clone
	clone.querySelector(".mermaid-expand")?.remove();

	// Let the SVG scale freely in the expanded view
	const svg = clone.querySelector("svg");
	if (svg) {
		svg.removeAttribute("style");
		svg.setAttribute("width", "100%");
		svg.setAttribute("height", "auto");
	}

	const body = d.querySelector(".mermaid-dialog-body");
	if (!body) return;
	body.replaceChildren(clone);

	// Close dialog when clicking Mermaid `click` links inside the expanded view.
	clone.addEventListener("click", (e) => {
		const target = e.target as Element;
		const anchor = target.closest("a");
		const clickable = target.closest(".clickable");
		if (anchor || clickable) {
			// Skip animation for link clicks — navigate immediately
			d.close();
			document.documentElement.style.overflow = "";
		}
	});

	document.documentElement.style.overflow = "hidden";
	d.showModal();
}

// Get computed font family from CSS variable
function getFontFamily(): string {
	const computedStyle = getComputedStyle(document.documentElement);
	const font = computedStyle.getPropertyValue("--nb-font-sans").trim();
	return font || "system-ui, -apple-system, sans-serif";
}

function getPageBackground(): string {
	const style = getComputedStyle(document.documentElement);
	const bg = style.getPropertyValue("--nb-background").trim();
	if (isMermaidSupportedColor(bg)) return bg;
	return document.documentElement.getAttribute("data-mode") === "dark"
		? "#0f0f0f"
		: "#ffffff";
}

function getThemeColor(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return isMermaidSupportedColor(value) ? value : fallback;
}

function isMermaidSupportedColor(value: string): boolean {
	return (
		/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ||
		/^rgba?\(\s*\d+(?:\.\d+)?%?\s*,\s*\d+(?:\.\d+)?%?\s*,\s*\d+(?:\.\d+)?%?(?:\s*,\s*(?:0|1|0?\.\d+|\d+(?:\.\d+)?%))?\s*\)$/i.test(value) ||
		/^hsla?\(\s*-?\d+(?:\.\d+)?(?:deg|rad|turn)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%(?:\s*,\s*(?:0|1|0?\.\d+|\d+(?:\.\d+)?%))?\s*\)$/i.test(value)
	);
}

// Create wrapper container with expand affordance
function wrapDiagram(diagram: HTMLPreElement) {
	// Skip if already wrapped
	if (diagram.parentElement?.classList.contains("mermaid-container")) {
		return;
	}

	// Create container
	const container = document.createElement("div");
	container.className = "mermaid-container";

	// Wrap the diagram
	diagram.parentNode?.insertBefore(container, diagram);
	container.appendChild(diagram);

	// Add expand button
	const expandBtn = document.createElement("button");
	expandBtn.className = "mermaid-expand";
	expandBtn.setAttribute("aria-label", "Expand diagram");
	expandBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<polyline points="15 3 21 3 21 9"></polyline>
		<polyline points="9 21 3 21 3 15"></polyline>
		<line x1="21" y1="3" x2="14" y2="10"></line>
		<line x1="3" y1="21" x2="10" y2="14"></line>
	</svg>`;
	expandBtn.addEventListener("click", () => openDiagram(container));
	container.appendChild(expandBtn);
}

async function render() {
	diagrams.forEach(captureDiagramSource);

	let mermaid: typeof import("mermaid").default;
	try {
		// Dynamically import mermaid — the ~2.5 MB bundle is only fetched
		// on the pages that actually contain diagrams.
		({ default: mermaid } = await import("mermaid"));
	} catch (e) {
		diagrams.forEach(showRenderError);
		console.error("Mermaid load failed:", e);
		return;
	}

	const isLight =
		document.documentElement.getAttribute("data-mode") !== "dark";
	const fontFamily = getFontFamily();
	const pageBg = getPageBackground();
	const accent = getThemeColor("--nb-primary", isLight ? "#ff4801" : "#ff6524");

	const lightThemeVars = {
		fontFamily,
		primaryColor: "#ffffff",
		primaryBorderColor: accent,
		primaryTextColor: "#1d1d1d",
		secondaryColor: "#f3f4f6",
		secondaryBorderColor: "#9ca3af",
		secondaryTextColor: "#1d1d1d",
		tertiaryColor: "#f3f4f6",
		tertiaryBorderColor: "#9ca3af",
		tertiaryTextColor: "#1d1d1d",
		lineColor: accent,
		textColor: "#1d1d1d",
		mainBkg: "#ffffff",
		errorBkgColor: "#fef2f2",
		errorTextColor: "#7f1d1d",
		edgeLabelBackground: pageBg,
		labelBackground: pageBg,
	};

	const darkThemeVars = {
		fontFamily,
		primaryColor: "#1f1f1f",
		primaryBorderColor: accent,
		primaryTextColor: "#f2f2f2",
		secondaryColor: "#262626",
		secondaryBorderColor: "#6b7280",
		secondaryTextColor: "#f2f2f2",
		tertiaryColor: "#262626",
		tertiaryBorderColor: "#6b7280",
		tertiaryTextColor: "#f2f2f2",
		lineColor: accent,
		textColor: "#f2f2f2",
		mainBkg: "#1f1f1f",
		background: "#0f0f0f",
		errorBkgColor: "#3c0501",
		errorTextColor: "#ffefee",
		edgeLabelBackground: pageBg,
		labelBackground: pageBg,
	};

	const themeVariables = isLight ? lightThemeVars : darkThemeVars;

	try {
		// Initialize once before the loop — config is identical for all diagrams
		mermaid.initialize({
			startOnLoad: false,
			theme: "base",
			themeVariables,
			flowchart: {
				htmlLabels: true,
				useMaxWidth: true,
				curve: "linear",
			},
		});
	} catch (e) {
		diagrams.forEach(showRenderError);
		console.error("Mermaid initialize failed:", e);
		return;
	}

	for (const diagram of diagrams) {
		try {
			const def = diagram.getAttribute("data-diagram") as string;

			const { svg } = await mermaid.render(uniqueMermaidId(), def);
			diagram.innerHTML = svg;
			diagram.removeAttribute("data-error");

			wrapDiagram(diagram);
			diagram.setAttribute("data-processed", "true");
		} catch (e) {
			showRenderError(diagram);
			console.error("Mermaid render failed:", e);
		}
	}

}

const obs = new MutationObserver(() => {
	if (diagrams.length > 0) render();
});

obs.observe(document.documentElement, {
	attributes: true,
	attributeFilter: ["data-mode"],
});

function setup() {
	diagrams = Array.from(
		document.querySelectorAll<HTMLPreElement>("pre.mermaid"),
	);
	// Body was swapped by the router — any previous dialog is gone.
	dialog = null;
	if (diagrams.length > 0) render();
}

// Fires on initial load and after every client-side navigation.
document.addEventListener("astro:page-load", setup);
```

## Wire it into the layout

In the user's top-level layout (`src/layouts/BaseLayout.astro` in the starter), add two lines:

1. Import the stylesheet alongside the existing global styles in the frontmatter:

```astro
import "../styles/mermaid.css";
```

2. Add the bootstrap script at the end of `<body>`, after any existing `<script>` blocks:

```astro
<script>
  import "../scripts/mermaid";
</script>
```

Do not inline the script's contents into the layout — keeping it as an import lets Astro bundle and code-split the dynamic `import("mermaid")`.

## Theming contract

The integration reads the Nimbus theme tokens already defined in the starter's `globals.css`: `--nb-card`, `--nb-border`, `--nb-muted`, `--nb-muted-foreground`, `--nb-foreground`, `--nb-accent`, `--nb-font-sans`. Fallbacks are baked in, so nothing breaks if a token was renamed — but check that these exist before assuming the defaults are wrong.

Theme switching keys off the `data-mode` attribute on `<html>` (present = dark, absent = light), which the starter's theme toggle already manages. `getPageBackground()` reads `--nb-background` only when it is a legacy Mermaid-compatible color string (`#…`, `rgb(a)`, or `hsl(a)`). Modern CSS colors such as `oklch()` fall back to hardcoded light/dark hex values so Mermaid's parser does not throw.

## Authoring diagrams

Diagrams are authored in MDX as `<pre class="mermaid">` blocks with the mermaid source in a template literal:

```mdx
<pre class="mermaid">{`
flowchart LR
  Browser --> Edge --> Origin
`}</pre>
```

Plain ` ```mermaid ` code fences require a markdown transform that emits `<pre class="mermaid">…</pre>`. If the site has not added that transform, author diagrams with the explicit `<pre class="mermaid">` form above; the client script only renders `pre.mermaid` elements.

## Verification

Run the user's dev server and open a page containing a diagram. Confirm:

- The diagram renders as an SVG (not raw mermaid source). Before the bundle loads, a shimmering skeleton box shows instead of raw text.
- Toggling the site theme re-renders the diagram with the other palette.
- Hovering the diagram reveals an expand button in the top-right corner; clicking it opens a full-screen dialog; Escape closes it with an animation.
- Navigating to the diagram page via a sidebar link (client-side navigation) still renders diagrams.
- A page with no diagrams loads no mermaid chunk (check the network tab).

## Troubleshooting

- **Diagrams show as raw source forever** — the script never ran or the selector didn't match. Confirm the layout includes the script and the rendered HTML contains `<pre class="mermaid">`.
- **A diagram shows “Diagram failed to render.”** — Mermaid loaded but rejected that diagram or the global theme configuration. Check the console for the exact parser/render error; the original source is preserved in the element's `data-diagram` attribute for retry/debugging.
- **Diagrams render with default mermaid colors** — `mermaid.initialize` wasn't called before `render`; check the console for a load error.
- **Theme toggle doesn't update diagrams** — the site's toggle isn't setting `data-mode` on `<html>`. Point the `MutationObserver` at whatever element carries the mode attribute.
- **Mermaid throws a color-parse error** — an unsupported value reached `themeVariables`. Keep colors passed to Mermaid as hex, `rgb(a)`, or `hsl(a)` values; do not pass CSS variables or modern color functions directly.
- **Diagrams duplicated or missing after navigation** — the site uses `ClientRouter` but the script runs `setup()` at module load, or vice versa. Match the bootstrap to the router as described above.
