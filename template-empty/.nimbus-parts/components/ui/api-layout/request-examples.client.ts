import { initTabs, mount } from "@cloudflare/nimbus-docs/client";

function initRequestExamples(container: HTMLElement): () => void {
  const tabs = initTabs({
    container,
    tabSelector: "[data-request-example-trigger]",
    panelSelector: "[data-request-example-panel]",
  });
  return () => tabs.destroy();
}

mount("[data-request-examples]", initRequestExamples);
