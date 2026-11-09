import { mount, onShortcut } from "@cloudflare/nimbus-docs/client";
import { shortcuts } from "@/lib/shortcuts";
import type { SearchProvider, SearchResponse, SearchResult } from "@cloudflare/nimbus-docs/types";
import { provider } from "./providers/pagefind";

export interface SearchConfig {
  input: HTMLInputElement;
  resultsContainer: HTMLElement;
  emptyState: HTMLElement;
  /** A provider returning a list or a `{ results }` / `{ error }` response. */
  provider: SearchProvider<SearchResult[] | SearchResponse>;
  onNavigate?: () => void;
}

export interface SearchInstance {
  reset(): Promise<void>;
  destroy(): void;
}

export function initSearch(config: SearchConfig): SearchInstance {
  const { input, resultsContainer, emptyState, provider, onNavigate } = config;

  let initialized = false;
  let activeIndex = -1;
  let resultIdCounter = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;

  function getOptions(): HTMLElement[] {
    return Array.from(resultsContainer.querySelectorAll<HTMLElement>("[role='option']"));
  }

  function updateActive(newIndex: number): void {
    const options = getOptions();
    if (options.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    activeIndex = Math.max(-1, Math.min(newIndex, options.length - 1));
    options.forEach((option, index) => {
      if (index === activeIndex) {
        option.setAttribute("data-highlighted", "");
        option.scrollIntoView({ block: "nearest" });
        input.setAttribute("aria-activedescendant", option.id);
      } else {
        option.removeAttribute("data-highlighted");
      }
    });
    if (activeIndex < 0) input.removeAttribute("aria-activedescendant");
  }

  function clearResults(): void {
    for (const result of resultsContainer.querySelectorAll("[role='option']")) result.remove();
    activeIndex = -1;
    resultsContainer.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  // A result's link is reached with the arrow keys through its option, never
  // with Tab: Tab leaves the listbox.
  function resultLink(title: string, href: string, className: string): HTMLAnchorElement {
    const link = document.createElement("a");
    link.tabIndex = -1;
    link.href = href;
    link.className = className;
    link.textContent = title;
    link.addEventListener("click", () => onNavigate?.());
    return link;
  }

  // One option, named by its single link: a click anywhere on it follows it.
  function resultOption(link: HTMLAnchorElement, className: string): HTMLElement {
    const option = document.createElement("div");
    option.id = `search-result-${resultIdCounter++}`;
    option.setAttribute("role", "option");
    option.className = className;
    link.id = `${option.id}-title`;
    option.setAttribute("aria-labelledby", link.id);
    option.appendChild(link);
    option.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest("a")) return;
      link.click();
    });
    return option;
  }

  // A result is an option, then one option per sub-result after it, so the
  // arrow keys reach every link and each option's name is its own title.
  function buildResult(result: SearchResult): HTMLElement[] {
    const option = resultOption(
      resultLink(result.title, result.url, "block truncate text-sm font-medium text-foreground no-underline focus-visible:outline-none"),
      "rounded-lg px-2 py-2 transition-colors cursor-pointer hover:bg-accent data-[highlighted]:bg-accent",
    );

    if (result.snippet) {
      const snippet = document.createElement("p");
      snippet.id = `${option.id}-snippet`;
      snippet.className = "mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground";
      snippet.innerHTML = result.snippet;
      option.appendChild(snippet);
      option.setAttribute("aria-describedby", snippet.id);
    }

    // Pagefind's first sub-result is often the page itself: skip it.
    const subs = (result.subResults ?? []).filter((sub) => sub.url !== result.url).slice(0, 3).map((sub) =>
      resultOption(
        resultLink(sub.title, sub.url, "block truncate text-xs text-muted-foreground no-underline"),
        "ms-4 border-s border-border rounded-e-lg ps-3 py-1 transition-colors cursor-pointer hover:bg-accent hover:text-foreground data-[highlighted]:bg-accent",
      ),
    );

    return [option, ...subs];
  }

  async function ensureInitialized(): Promise<boolean> {
    if (initialized) return true;
    try {
      await provider.init?.();
      initialized = true;
      return true;
    } catch {
      emptyState.textContent = import.meta.env.DEV
        ? "Search is available after a production build."
        : "Search could not load. Check your connection and reload the page. If it persists, ask the site owner to rebuild and deploy the search index.";
      return false;
    }
  }

  async function runSearch(query: string): Promise<void> {
    activeController?.abort();
    activeController = new AbortController();
    const signal = activeController.signal;

    emptyState.style.display = "";
    emptyState.textContent = "Searching…";
    clearResults();

    if (!(await ensureInitialized()) || signal.aborted) return;

    try {
      const response = await provider.search(query, { signal });
      if (signal.aborted) return;

      clearResults();
      activeIndex = -1;

      // A provider may say what went wrong instead of throwing.
      if (!Array.isArray(response) && "error" in response) {
        emptyState.style.display = "";
        emptyState.textContent = response.error.message;
        return;
      }
      const results = Array.isArray(response) ? response : response.results;

      if (results.length === 0) {
        emptyState.style.display = "";
        emptyState.textContent = "No results found.";
        return;
      }

      emptyState.style.display = "none";
      input.setAttribute("aria-expanded", "true");
      for (const result of results) resultsContainer.append(...buildResult(result));
      resultsContainer.hidden = false;
    } catch {
      if (signal.aborted) return;
      clearResults();
      emptyState.style.display = "";
      emptyState.textContent = "Search is temporarily unavailable.";
    }
  }

  // How long typing must pause before a search, and the shortest query sent.
  const wait = provider.options?.wait ?? 150;
  const minQueryLength = provider.options?.minQueryLength ?? 1;

  function handleInput(): void {
    activeController?.abort();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const query = input.value.trim();
      if (query.length < minQueryLength) {
        clearResults();
        emptyState.style.display = "";
        emptyState.textContent = "Type to search…";
        return;
      }
      void runSearch(query);
    }, wait);
  }

  function handleKeydown(event: KeyboardEvent): void {
    const options = getOptions();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      updateActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      updateActive(activeIndex - 1);
    } else if (event.key === "Home" && activeIndex >= 0) {
      // Only while an option is active; otherwise Home and End move the caret.
      event.preventDefault();
      updateActive(0);
    } else if (event.key === "End" && activeIndex >= 0) {
      event.preventDefault();
      updateActive(options.length - 1);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      options[activeIndex]?.querySelector<HTMLAnchorElement>("a")?.click();
    }
  }

  input.addEventListener("input", handleInput);
  input.addEventListener("keydown", handleKeydown);

  return {
    async reset() {
      activeController?.abort();
      if (debounceTimer) clearTimeout(debounceTimer);
      input.value = "";
      input.focus();
      activeIndex = -1;
      clearResults();
      emptyState.style.display = "";
      emptyState.textContent = "Type to search…";
      await ensureInitialized();
    },
    destroy() {
      activeController?.abort();
      if (debounceTimer) clearTimeout(debounceTimer);
      input.removeEventListener("input", handleInput);
      input.removeEventListener("keydown", handleKeydown);
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap — imported for its side effects by SearchDialog.astro
// (`import "./search.client"`). Wires each dialog through mount() and binds the
// global open shortcut once.
// ---------------------------------------------------------------------------

type SearchDialogElement = HTMLDialogElement & {
  __openSearchDialog?: () => void;
};

function primaryDialog(): SearchDialogElement | null {
  return document.querySelector<SearchDialogElement>("[data-search-dialog][data-search-ready]");
}

// The open shortcut and trigger delegation live on `document`, which survives
// view transitions, so they are bound once for the page's lifetime — never
// through mount()'s per-element setup/teardown. A module-scoped boolean (not an
// <html> attribute) is the guard: ClientRouter resets <html> on every swap but
// keeps document listeners, so an attribute guard would stack a duplicate
// keydown handler each navigation (Cmd+K then toggles twice).
let globalsBound = false;

function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;

  document.addEventListener("click", (event) => {
    const trigger = (event.target as Element | null)?.closest("[data-search-trigger]");
    if (!trigger) return;
    primaryDialog()?.__openSearchDialog?.();
  });

  onShortcut(shortcuts.search, (event) => {
    const dialog = primaryDialog();
    if (!dialog) return;
    event.preventDefault();
    if (dialog.open) dialog.close();
    else dialog.__openSearchDialog?.();
  });
}

// Per-element wiring: idempotent discovery now and on astro:page-load, teardown
// on astro:before-swap. Replaces the hand-rolled data-search-ready init loop;
// data-search-ready is now just the "wired" marker primaryDialog() selects on.
mount("[data-search-dialog]", (root) => {
  const dialog = root as SearchDialogElement;
  dialog.setAttribute("data-search-ready", "true");

  const input = dialog.querySelector<HTMLInputElement>("[data-search-input]");
  const resultsContainer = dialog.querySelector<HTMLElement>("[data-search-results]");
  const emptyState = dialog.querySelector<HTMLElement>("[data-search-empty]");
  if (!input || !resultsContainer || !emptyState) return () => {};

  const search = initSearch({
    input,
    resultsContainer,
    emptyState,
    provider,
    onNavigate: () => dialog.close(),
  });

  dialog.__openSearchDialog = () => {
    if (!dialog.open) dialog.showModal();
    void search.reset();
  };

  return () => search.destroy();
});

bindGlobals();
