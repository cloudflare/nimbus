/**
 * Sync key `ui-pm-tab` (sessionStorage) is shared with the
 * `<nb-pm-restore>` early-paint element to avoid flash across navigations.
 */

import { mount, initTabs } from "@cloudflare/nimbus-docs/client";

function cloneIcon(tpl: HTMLTemplateElement | null): Node {
  return tpl ? tpl.content.cloneNode(true) : document.createTextNode("");
}

function initPackageManager(container: HTMLElement): () => void {
  const copyTpl = container.querySelector<HTMLTemplateElement>("[data-nb-pm-icon-copy]");
  const checkTpl = container.querySelector<HTMLTemplateElement>("[data-nb-pm-icon-check]");
  const failTpl = container.querySelector<HTMLTemplateElement>("[data-nb-pm-icon-fail]");

  const tabs = initTabs({
    container,
    tabSelector: "[data-nb-pm-tab]",
    panelSelector: "[data-nb-pm-panel]",
    rovingTabindex: true,
    sync: { key: "ui-pm-tab", storage: "session" },
  });

  const copyHandlers: Array<{ btn: HTMLButtonElement; handler: () => void; timer?: number }> = [];

  container.querySelectorAll<HTMLButtonElement>("[data-nb-pm-copy]").forEach((btn) => {
    const handlerInfo: { btn: HTMLButtonElement; handler: () => void; timer?: number } = {
      btn,
      handler: async () => {
        let copied = true;
        try {
          await navigator.clipboard.writeText(btn.dataset.nbCommand ?? "");
        } catch {
          copied = false;
        }
        btn.replaceChildren(cloneIcon(copied ? checkTpl : (failTpl ?? copyTpl)));
        btn.setAttribute("aria-label", copied ? "Copied" : "Couldn't copy");
        if (handlerInfo.timer) window.clearTimeout(handlerInfo.timer);
        handlerInfo.timer = window.setTimeout(() => {
          btn.replaceChildren(cloneIcon(copyTpl));
          btn.setAttribute("aria-label", "Copy to clipboard");
        }, 1500);
      },
    };
    btn.addEventListener("click", handlerInfo.handler);
    copyHandlers.push(handlerInfo);
  });

  return () => {
    tabs.destroy();
    copyHandlers.forEach(({ btn, handler, timer }) => {
      btn.removeEventListener("click", handler);
      if (timer) window.clearTimeout(timer);
    });
  };
}

mount("[data-nb-pm]", initPackageManager);
