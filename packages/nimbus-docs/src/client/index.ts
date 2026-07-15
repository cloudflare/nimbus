/**
 * nimbus-docs/client — Behavior primitives for user-owned components.
 *
 * These are the invisible, mechanical plumbing pieces every docs site needs
 * but no content author edits: component mount/unmount lifecycle, disclosure
 * (open/close + ARIA), tab activation, scroll lock, and the page-wide code-copy
 * and heading-anchor enhancements.
 *
 * Per-component `.client.ts` glue files in the starter import these by name and
 * stay short — typically a `mount(selector, init)` call wiring a primitive to
 * the component's DOM contract.
 */

export { mount } from "./mount";
export { makeDisclosure } from "./disclosure";
export type { DisclosureOptions, DisclosureInstance } from "./disclosure";
export { initTabs } from "./tabs-controller";
export type { TabsConfig, TabsInstance } from "./tabs-controller";
export { lockScroll, unlockScroll } from "./scroll-lock";
export { generateId } from "./ids";
export { FOCUSABLE } from "./dom";
export { codeCopy } from "./code-copy";
export { headingAnchors } from "./heading-anchors";
