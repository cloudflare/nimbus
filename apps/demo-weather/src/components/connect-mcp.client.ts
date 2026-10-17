import { mount } from "@cloudflare/nimbus-docs/client";

const RESET_MS = 1500;

function initConnectMcp(root: HTMLElement): () => void {
  const button = root.querySelector<HTMLButtonElement>("[data-nb-connect-mcp-copy]");
  const label = root.querySelector<HTMLElement>("[data-nb-connect-mcp-label]");
  const status = root.querySelector<HTMLElement>("[data-nb-connect-mcp-status]");
  const url = button?.dataset.copy;
  if (!button || !label || !url) return () => {};

  const idle = label.textContent;
  let timer: number | undefined;
  const onCopy = async () => {
    let copied = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      copied = false;
    }
    if (!root.isConnected) return;
    label.textContent = copied ? "Copied" : "Couldn't copy";
    if (status) status.textContent = copied ? "MCP server URL copied" : "Couldn't copy the MCP server URL";
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      label.textContent = idle;
      if (status) status.textContent = "";
    }, RESET_MS);
  };
  button.addEventListener("click", onCopy);

  return () => {
    button.removeEventListener("click", onCopy);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

mount("[data-nb-connect-mcp]", initConnectMcp);
