/**
 * Keyboard shortcuts for a docs site. A site names its keys in one file
 * (the starter's `src/lib/shortcuts.ts`); components bind them here.
 *
 * A key is a literal character (`"/"`, `"["`, `"?"`), matched as typed, Shift
 * allowed since it may be what produces the character; or a combo
 * (`"Mod+K"`, `"Shift+Alt+P"`) whose modifiers must match exactly. `Mod` is ⌘
 * on macOS and Ctrl elsewhere. `false` binds and labels nothing.
 *
 * Single-key shortcuts (no Ctrl, ⌘ or Alt) can be switched off by the reader,
 * as WCAG 2.1.4 requires of page-wide single keys. They bind page-wide only
 * while the page offers that switch (an element marked `data-nb-shortcuts-toggle`),
 * the reader hasn't turned them off, and no modal dialog is open.
 *
 * Hints follow the reader and the platform through two attributes, kept current
 * by `syncShortcutHints`: `data-nb-shortcut-hint="<key>"` on an element that
 * shows the key, `data-nb-shortcut-for="<key>"` on the control it reaches.
 */

export type ShortcutKey = string | false;

/** A site's shortcuts, by name. */
export type Shortcuts = Record<string, ShortcutKey>;

const STORAGE_KEY = "nb-single-key-shortcuts";
/** Dispatched on `document` when single keys are turned on or off. */
export const SHORTCUTS_CHANGE = "nb:shortcuts-change";
const TOGGLE = "[data-nb-shortcuts-toggle]";
const MODIFIERS = new Set(["mod", "ctrl", "control", "meta", "cmd", "alt", "option", "shift"]);

// The reader's choice for this tab. It holds even when storage is unavailable.
let chosen: boolean | undefined;
let storageBound = false;

function bindStorage(): void {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  // Another tab changed it: forget this tab's copy and tell listeners.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    chosen = undefined;
    document.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGE));
  });
}

/** Whether the reader has single-key shortcuts on. On until they choose. */
export function singleKeyShortcutsEnabled(): boolean {
  bindStorage();
  if (chosen !== undefined) return chosen;
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Turn single-key shortcuts on or off for this reader, in this tab and others. */
export function setSingleKeyShortcutsEnabled(on: boolean): void {
  bindStorage();
  chosen = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the choice holds for this tab.
  }
  document.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGE));
}

/** Whether single-key shortcuts bind page-wide now: the page offers the
 *  reader's switch, and it's on. */
export function singleKeyShortcutsActive(): boolean {
  return document.querySelector(TOGGLE) !== null && singleKeyShortcutsEnabled();
}

// A modal dialog owns the keyboard: page-wide single keys wait until it closes.
function modalOpen(): boolean {
  try {
    return document.querySelector("dialog:modal") !== null;
  } catch {
    return document.querySelector("dialog[open]") !== null;
  }
}

interface Combo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? "";
  return platform ? /mac/i.test(platform) : /mac|iphone|ipod|ipad/i.test(navigator.userAgent);
}

function parse(key: string): Combo | undefined {
  const parts = key.split("+");
  if (parts.length < 2 || parts.some((p) => p === "")) return undefined;
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (!mods.every((m) => MODIFIERS.has(m))) return undefined;
  const mac = isMac();
  const has = (...names: string[]) => mods.some((m) => names.includes(m));
  return {
    key: parts.at(-1)!,
    ctrl: has("ctrl", "control") || (has("mod") && !mac),
    meta: has("meta", "cmd") || (has("mod") && mac),
    alt: has("alt", "option"),
    shift: has("shift"),
  };
}

/** A shortcut pressed with no Ctrl, ⌘ or Alt: one the reader can turn off. */
export function isSingleKey(key: ShortcutKey): boolean {
  if (key === false) return false;
  const combo = parse(key);
  return !combo || !(combo.ctrl || combo.meta || combo.alt);
}

// The modifiers held typed the character: AltGr (which Windows and Linux
// report as Ctrl+Alt), or Option on macOS.
function typedWithModifier(event: KeyboardEvent): boolean {
  return event.getModifierState?.("AltGraph") || (isMac() && event.altKey && !event.ctrlKey);
}

// Alt (Option on macOS) can change the character a letter or digit types
// (Option+P is "π"), so an Alt combo also matches the key's place on the
// keyboard. Other combos match the character, which keeps them right on every
// layout.
function altered(combo: Combo, event: KeyboardEvent): boolean {
  if (!combo.alt || !/^[a-z0-9]$/i.test(combo.key)) return false;
  return event.code === (/\d/.test(combo.key) ? `Digit${combo.key}` : `Key${combo.key.toUpperCase()}`);
}

