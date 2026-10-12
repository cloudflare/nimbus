/**
 * theme-toggle.client.ts — light/dark toggle. Writes pref to localStorage
 * ("ui-mode"); BaseLayout's pre-paint script owns DOM application so view
 * transitions, OS changes, and cross-tab edits stay in sync.
 */

import { mount } from "@cloudflare/nimbus-docs/client";

declare global {
  interface Window {
    __nbApplyTheme?: (mode?: "light" | "dark") => void;
  }
}

function initThemeToggle(button: HTMLElement): () => void {
  function handleClick() {
    const mode = document.documentElement.getAttribute("data-mode") === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("ui-mode", mode);
      window.__nbApplyTheme?.();
    } catch {
      // Storage is blocked (private mode, restricted contexts): keep the
      // choice for this page.
      window.__nbApplyTheme?.(mode);
    }
    syncPressed();
  }

  function syncPressed() {
    button.setAttribute("aria-pressed", String(document.documentElement.dataset.mode === "dark"));
  }

  window.__nbApplyTheme?.();
  syncPressed();
  button.addEventListener("click", handleClick);
  return () => button.removeEventListener("click", handleClick);
}

mount("[data-nb-theme-toggle]", initThemeToggle);