function matches(key: string, event: KeyboardEvent): boolean {
  const combo = parse(key);
  if (!combo) {
    return event.key === key && !event.metaKey && (!(event.ctrlKey || event.altKey) || typedWithModifier(event));
  }
  return (
    (event.key.toLowerCase() === combo.key.toLowerCase() || altered(combo, event)) &&
    event.ctrlKey === combo.ctrl &&
    event.metaKey === combo.meta &&
    event.altKey === combo.alt &&
    event.shiftKey === combo.shift
  );
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export interface ShortcutOptions {
  /** Answer only while focus is inside this element. A single key then needs
   *  no switch on the page, only the reader's choice to keep single keys on. */
  within?: HTMLElement;
}

/**
 * Run `handler` when `key` is pressed anywhere on the page, or inside `within`.
 * Never while composing text, on a held key's repeats, or after something else
 * handled the press; a single key also not while typing in a field, nor while
 * single keys are off. Returns a function that unbinds it.
 */
export function onShortcut(
  key: ShortcutKey,
  handler: (event: KeyboardEvent) => void,
  { within }: ShortcutOptions = {},
): () => void {
  if (key === false) return () => {};
  const single = isSingleKey(key);
  const target: HTMLElement | Document = within ?? document;
  const listener = (event: Event) => {
    const press = event as KeyboardEvent;
    if (press.isComposing || press.repeat || press.defaultPrevented) return;
    if (!matches(key, press)) return;
    if (single) {
      if (typing(press.target) || !singleKeyShortcutsEnabled()) return;
      if (!within && (!singleKeyShortcutsActive() || modalOpen())) return;
    }
    handler(press);
  };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}

let hintsBound = false;

function selectAll<T extends Element>(root: ParentNode, selector: string): T[] {
  const found = Array.from(root.querySelectorAll<T>(selector));
  const self = "matches" in root && (root as Element).matches(selector);
  return self ? [root as T, ...found] : found;
}

/**
 * Bring the shortcut hints in `root` up to date. Each `data-nb-shortcut-hint`
 * shows its key as this platform writes it, hidden while it's a single key the
 * reader turned off. Each `data-nb-shortcut-for` names its key in
 * `aria-keyshortcuts` while the key works: page-wide, or, inside an element
 * marked `data-nb-shortcut-scope` (bound with `within`), whenever single keys
 * are on. After the first call, the whole page follows the reader's switch.
 */
export function syncShortcutHints(root: ParentNode = document): void {
  bindStorage();
  if (!hintsBound) {
    hintsBound = true;
    document.addEventListener(SHORTCUTS_CHANGE, () => syncShortcutHints());
  }
  const enabled = singleKeyShortcutsEnabled();
  const pageWide = singleKeyShortcutsActive();
  for (const el of selectAll<HTMLElement>(root, "[data-nb-shortcut-hint]")) {
    const key = el.dataset.nbShortcutHint!;
    el.textContent = shortcutLabel(key);
    // Inline, so it holds whatever display the component's classes give it.
    if (isSingleKey(key)) el.style.display = enabled ? "" : "none";
  }
  for (const el of selectAll<HTMLElement>(root, "[data-nb-shortcut-for]")) {
    const key = el.dataset.nbShortcutFor!;
    const works = !isSingleKey(key) || (el.closest("[data-nb-shortcut-scope]") ? enabled : pageWide);
    if (works) el.setAttribute("aria-keyshortcuts", ariaKeyShortcuts(key));
    else el.removeAttribute("aria-keyshortcuts");
  }
}

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", meta: "⌘", cmd: "⌘", ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧" };
const NAMES: Record<string, string> = { mod: "Ctrl", meta: "Meta", cmd: "Meta", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" };

/** The key as a reader sees it: `⌘K` on macOS, `Ctrl K` elsewhere, `[`. Empty for `false`. */
export function shortcutLabel(key: ShortcutKey): string {
  if (key === false) return "";
  if (!parse(key)) return key;
  const parts = key.split("+");
  const letter = parts.at(-1)!.length === 1 ? parts.at(-1)!.toUpperCase() : parts.at(-1)!;
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  return isMac() ? `${mods.map((m) => MAC_SYMBOLS[m]).join("")}${letter}` : [...mods.map((m) => NAMES[m]), letter].join(" ");
}

/** The key as `aria-keyshortcuts` names it (`Meta+K`, `Control+K`, `[`). Empty for `false`. */
export function ariaKeyShortcuts(key: ShortcutKey): string {
  if (key === false) return "";
  const combo = parse(key);
  if (!combo) return key;
  const names = [combo.ctrl && "Control", combo.meta && "Meta", combo.alt && "Alt", combo.shift && "Shift"].filter(Boolean);
  return [...names, combo.key.length === 1 ? combo.key.toUpperCase() : combo.key].join("+");
}
