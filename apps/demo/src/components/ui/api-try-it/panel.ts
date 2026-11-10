/**
 * The Try it panel, loaded on the first click of its button. Mechanism
 * (the request plan, serialising, masking, samples, sending) comes from
 * `@cloudflare/nimbus-docs/client`; the markup, wording and flow here are the
 * site's own to change.
 *
 * Layout: a modal from the search dialog's family (a full page below md). The
 * URL bar on top (method, server, path, Send); the inputs on the left as cards
 * (where the request goes, Authorization, URL, Parameters, Body); on the
 * right, the code rail made live: the request as code over its response.
 */
import {
  checkParam,
  isTextMedia,
  loadRequestPlan,
  lockScroll,
  maskText,
  paramKey,
  parseExactJson,
  renderSample,
  resolveServer,
  sendRequest,
  sameOrigin,
  serializeRequest,
  unlockScroll,
  validateValues,
  type Credential,
  type DeliveryMode,
  type FormValues,
  type HttpRequest,
  type PlanAuth,
  type PlanBodyField,
  type PlanSchema,
  type PlanMedia,
  type PlanParam,
  type RequestPlan,
  type RequestValues,
  type SampleLang,
  type SendOutcome,
  type TryItInfo,
} from "@cloudflare/nimbus-docs/client";
import { methodVariant } from "@/components/ui/api-sidebar/method";
import { highlight, type HighlightLang } from "./highlight";
import "./try-it.css";

interface Meta {
  info: TryItInfo;
  base: string;
  proxy: string | null;
  title: string;
  remember: "none" | "tab" | "device";
  confirmWrites: boolean;
  server?: number | string;
}

type Lang = SampleLang;
type ParamValue = string | string[] | unknown;

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const LOCATIONS: [PlanParam["in"], string][] = [
  ["path", "Path"],
  ["query", "Query"],
  ["header", "Headers"],
  ["cookie", "Cookies"],
];
const LANG_KEY = "nb-tryit-lang";
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const SAMPLE_LANG: Record<Lang, HighlightLang> = { curl: "bash", typescript: "typescript", python: "python" };
const REASONS: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 303: "See Other",
  304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 410: "Gone", 415: "Unsupported Media Type",
  422: "Unprocessable Content", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout",
};

// ---- Markup helpers ---------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const ph = (d: string, cls: string, extra = "") =>
  `<svg width="1em" height="1em" viewBox="0 0 256 256" class="${cls}" ${extra} aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
const P_X = "M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128L50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z";
const P_COPY = "M216 32H88a8 8 0 0 0-8 8v40H40a8 8 0 0 0-8 8v128a8 8 0 0 0 8 8h128a8 8 0 0 0 8-8v-40h40a8 8 0 0 0 8-8V40a8 8 0 0 0-8-8m-56 176H48V96h112Zm48-48h-32V88a8 8 0 0 0-8-8H96V48h112Z";
const P_CHECK = "m229.66 77.66l-128 128a8 8 0 0 1-11.32 0l-56-56a8 8 0 0 1 11.32-11.32L96 188.69L218.34 66.34a8 8 0 0 1 11.32 11.32";
const P_CARET = "m213.66 101.66l-80 80a8 8 0 0 1-11.32 0l-80-80a8 8 0 0 1 11.32-11.32L128 164.69l74.34-74.35a8 8 0 0 1 11.32 11.32";
const P_RESET = "M224 128a96 96 0 0 1-94.71 96H128a95.38 95.38 0 0 1-65.9-26.2a8 8 0 0 1 11-11.63a80 80 0 1 0-1.67-114.78L55.69 88H80a8 8 0 0 1 0 16H32a8 8 0 0 1-8-8V48a8 8 0 0 1 16 0v26.2l17.7-16.2A96 96 0 0 1 224 128";
const COPY_ICONS = ph(P_COPY, "size-3.5", "data-icon-copy") + ph(P_CHECK, "size-3.5 text-success", "data-icon-done hidden");
const sv = (d: string) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const EYE = sv('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>');
const EYE_OFF = sv('<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c4.53 0 8.36 2.94 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>');
const X = sv('<path d="M18 6 6 18M6 6l12 12"/>');

const LAYER = "group/layer flex w-full overflow-hidden rounded-lg bg-muted text-sm ring ring-border";
const LAYER_HEAD = "flex min-w-0 items-center gap-2 bg-muted px-3 text-[0.8125rem] font-medium leading-5 text-muted-foreground [overflow-wrap:anywhere] group-data-[orientation=horizontal]/layer:shrink-0";
const LAYER_CONTENT = "relative flex overflow-hidden rounded-lg bg-card text-sm leading-6 text-foreground ring ring-border group-data-[orientation=horizontal]/layer:min-w-0 group-data-[orientation=horizontal]/layer:flex-1";

// Why a JSON field's text can't be sent, or null: it doesn't parse, or holds a number it would round.
const jsonProblem = (source: string): string | null => {
  try {
    parseExactJson(source);
    return null;
  } catch (error) {
    return error instanceof RangeError ? error.message : "Not valid JSON.";
  }
};

const text = (value: unknown): string =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);

function store(kind: "tab" | "device"): Storage | null {
  try {
    return kind === "device" ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

function readable(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function tone(status: number): string {
  if (status >= 200 && status < 300) return "nb-tid-ok";
  if (status >= 300 && status < 400) return "nb-tid-info";
  return "nb-tid-err";
}

function compactJson(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += source[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (!/\s/.test(c)) out += c;
  }
  return out;
}

// A JSON body pretty-printed only when that changes nothing but whitespace
// (no rounded big numbers, no dropped `__proto__`); malformed JSON stays text.
function pretty(body: string): { code: string; json: boolean } {
  try {
    const value = JSON.parse(body) as unknown;
    if (/"__proto__"\s*:/.test(body) || JSON.stringify(value) !== compactJson(body)) return { code: body, json: true };
    return { code: JSON.stringify(value, null, 2), json: true };
  } catch {
    return { code: body, json: false };
  }
}

function paint(box: HTMLElement, code: string, lang: HighlightLang, label: string): void {
  box.innerHTML = `<figure class="nb-code-figure">${highlight(code, lang, label)}</figure>`;
}

function hexPreview(bytes: Uint8Array): string {
  const rows: string[] = [];
  const head = bytes.subarray(0, 1024);
  for (let at = 0; at < head.length; at += 16) {
    const row = head.subarray(at, at + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    rows.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return rows.join("\n");
}

function retryAfter(headers: [string, string][]): number | undefined {
  const raw = headers.find(([n]) => n.toLowerCase() === "retry-after")?.[1];
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

const scrollBehavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// ---- The panel ------------------------------------------------------------------------

export async function createPanel(button: HTMLButtonElement): Promise<{ open(): void; destroy(): void }> {
  const meta = JSON.parse(button.dataset.meta ?? "null") as Meta;
  const plan = await loadRequestPlan({ tryIt: meta.info }, { base: meta.base });
  const rail = button.closest<HTMLElement>("[data-nb-api-coderail]") ?? button.parentElement!;
  const safe = SAFE.has(plan.method);
  // GET and HEAD can't carry a body; OPTIONS can, though it's safe.
  const bodyless = plan.method === "GET" || plan.method === "HEAD";
  const apiKey = plan.id.version ? `${plan.id.family}@${plan.id.version}` : plan.id.family;
  const storeId = `${meta.base}|${apiKey}|${plan.id.coordinate}`;
  const uid = (s: string) => `nb-tid-${plan.id.coordinate.replace(/[^a-zA-Z0-9_-]/g, "-")}-${s.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  let uidN = 0;
  const fresh = (s: string) => `${uid(s)}-${++uidN}`;
  const TEXT = { spellcheck: "false", autocomplete: "off", autocapitalize: "none", autocorrect: "off" } as const;
  const NO_PM = { "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other" } as const;

  // ---- The dialog's frame, as the prototype's markup ----
  const titleId = uid("title");
  const chip = rail.querySelector(".nb-cr-head .nb-api-chip")?.cloneNode(true) ?? null;
  const urlEl = el("code", { class: "nb-tid-url" });
  const copyUrl = el("button", { type: "button", class: "nb-tid-copy", "aria-label": "Copy URL", title: "Copy URL" });
  copyUrl.innerHTML = COPY_ICONS;
  const sendTop = el("button", { type: "button", class: "nb-tid-send nb-tid-send-top" }, "Send");
  const sendBottom = el("button", { type: "button", class: "nb-tid-send nb-tid-send-bottom" }, "Send");
  const sendButtons = [sendTop, sendBottom];
  const close = el("button", { type: "button", class: "nb-tid-esc", "aria-label": "Close" }, el("span", { class: "nb-tid-esc-key" }, "Esc"));
  close.insertAdjacentHTML("beforeend", ph(P_X, "nb-tid-esc-x size-4"));
  const envRow = el("div", { class: "nb-tid-envrow", hidden: true });
  const form = el("form", { class: "nb-tid-form", novalidate: true });
  const blocked = el("p", { class: "nb-tid-blocked", hidden: true });
  const inputs = el("div", { class: "nb-tid-raised nb-tid-inputs" }, envRow, form, blocked);
  const codeToggle = el("button", { type: "button", class: "nb-tid-codetoggle", "aria-expanded": "false" }, el("span", {}, "Request code"));
  codeToggle.insertAdjacentHTML("beforeend", ph(P_CARET, "nb-tid-caret size-4"));
  const langSelect = el(
    "select",
    { class: "nb-tid-lang", "aria-label": "Code sample language" },
    el("option", { value: "curl" }, "cURL"),
    el("option", { value: "typescript" }, "TypeScript"),
    el("option", { value: "python" }, "Python"),
  );
  const copySample = el("button", { type: "button", class: "nb-tid-iconbtn", "aria-label": "Copy code", title: "Copy code (your key is left out)" });
  copySample.innerHTML = COPY_ICONS;
  const sampleEl = el("div", { class: "nb-tid-samplewrap nb-cr-body", "aria-label": "Request as code" });
  const statusEl = el("span", { class: "nb-tid-status" });
  const metaEl = el("span", { class: "nb-tid-meta" });
  const staleEl = el("span", { class: "nb-tid-stale", hidden: true }, "Previous request");
  const tabs = el(
    "div",
    { class: "nb-tid-seg", role: "group", "aria-label": "Response view", hidden: true },
    el("button", { type: "button", "aria-pressed": "true", "data-tab": "body" }, "Body"),
    el("button", { type: "button", "aria-pressed": "false", "data-tab": "headers" }, "Headers"),
  );
  const copyBody = el("button", { type: "button", class: "nb-tid-iconbtn", "aria-label": "Copy response body", title: "Copy response body", hidden: true });
  copyBody.innerHTML = COPY_ICONS;
  const elapsedEl = el("span", { class: "nb-tid-waitpill-time" });
  const pill = el(
    "div",
    { class: "nb-tid-waitpill" },
    el(
      "span",
      { class: "nb-tid-waitpill-idle" },
      "Not sent yet ",
      safe ? el("span", { class: "nb-tid-hints" }, el("kbd", {}, isMac ? "⌘" : "Ctrl"), el("kbd", {}, "↵"), " to send") : null,
    ),
    elapsedEl,
  );
  // Before the first answer, the documented one (the rail's response example) sits faint.
  const ghostText = rail.querySelector<HTMLElement>("[data-nb-resp-panel]:not([hidden]) pre")?.textContent ?? "";
  const ghost = ghostText ? el("div", { class: "nb-cr-body nb-tid-respcode", "aria-hidden": "true" }) : null;
  const respBody = el("div", { class: "nb-tid-respbody", "data-phase": "idle" }, ghost, pill);
  const response = el(
    "section",
    { class: "nb-tid-response", "aria-label": "Response" },
    el(
      "div",
      { class: "nb-tid-resphead" },
      el("div", { class: "nb-tid-respsummary" }, el("span", { class: "nb-tid-railtitle" }, "Response"), statusEl, metaEl, staleEl),
      el("div", { class: "nb-tid-respcontrols" }, tabs, copyBody),
    ),
    respBody,
  );
  const railCard = el(
    "div",
    { "data-orientation": "vertical", class: `${LAYER} flex-col nb-tid-railcard` },
    el("div", { class: `${LAYER_HEAD} py-2 nb-tid-railhead` }, el("span", { class: "nb-tid-railtitle" }, "Request"), codeToggle, langSelect, copySample),
    sampleEl,
    response,
  );
  const barCode = el("span", { class: "nb-tid-barcode" });
  const barAction = el("span", { class: "nb-tid-baraction" }, "View response");
  const barStatus = el("button", { type: "button", class: "nb-tid-barstatus", hidden: true }, barCode, barAction);
  barStatus.insertAdjacentHTML("beforeend", ph(P_CARET, "nb-tid-barcaret size-4"));
  const live = el("span", { class: "sr-only", role: "status" });
  const variant = methodVariant(plan.method);
  const dialog = el(
    "dialog",
    { class: "fixed inset-0 z-50 m-0 h-full w-full max-h-full max-w-full bg-transparent p-0 backdrop:bg-black/40 nb-tid", "aria-labelledby": titleId },
    el(
      "div",
      { class: "nb-tid-frame" },
      el(
        "div",
        { class: "nb-tid-shell" },
        el("header", { class: "nb-tid-head" }, el("h2", { id: titleId, class: "nb-tid-title" }, meta.title), close),
        el(
          "div",
          { class: "nb-tid-bar" },
          el(
            "div",
            { "data-orientation": "horizontal", dir: "ltr", class: `${LAYER} flex-row items-stretch nb-tid-barcard` },
            el(
              "div",
              { class: `${LAYER_HEAD} py-2 ps-2 pe-3 self-stretch` },
              chip,
              el("span", { class: "font-mono text-[0.8125rem] font-medium", style: `color:var(--nb-m-${variant})` }, plan.method),
            ),
            el("div", { class: `${LAYER_CONTENT} flex-row items-stretch gap-0 p-0` }, urlEl, copyUrl),
          ),
          sendTop,
        ),
        el("div", { class: "nb-tid-panes" }, inputs, el("aside", { class: "nb-tid-rail", "aria-label": "Request and response" }, railCard)),
        el("div", { class: "nb-tid-actionbar" }, barStatus, sendBottom),
        live,
      ),
    ),
  );
  rail.append(dialog);

  // ---- State ------------------------------------------------------------------
  const small = matchMedia("(max-width: 767px)");
  const host = (() => {
    try {
      return new URL(plan.servers[0]?.url ?? "/", plan.specUrl ?? location.origin).host;
    } catch {
      return location.host;
    }
  })();
  const firstServer = (() => {
    if (typeof meta.server === "number") return Math.min(Math.max(0, meta.server), plan.servers.length - 1);
    if (typeof meta.server === "string") return Math.max(0, plan.servers.findIndex((s) => s.url.startsWith(meta.server as string)));
    return 0;
  })();
  const values: RequestValues = { server: { index: firstServer }, params: {} };
  const initialParams = (): Record<string, ParamValue> =>
    Object.fromEntries(plan.params.filter((p) => p.initial !== undefined || p.required).map((p) => [paramKey(p), startValue(p)]));
  const initialEmpty = (p: PlanParam): ParamValue => (p.schema.type === "array" && !p.content ? [] : "");
  // The sample's value, `null` and `""` included; empty only when it has none.
  const startValue = (p: PlanParam): ParamValue => (p.initial !== undefined ? (p.initial as ParamValue) : initialEmpty(p));
  // The body as the sample sends it, per media type.
  const bodyDrafts = new Map<string, unknown>();
  // Per form media type: the fields its sample sent that the spec doesn't declare, with their type.
  const extraFields = new Map<string, Map<string, PlanSchema["type"]>>();
  const initialBody = (media: PlanMedia): unknown => {
    const seed = plan.body?.initial?.mediaType === media.mediaType ? plan.body.initial.value : undefined;
    if (media.kind === "json") return seed === undefined ? "" : JSON.stringify(seed, null, 2);
    if (media.kind === "text") return typeof seed === "string" ? seed : seed === undefined ? "" : JSON.stringify(seed, null, 2);
    if (media.kind === "bytes") return null;
    return formSeed(media, seed);
  };
  const wireFields = (wire: string): Record<string, unknown> => {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of new URLSearchParams(wire)) {
      const had = out[k];
      out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
    }
    return out;
  };
  const formSeed = (media: PlanMedia, seed: unknown): FormValues => {
    // A URL-encoded example written as the wire form (`a=1&a=2&b=3`) reads as its fields, a repeated name as a list.
    const object: Record<string, unknown> =
      typeof seed === "string" && media.kind === "form"
        ? wireFields(seed)
        : seed && typeof seed === "object" && !Array.isArray(seed) ? (seed as Record<string, unknown>) : {};
    const files = new Set((media.fields ?? []).filter((f) => f.file).map((f) => f.name));
    const fields: FormValues["fields"] = [];
    // Every field the sample sends, the spec's own first: the untouched form sends what the sample shows.
    // Own entries only: a field named `constructor` isn't the object's.
    const names = [...(media.fields ?? []).map((f) => f.name), ...Object.keys(object)];
    for (const name of new Set(names)) {
      if (files.has(name)) continue; // the reader picks files
      let v = Object.hasOwn(object, name) ? object[name] : undefined;
      if (v === undefined) continue;
      // A repeated wire name is a list only where the spec allows one.
      const spec = media.fields?.find((f) => f.name === name);
      if (typeof seed === "string" && Array.isArray(v) && spec && spec.schema.type !== "array") v = v[0];
      // One value per field; a list or object as JSON, encoded on send as the spec says.
      fields.push({ name, value: text(v) });
    }
    return { fields };
  };
  let bodyMedia = plan.body?.initial?.mediaType ?? plan.body?.media[0]?.mediaType ?? "";
  let bodyOn = Boolean(plan.body && (plan.body.required || plan.body.initial));
  // Via the docs site where the proxy runs, else direct. Only a failed direct send offers the other way.
  let delivery: DeliveryMode = meta.info.deliveryModes[0] ?? "direct";
  let alternative = Math.max(0, plan.auth.findIndex((a) => a.schemes.length > 0 && !a.unsupported));
  if (plan.auth.length && plan.auth[alternative]?.unsupported) alternative = Math.max(0, plan.auth.findIndex((a) => !a.unsupported));
  // Credentials in memory, keyed by site base, API, the server's origin and the scheme.
  const credentials = new Map<string, Credential>();
  let remember = false;
  let lang: Lang = (() => {
    const v = store("tab")?.getItem(LANG_KEY);
    return v === "typescript" || v === "python" ? v : "curl";
  })();
  langSelect.value = lang;
  let controller: AbortController | null = null;
  let sendId = 0;
  let last: { outcome: SendOutcome; fingerprint: string } | null = null;
  let tab: "body" | "headers" = "body";
  let confirming = false;
  const touched = new Set<string>();
  // JSON fields whose text doesn't parse, by key: their raw text. The value keeps
  // the last JSON that parsed; Send stops on these.
  const badJson = new Map<string, string>();
  // Each field's control, by its value key (`query:limit`, `body`), for focusing the first invalid one.
  const controls = new Map<string, HTMLElement>();

  const resetValues = () => {
    values.server = { index: firstServer };
    values.params = initialParams() as Record<string, unknown>;
    bodyDrafts.clear();
    extraFields.clear();
    for (const media of plan.body?.media ?? []) bodyDrafts.set(media.mediaType, initialBody(media));
    bodyMedia = plan.body?.initial?.mediaType ?? plan.body?.media[0]?.mediaType ?? "";
    bodyOn = Boolean(plan.body && (plan.body.required || plan.body.initial));
    touched.clear();
    badJson.clear();
  };
  resetValues();
  // Values are kept per operation in the tab (never credentials or files).
  const VALUES_KEY = `nb-tryit-values|${storeId}`;
  try {
    const kept = JSON.parse(store("tab")?.getItem(VALUES_KEY) ?? "null") as {
      server: RequestValues["server"]; params: Record<string, unknown>; body: [string, unknown][]; bodyMedia: string; bodyOn: boolean;
    } | null;
    if (kept) {
      values.server = kept.server;
      values.params = kept.params;
      for (const [k, v] of kept.body) if (typeof v === "string" || (v && typeof v === "object")) bodyDrafts.set(k, v);
      bodyMedia = kept.bodyMedia;
      bodyOn = kept.bodyOn;
    }
  } catch {
    // Unreadable: start from the sample.
  }
  const keepValues = () => {
    const body = [...bodyDrafts].filter(([, v]) => typeof v === "string" || (v && typeof v === "object" && !(v instanceof Blob) && !(v as FormValues).fields?.some((f) => typeof f.value !== "string")));
    try {
      store("tab")?.setItem(VALUES_KEY, JSON.stringify({ server: values.server, params: values.params, body, bodyMedia, bodyOn }));
    } catch {
      // Full or blocked: values stay in memory.
    }
  };

  // ---- Servers and credentials ----------------------------------------------------
  // The server exactly as the request resolves it: keys are kept per this origin,
  // so one only ever goes to the server it was entered for.
  const resolvedServer = () => resolveServer(plan, values, { origin: location.origin });
  const serverOrigin = (): string => resolvedServer()?.origin ?? values.server?.origin ?? "";
  // The server's URL (origin and the spec server's path), for the URL bar.
  const serverBase = (): string => {
    const resolved = resolvedServer();
    return resolved ? `${resolved.origin}${resolved.pathname.replace(/\/+$/, "")}` : serverOrigin();
  };
  const credKey = (scheme: string) => `nb-tryit-cred|${meta.base}|${apiKey}|${serverOrigin()}|${scheme}`;
  const rememberStore = meta.remember === "none" ? null : store(meta.remember === "device" ? "device" : "tab");
  const schemes = () => plan.auth[alternative]?.schemes ?? [];
  const loadRemembered = () => {
    remember = false;
    for (const s of schemes()) {
      const raw = rememberStore?.getItem(credKey(s.scheme));
      if (raw === null || raw === undefined) continue;
      try {
        credentials.set(credKey(s.scheme), JSON.parse(raw) as Credential);
        remember = true;
      } catch {
        // Unreadable: ignore it.
      }
    }
  };
  const writeRemembered = () => {
    if (!rememberStore) return;
    for (const s of schemes()) {
      const value = credentials.get(credKey(s.scheme));
      try {
        if (remember && value !== undefined && value !== "") rememberStore.setItem(credKey(s.scheme), JSON.stringify(value));
        else rememberStore.removeItem(credKey(s.scheme));
      } catch {
        // Storage failed: the credential stays in memory only.
      }
    }
  };
  loadRemembered();

  // ---- The request ---------------------------------------------------------------------
  const bodyValue = (): RequestValues["body"] => {
    if (!plan.body || !bodyOn || bodyless) return undefined;
    const media = plan.body.media.find((m) => m.mediaType === bodyMedia);
    if (!media) return undefined;
    const draft = bodyDrafts.get(media.mediaType);
    if (media.kind === "bytes") return draft instanceof Blob ? { mediaType: media.mediaType, value: draft } : undefined;
    return { mediaType: media.mediaType, value: draft ?? "" };
  };
  const requestValues = (placeholders: boolean): RequestValues => {
    // No prototype: a scheme may be named anything, __proto__ included.
    const creds: Record<string, Credential> = Object.create(null);
    for (const s of schemes()) {
      const value = credentials.get(credKey(s.scheme));
      if (value !== undefined && value !== "") creds[s.scheme] = value;
      else if (placeholders) creds[s.scheme] = s.type === "basic" ? { username: "<username>", password: "<password>" } : `<${s.type === "apiKey" ? s.name : "token"}>`;
    }
    const params = { ...values.params };
    if (placeholders) for (const p of plan.params) if (p.required && params[paramKey(p)] === undefined) params[paramKey(p)] = `<${p.name}>`;
    const out: RequestValues = { server: values.server!, params };
    const body = bodyValue();
    if (body) out.body = body;
    if (plan.auth.length) out.auth = { alternative, credentials: creds };
    return out;
  };
  const current = (placeholders = false) => serializeRequest(plan, requestValues(placeholders), { origin: location.origin });
  // A file counts by identity: two picks of the same name and size are two files.
  const blobIds = new WeakMap<Blob, number>();
  let blobCount = 0;
  const blobId = (blob: Blob) => {
    if (!blobIds.has(blob)) blobIds.set(blob, ++blobCount);
    return blobIds.get(blob);
  };
  const bodyPrint = (body: HttpRequest["body"]) => {
    if (!body) return null;
    if ("text" in body) return body.text;
    if (body.kind === "form") return body.fields;
    if (body.kind === "multipart") return body.parts.map((part) => [part.name, typeof part.value === "string" ? part.value : blobId(part.value), part.filename, part.contentType]);
    return blobId(body.file);
  };
  const fingerprint = (r: HttpRequest) => JSON.stringify([r.method, r.url, r.headers, bodyPrint(r.body)]);

  const sendLabel = (): { short: string; long: string } => {
    let target = host;
    try {
      const r = current(true);
      if (!("refused" in r)) target = new URL(r.url).host;
    } catch {
      // Keep the spec's host.
    }
    return safe ? { short: "Send", long: "Send" } : { short: `Send ${plan.method}`, long: `Send ${plan.method} to ${target}` };
  };
  const sendState = (state: { stop?: boolean; disabled?: boolean; confirm?: boolean }) => {
    const label = sendLabel();
    for (const b of sendButtons) {
      if (state.stop) b.textContent = "Stop";
      else if (state.confirm) b.textContent = `Confirm ${plan.method}`;
      else b.textContent = b === sendBottom ? label.long : label.short;
      b.setAttribute("aria-label", state.stop ? "Stop" : state.confirm ? `Confirm: ${label.long}` : label.long);
      b.classList.toggle("nb-tid-stop", Boolean(state.stop));
      if (state.disabled !== undefined) b.disabled = state.disabled;
    }
  };

  const render = (): void => {
    const shown = current(true);
    const placeholderUrl = "refused" in shown ? "" : maskText(shown.url, shown.secrets);
    const serverUrl = serverBase();
    const base = placeholderUrl.startsWith(serverUrl) ? serverUrl : "";
    const option = basePicker.options[values.server?.index ?? 0];
    if (option) option.textContent = readable(serverUrl);
    urlBase.textContent = readable(base);
    urlRest.textContent = readable(small.matches ? placeholderUrl.slice(base.length).replace(/\?.*$/, "") : placeholderUrl.slice(base.length));
    if ("refused" in shown) {
      sampleEl.replaceChildren(el("p", { class: "nb-tid-note" }, shown.refused));
    } else {
      paint(sampleEl, renderSample(shown, lang, { mask: true }), SAMPLE_LANG[lang], "Request as code");
    }
    if (!controller && !confirming) sendState({});
    const real = current(false);
    const reason = "refused" in real && !/^Fill in |^Enter the /.test(real.refused) ? real.refused : null;
    blocked.textContent = reason ?? "";
    blocked.hidden = !reason;
    if (last && !controller) staleEl.hidden = !("refused" in real) && fingerprint(real) === last.fingerprint;
    renderTransit();
    keepValues();
  };

  // ---- Inputs ------------------------------------------------------------------------
  const card = (title: string, body: Node[], opts: { badge?: Node | null; tools?: Node[]; grow?: boolean } = {}) =>
    el(
      "section",
      { class: `nb-tid-card${opts.grow ? " nb-tid-grow" : ""}`, "aria-label": title },
      el("div", { class: "nb-tid-cardhead" }, el("h3", { class: "nb-tid-cardtitle" }, title), opts.badge, el("div", { class: "nb-tid-cardtools" }, ...(opts.tools ?? []))),
      el("div", { class: "nb-tid-cardbody" }, ...body),
    );
  const badge = (label: string, outline = false) => el("span", { class: `nb-tid-badge${outline ? " nb-tid-badge-outline" : ""}`, title: label }, label);
  const checkbox = (label: string, attrs: Record<string, string> = {}) => {
    const box = el("input", { type: "checkbox", ...attrs });
    return { box, node: el("label", { class: "nb-tid-check" }, box, el("span", { class: "nb-tid-box", "aria-hidden": "true" }), label) };
  };
  const note = (message: string, warn = false) => el("p", { class: `nb-tid-note${warn ? " nb-tid-note-warn" : ""}` }, message);
  const iconButton = (cls: string, label: string, icon: string) => {
    const b = el("button", { type: "button", class: `nb-tid-iconbtn ${cls}`, "aria-label": label, title: label });
    b.innerHTML = icon;
    return b;
  };
  const nf = new Intl.NumberFormat();
  const range = (p: PlanParam) => {
    const s = p.schema.type === "array" ? (p.schema.items ?? {}) : p.schema;
    return s.minimum !== undefined && s.maximum !== undefined
      ? `${nf.format(s.minimum)}–${nf.format(s.maximum)}`
      : s.minimum !== undefined ? `≥ ${nf.format(s.minimum)}` : s.maximum !== undefined ? `≤ ${nf.format(s.maximum)}` : "";
  };
  const typeLabel = (p: PlanParam) => {
    if (p.content) return p.content;
    const s = p.schema;
    const type = s.type === "array" ? `${s.items?.type ?? "string"}[]` : (s.type ?? "string");
    const format = s.type === "array" ? s.items?.format : s.format;
    return [type, format ?? range(p)].filter(Boolean).join(", ");
  };
  const keyboard = (p: PlanParam): string | undefined => {
    const s = p.schema.type === "array" ? (p.schema.items ?? {}) : p.schema;
    if (s.type === "integer") return "numeric";
    if (s.type === "number") return "decimal";
    return s.format === "email" ? "email" : s.format === "uri" ? "url" : undefined;
  };
  // Checks run when a field loses focus, then live until it's fixed.
  const watch = (p: PlanParam, control: HTMLElement, error: HTMLElement) => {
    const key = paramKey(p);
    error.id = fresh("err");
    control.setAttribute("aria-describedby", error.id);
    const run = () => {
      const value = values.params[key];
      const issues = value === undefined ? [] : checkParam(p, value);
      const pathEmpty = p.in === "path" && value === "";
      const messages = [...(pathEmpty ? ["A path parameter can't be empty."] : []), ...issues.map((i) => i.message)];
      error.textContent = messages.join(" ");
      error.classList.toggle("nb-tid-advice", messages.length > 0 && !pathEmpty && issues.every((i) => !i.blocking));
      if (messages.length && (pathEmpty || issues.some((i) => i.blocking))) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    };
    control.addEventListener("focusout", () => {
      touched.add(key);
      run();
    });
    control.addEventListener("input", () => touched.has(key) && run());
    control.addEventListener("change", () => touched.has(key) && run());
    if (touched.has(key)) run();
    return run;
  };

  const nameLine = (p: PlanParam, id: string, tag: "label" | "span", tools: Node[]) =>
    el(
      "div",
      { class: "nb-tid-line" },
      el(
        tag,
        { class: "nb-tid-name", ...(tag === "label" ? { for: id } : {}) },
        // The name alone labels the control; the type beside it isn't part of it.
        el("span", { class: "nb-tid-nametext", ...(tag === "span" ? { id } : {}) }, p.name, p.required ? el("span", { class: "nb-tid-reqmark", "aria-label": "required" }, "*") : null),
        el("span", { class: "nb-tid-type" }, typeLabel(p)),
      ),
      ...tools,
    );
  const help = (p: PlanParam) => (p.description ? el("p", { class: "nb-tid-desc" }, p.description) : null);
  const needsJson = (p: PlanParam) =>
    Boolean(p.content) || p.schema.type === "object" || (p.schema.type === "array" && (p.schema.items?.type === "object" || p.schema.items?.type === "array"));

  // One parameter: name and type over the control its schema calls for.
  const paramRow = (p: PlanParam, onRemove?: () => void): { node: HTMLElement; focus: () => void } => {
    const key = paramKey(p);
    const id = fresh(key);
    const initial = startValue(p);
    const set = (value: unknown) => {
      values.params[key] = value;
      resetButton.hidden = JSON.stringify(value) === JSON.stringify(initial);
      render();
    };
    const resetButton = iconButton("nb-tid-rm", `Reset ${p.name}`, ph(P_RESET, "size-3.5"));
    resetButton.hidden = JSON.stringify(values.params[key]) === JSON.stringify(initial);
    const tools: Node[] = [resetButton];
    if (onRemove) {
      const rm = iconButton("nb-tid-rm", `Remove ${p.name}`, X);
      rm.title = "Don't send";
      rm.addEventListener("click", onRemove);
      tools.push(rm);
    }
    const error = el("p", { class: "nb-tid-fielderr", role: "status" });
    // The visible name labels the row and, for a single control, the control itself.
    const nameId = `${id}-name`;
    const row = (control: HTMLElement, ...rest: (Node | null)[]) =>
      el("div", { class: "nb-tid-row", role: "group", "aria-labelledby": nameId }, nameLine(p, nameId, "span", tools), control, ...rest, help(p), error);
    let node: HTMLElement;
    let focus: () => void;
    let rerun: () => void = () => {};
    const drawControl = () => {
      const value = values.params[key];
      const nullable = p.schema.nullable === true;
      if (needsJson(p)) {
        // A value a control can't keep faithfully: JSON, parsed as typed.
        const area = el("textarea", { id, class: "nb-tid-input nb-tid-jsonfield", rows: "3", ...TEXT, ...NO_PM });
        // No sample value and nothing entered: an empty field, which Send asks to fill in.
        if (p.initial === undefined && (value === "" || value === undefined) && !badJson.has(key)) badJson.set(key, "");
        const unparsed = badJson.get(key);
        area.value = unparsed ?? JSON.stringify(value, null, 2);
        const showInvalid = (problem: string | null) => {
          error.textContent = problem ?? "";
          if (problem) area.setAttribute("aria-invalid", "true");
          else area.removeAttribute("aria-invalid");
        };
        showInvalid(unparsed !== undefined && unparsed.trim() !== "" ? jsonProblem(unparsed) : null);
        area.addEventListener("input", () => {
          const problem = jsonProblem(area.value);
          if (problem) {
            badJson.set(key, area.value);
            resetButton.hidden = false;
            showInvalid(area.value.trim() !== "" ? problem : null);
            render();
            return;
          }
          badJson.delete(key);
          showInvalid(null);
          set(JSON.parse(area.value));
        });
        return { control: area, focus: () => area.focus() };
      }
      if (p.schema.type === "boolean") {
        const options = ["true", "false", ...(nullable ? ["null"] : [])];
        const pick = value === null ? "null" : text(value);
        const radios = options.map((v) => {
          const r = el("input", { type: "radio", name: id, value: v });
          r.checked = v === pick;
          r.addEventListener("change", () => r.checked && set(v === "null" ? null : v));
          return r;
        });
        return {
          control: el("div", { class: "nb-tid-radios" }, ...radios.map((r) => el("label", { class: "nb-tid-radio" }, r, el("span", { class: "nb-tid-dot", "aria-hidden": "true" }), r.value))),
          focus: () => (radios.find((r) => r.checked) ?? radios[0]!).focus(),
        };
      }
      if (p.schema.type === "array" && p.schema.items?.enum && p.schema.uniqueItems) {
        // Known values, each at most once: ticked in the order they're sent.
        const chosen = Array.isArray(value) ? value.map(text) : [];
        const boxes = p.schema.items.enum.map((o) => {
          const c = checkbox(text(o), { value: text(o) });
          c.box.checked = chosen.includes(text(o));
          c.box.addEventListener("change", () => {
            const now = (Array.isArray(values.params[key]) ? (values.params[key] as string[]) : []).filter((x) => x !== c.box.value);
            if (c.box.checked) now.push(c.box.value);
            set(now);
          });
          return c;
        });
        return { control: el("div", { class: "nb-tid-checks" }, ...boxes.map((b) => b.node)), focus: () => boxes[0]?.box.focus() };
      }
      if (p.schema.type === "array") {
        // Any list: one field per item, order, duplicates and empty items kept.
        const list = el("div", { class: "nb-tid-list" });
        const enumItems = p.schema.items?.enum;
        const collect = () => set([...list.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")].map((i) => i.value));
        const relabel = () =>
          list.querySelectorAll<HTMLElement>(".nb-tid-item").forEach((item, i) => {
            item.querySelector("input, select")!.setAttribute("aria-label", `${p.name}, item ${i + 1}`);
            item.querySelector("button")!.setAttribute("aria-label", `Remove ${p.name} item ${i + 1}`);
          });
        const add = el("button", { type: "button", class: "nb-tid-btn" }, el("span", { "aria-hidden": "true" }, "+"), "Add item");
        const addItem = (v: string, focusIt: boolean) => {
          const input = enumItems
            ? el("select", { class: "nb-tid-input nb-tid-select" }, ...enumItems.map((o) => el("option", { value: text(o) }, text(o))))
            : el("input", { class: "nb-tid-input", type: "text", inputmode: keyboard(p), ...TEXT, ...NO_PM });
          input.value = v;
          input.addEventListener(enumItems ? "change" : "input", collect);
          const rm = iconButton("", "", X);
          const item = el("div", { class: "nb-tid-item" }, input, rm);
          rm.addEventListener("click", () => {
            const next = (item.nextElementSibling ?? item.previousElementSibling)?.querySelector<HTMLElement>("input, select");
            item.remove();
            relabel();
            collect();
            (next ?? add).focus();
          });
          list.append(item);
          relabel();
          if (focusIt) input.focus();
        };
        add.addEventListener("click", () => {
          addItem(enumItems ? text(enumItems[0]) : "", true);
          collect();
        });
        for (const v of Array.isArray(value) ? value : []) addItem(text(v), false);
        return { control: el("div", {}, list, el("div", {}, add)), focus: () => (list.querySelector<HTMLElement>("input, select") ?? add).focus() };
      }
      if (p.schema.enum) {
        const options = [...p.schema.enum.map(text), ...(nullable && !p.schema.enum.includes(null) ? ["null"] : [])];
        const select = el("select", { id, class: "nb-tid-input nb-tid-select" }, ...options.map((o) => el("option", { value: o }, o)));
        const current = value === null ? "null" : text(value);
        // No value yet: say so, rather than show an option that isn't the value.
        if (!options.includes(current)) select.prepend(el("option", { value: "" }, "Choose a value"));
        select.value = options.includes(current) ? current : "";
        select.addEventListener("change", () => set(select.value === "null" && nullable ? null : select.value));
        return { control: select, focus: () => select.focus() };
      }
      const input = el("input", { id, class: "nb-tid-input", type: "text", inputmode: keyboard(p), ...TEXT, ...NO_PM });
      input.value = text(value);
      input.addEventListener("input", () => set(input.value));
      return { control: input, focus: () => input.focus() };
    };
    const draw = () => {
      const drawn = drawControl();
      if (drawn.control.matches("input, select, textarea")) drawn.control.setAttribute("aria-labelledby", nameId);
      return drawn;
    };
    const built = draw();
    controls.set(key, built.control);
    node = row(built.control);
    focus = built.focus;
    rerun = watch(p, built.control, error);
    resetButton.addEventListener("click", () => {
      values.params[key] = initial;
      badJson.delete(key);
      const fresh2 = draw();
      (controls.get(key) ?? built.control).replaceWith(fresh2.control);
      controls.set(key, fresh2.control);
      rerun = watch(p, fresh2.control, error);
      error.textContent = "";
      resetButton.hidden = true;
      render();
      fresh2.focus();
    });
    void rerun;
    return { node, focus };
  };

  // One location's parameters: present ones as rows, absent optional ones a chip away.
  const locationSection = (location: PlanParam["in"], label: string): HTMLElement | null => {
    const params = plan.params.filter((p) => p.in === location && !p.ignored);
    if (!params.length) return null;
    const rows = el("div", { class: "nb-tid-rows" });
    const optional = el("div", { class: "nb-tid-optional" }, el("span", { class: "nb-tid-optional-label" }, "Optional"));
    const chips = new Map<string, HTMLButtonElement>();
    const syncOptional = () => (optional.hidden = ![...chips.values()].some((c) => !c.hidden));
    const addRow = (p: PlanParam, focusIt: boolean) => {
      const key = paramKey(p);
      if (values.params[key] === undefined) values.params[key] = startValue(p);
      const row = paramRow(
        p,
        p.required
          ? undefined
          : () => {
              delete values.params[key];
              badJson.delete(key);
              row.node.remove();
              const chip = chips.get(key)!;
              chip.hidden = false;
              syncOptional();
              render();
              chip.focus();
            },
      );
      rows.append(row.node);
      if (focusIt) row.focus();
    };
    for (const p of params) {
      const key = paramKey(p);
      if (p.refused) {
        rows.append(note(`${p.name}: ${p.refused}`, true));
        continue;
      }
      if (!p.required) {
        const chip = el("button", { type: "button", class: "nb-tid-btn nb-tid-chip", title: p.description ?? "", "aria-label": `Add ${p.name}` }, el("span", { "aria-hidden": "true" }, "+"), p.name);
        chip.addEventListener("click", () => {
          chip.hidden = true;
          syncOptional();
          addRow(p, true);
          render();
        });
        chips.set(key, chip);
        optional.append(chip);
        chip.hidden = values.params[key] !== undefined;
      }
      if (p.required || values.params[key] !== undefined) addRow(p, false);
    }
    syncOptional();
    return el("div", { class: "nb-tid-section" }, el("h4", { class: "nb-tid-sectiontitle" }, label, el("span", {}, String(params.length))), rows, optional);
  };

  // ---- Where the key goes ------------------------------------------------------------------
  const transit = el("p", { class: "nb-tid-desc nb-tid-transit" });
  const renderTransit = () => {
    let apiHost = host;
    try {
      apiHost = new URL(serverOrigin()).host || host;
    } catch {
      // Keep the spec's host.
    }
    const kept = meta.remember === "none" ? "Not stored." : "Not stored unless you tick Remember.";
    const queryKey = schemes().some((s) => s.type === "apiKey" && s.in === "query") ? " Your key travels in the URL's query string." : "";
    // The docs site's own API goes direct, whatever the choice.
    transit.textContent =
      delivery === "proxy" && !sameOrigin(serverOrigin(), location.origin)
        ? `Sent through ${location.host} to ${apiHost}. Not logged. ${kept}${queryKey}`
        : `Sent from your browser to ${apiHost}. ${kept}${queryKey}${plan.send.credentials === "include" ? " Your browser's cookies for the API go with it." : ""}`;
  };
  // ---- Authorization ---------------------------------------------------------------------
  const authRows = el("div", { class: "nb-tid-rows" });
  const drawAuth = () => {
    authRows.replaceChildren();
    const chosen = plan.auth[alternative];
    if (!chosen) return;
    if (chosen.unsupported) {
      authRows.append(note(chosen.unsupported, true));
      return;
    }
    if (!chosen.schemes.length) authRows.append(note("Sent without credentials. Some responses may differ for signed-in callers."));
    if (chosen.schemes.length > 1) authRows.append(note("Send all of these together."));
    for (const scheme of chosen.schemes) authRows.append(...credentialFields(scheme));
    (authRows.querySelector(".nb-tid-row:last-of-type") ?? authRows).append(serverNote);
  };
  const keyField = (label: string, id: string, input: HTMLInputElement, hint?: string) => {
    const reveal = iconButton("nb-tid-reveal", `Show ${label}`, EYE);
    reveal.setAttribute("aria-pressed", "false");
    reveal.addEventListener("click", () => {
      const showing = input.type === "password";
      input.type = showing ? "text" : "password";
      reveal.setAttribute("aria-pressed", String(showing));
      reveal.setAttribute("aria-label", `${showing ? "Hide" : "Show"} ${label}`);
      reveal.title = showing ? "Hide" : "Show";
      reveal.innerHTML = showing ? EYE_OFF : EYE;
    });
    return el(
      "div",
      { class: "nb-tid-row" },
      el("label", { class: "nb-tid-name nb-tid-plain", for: id }, label),
      el("span", { class: "nb-tid-keyfield" }, input, reveal),
      hint ? el("p", { class: "nb-tid-desc" }, hint) : null,
    );
  };
  const credentialFields = (scheme: PlanAuth): HTMLElement[] => {
    const id = uid(`auth-${scheme.scheme}`);
    const key = credKey(scheme.scheme);
    const stored = credentials.get(key);
    const changed = () => {
      writeRemembered();
      render();
    };
    // Credential fields stay open to password managers; everything else opts out.
    if (scheme.type === "basic") {
      const user = el("input", { id, class: "nb-tid-input", type: "text", autocomplete: "username", "data-nb-tid-key": true });
      const pass = el("input", { id: `${id}-pass`, class: "nb-tid-input", type: "password", autocomplete: "current-password", "data-nb-tid-key": true });
      if (stored && typeof stored === "object") {
        user.value = stored.username;
        pass.value = stored.password;
      }
      const set = () => {
        credentials.set(key, { username: user.value, password: pass.value });
        changed();
      };
      user.addEventListener("input", set);
      pass.addEventListener("input", set);
      return [
        el("div", { class: "nb-tid-row" }, el("label", { class: "nb-tid-name nb-tid-plain", for: id }, "Username"), user),
        keyField("Password", pass.id, pass, "Sent in the Authorization header"),
      ];
    }
    const label = scheme.type === "apiKey" ? scheme.name : scheme.type === "bearer" ? "Bearer token" : "Access token";
    const where = scheme.type === "apiKey" ? `Sent in the ${scheme.in === "query" ? "query string" : scheme.in === "cookie" ? "cookie" : `${scheme.name} header`}` : "Sent in the Authorization header";
    const input = el("input", { id, class: "nb-tid-input", type: "password", placeholder: "Paste your key", autocomplete: "off", "data-nb-tid-key": true });
    input.value = typeof stored === "string" ? stored : "";
    input.addEventListener("input", () => {
      credentials.set(key, input.value);
      changed();
    });
    const rows = [keyField(label, id, input, where)];
    if ((scheme.type === "oauth2" || scheme.type === "openIdConnect") && (scheme.scopes.length || scheme.tokenUrl)) {
      rows[0]!.append(
        el(
          "p",
          { class: "nb-tid-desc" },
          scheme.scopes.length ? `Scopes: ${scheme.scopes.join(", ")}. ` : "",
          scheme.tokenUrl ? el("span", {}, "Get a token from ", el("code", {}, scheme.tokenUrl), ".") : null,
        ),
      );
    }
    return rows;
  };
  const serverNote = el("p", { class: "nb-tid-desc", role: "status" });
  serverNote.hidden = true;
  const authCard = (): HTMLElement | null => {
    if (!plan.auth.length) return null;
    const optional = plan.auth.some((a) => !a.schemes.length);
    const body: Node[] = [];
    if (plan.auth.length > 1) {
      const id = uid("authalt");
      const select = el("select", { id, class: "nb-tid-input nb-tid-select" });
      plan.auth.forEach((alt, i) => select.append(el("option", { value: String(i) }, alt.label)));
      select.value = String(alternative);
      select.addEventListener("change", () => {
        alternative = Number(select.value);
        loadRemembered();
        rememberBox.checked = remember;
        drawAuth();
        render();
      });
      body.push(el("div", { class: "nb-tid-row" }, el("label", { class: "nb-tid-name nb-tid-plain", for: id }, "Method"), select));
    }
    drawAuth();
    body.unshift(el("div", { class: "nb-tid-rows" }, el("div", { class: "nb-tid-row" }, transit)));
    body.push(authRows);
    const tools: Node[] = [];
    if (meta.remember !== "none") tools.push(rememberNode);
    const clear = el("button", { type: "button", class: "nb-tid-btn" }, "Clear");
    clear.addEventListener("click", () => {
      for (const s of schemes()) {
        credentials.delete(credKey(s.scheme));
        rememberStore?.removeItem(credKey(s.scheme));
      }
      remember = false;
      rememberBox.checked = false;
      drawAuth();
      render();
      authRows.querySelector<HTMLElement>("input")?.focus();
    });
    tools.push(clear);
    return card("Authorization", body, { badge: optional ? badge("Optional") : null, tools });
  };
  const { box: rememberBox, node: rememberNode } = checkbox(meta.remember === "device" ? "Remember on this device" : "Remember in this tab");
  rememberBox.checked = remember;
  rememberBox.addEventListener("change", () => {
    remember = rememberBox.checked;
    writeRemembered();
  });

  // ---- URL: the server and its variables -------------------------------------------------
  const basePicker = el("select", { class: "nb-tid-base", "aria-label": "Server" });
  plan.servers.forEach((s, i) => basePicker.append(el("option", { value: String(i), title: s.description ?? "" }, s.url)));
  const urlBase = el("span", { class: "nb-tid-url-server" });
  const urlRest = el("span", {});
  const serverRows = el("div", { class: "nb-tid-rows" });
  const serverCard = card("URL", [serverRows]);
  const serverChanged = (before: string) => {
    if (serverOrigin() !== before) {
      loadRemembered();
      rememberBox.checked = remember;
      drawAuth();
      if (plan.auth.some((a) => a.schemes.length)) {
        serverNote.textContent = "Keys are kept per server: this server has its own.";
        serverNote.hidden = false;
      }
    }
    render();
  };
  basePicker.addEventListener("change", () => {
    const before = serverOrigin();
    values.server = { index: Number(basePicker.value) };
    drawServer();
    serverChanged(before);
  });
  const drawServer = () => {
    serverRows.replaceChildren();
    const server = plan.servers[values.server?.index ?? 0];
    for (const v of server?.variables ?? []) {
      const id = uid(`var-${v.name}`);
      const control = v.enum
        ? el("select", { id, class: "nb-tid-input nb-tid-select" }, ...v.enum.map((o) => el("option", { value: o }, o)))
        : el("input", { id, class: "nb-tid-input", type: "text", ...TEXT, ...NO_PM });
      const given = values.server?.variables;
      control.value = given && Object.hasOwn(given, v.name) ? given[v.name]! : v.default;
      control.addEventListener(v.enum ? "change" : "input", () => {
        const before = serverOrigin();
        values.server = { ...values.server!, variables: { ...values.server?.variables, [v.name]: control.value } };
        serverChanged(before);
      });
      serverRows.append(
        el(
          "div",
          { class: "nb-tid-row" },
          el("label", { class: "nb-tid-name", for: id }, el("span", { class: "nb-tid-nametext" }, v.name)),
          control,
          v.description ? el("p", { class: "nb-tid-desc" }, v.description) : null,
        ),
      );
    }
    if (plan.send.servers === "editable") {
      const id = uid("origin");
      const input = el("input", { id, class: "nb-tid-input", type: "text", inputmode: "url", placeholder: "https://staging.example.com", ...TEXT, ...NO_PM });
      input.value = values.server?.origin ?? "";
      input.addEventListener("change", () => {
        const before = serverOrigin();
        const { origin: _, ...rest } = values.server!;
        values.server = input.value ? { ...rest, origin: input.value } : rest;
        serverChanged(before);
      });
      serverRows.append(
        el(
          "div",
          { class: "nb-tid-row" },
          el("label", { class: "nb-tid-name nb-tid-plain", for: id }, "Origin"),
          input,
          el("p", { class: "nb-tid-desc" }, delivery === "proxy" ? "Another origin this API allows. The path stays the spec's." : "Any origin. The path stays the spec's."),
        ),
      );
    }
    serverCard.hidden = !serverRows.childElementCount;
  };

  // ---- Body ------------------------------------------------------------------------------
  const bodySlot = el("div", { class: "nb-tid-bodyslot" });
  const bodyError = el("p", { class: "nb-tid-error", id: uid("body-error"), "aria-live": "polite" });
  const drawBody = () => {
    const media = plan.body?.media.find((m) => m.mediaType === bodyMedia);
    bodySlot.replaceChildren();
    bodyError.textContent = "";
    if (!media) return;
    if (media.kind === "json" || media.kind === "text") return bodySlot.append(editor(media));
    if (media.kind === "bytes") return bodySlot.append(fileBody(media));
    bodySlot.append(formBody(media));
  };
  const editor = (media: PlanMedia): HTMLElement => {
    const isJson = media.kind === "json";
    const area = el("textarea", { class: "nb-tid-editor", spellcheck: "false", autocapitalize: "none", autocorrect: "off", autocomplete: "off", "aria-label": `Request body (${media.mediaType})`, wrap: "off" });
    area.setAttribute("aria-describedby", bodyError.id);
    area.value = text(bodyDrafts.get(media.mediaType));
    // The editor is a textarea laid exactly over highlighted code: it types; the code underneath shows.
    const under = el("div", { class: "nb-cr-body nb-tid-under", "aria-hidden": "true", inert: true });
    const paintUnder = () => paint(under, area.value.endsWith("\n") ? `${area.value} ` : area.value || " ", isJson ? "json" : "text", "");
    // The body is sent as typed, tabs included (TSV, Makefiles): the code underneath shares the tab width.
    const set = () => {
      bodyDrafts.set(media.mediaType, area.value);
      bodyError.textContent = "";
      area.removeAttribute("aria-invalid");
      if (isJson && bodyOn) {
        try {
          JSON.parse(area.value);
        } catch {
          bodyError.textContent = area.value.trim() ? "This isn't valid JSON." : "Enter a JSON body.";
          area.setAttribute("aria-invalid", "true");
        }
      }
      paintUnder();
      render();
    };
    area.addEventListener("input", set);
    area.addEventListener("scroll", () => {
      under.scrollLeft = area.scrollLeft;
      under.scrollTop = area.scrollTop;
    });
    // Tab indents; Shift+Tab and Escape still leave the editor.
    area.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
        set();
      }
    });
    paintUnder();
    controls.set("body", area);
    return el("div", { class: "nb-tid-editorbox" }, el("div", { class: "nb-tid-editorwrap" }, under, area));
  };
  const fileBody = (media: PlanMedia): HTMLElement => {
    const id = uid("bodyfile");
    const input = el("input", { id, type: "file", class: "nb-tid-file" });
    const draft = bodyDrafts.get(media.mediaType);
    const status = el("p", { class: "nb-tid-desc" }, draft instanceof File ? `${draft.name}, ${size(draft.size)}` : "No file chosen.");
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      bodyDrafts.set(media.mediaType, file);
      status.textContent = file ? `${file.name}, ${size(file.size)}` : "No file chosen.";
      render();
    });
    return el("div", { class: "nb-tid-row" }, el("label", { class: "nb-tid-name nb-tid-plain", for: id }, `The body (${media.mediaType})`), input, status);
  };
  const formBody = (media: PlanMedia): HTMLElement => {
    const rows = el("div", { class: "nb-tid-rows" });
    const draft = (bodyDrafts.get(media.mediaType) as FormValues | undefined) ?? { fields: [] };
    // Files already chosen in this draft stay chosen (a file input can't show them again).
    const files = new Map<string, File[]>();
    for (const f of draft.fields) if (f.value instanceof File) files.set(f.name, [...(files.get(f.name) ?? []), f.value]);
    const textValues = new Map<string, string>(draft.fields.filter((f) => typeof f.value === "string").map((f) => [f.name, f.value as string]));
    // The spec's fields, then any the sample sends that it doesn't declare. Those
    // stay listed once cleared, until Reset, so they can be filled in again.
    const declared = new Set((media.fields ?? []).map((f) => f.name));
    const extras = extraFields.get(media.mediaType) ?? new Map<string, PlanSchema["type"]>();
    extraFields.set(media.mediaType, extras);
    for (const [name, value] of textValues) {
      if (!declared.has(name) && !extras.has(name)) extras.set(name, /^\s*\[/.test(value) ? "array" : /^\s*\{/.test(value) ? "object" : "string");
    }
    const shown: PlanBodyField[] = [
      ...(media.fields ?? []),
      ...[...extras].map(([name, type]): PlanBodyField => ({ name, required: false, schema: type ? { type } : {} })),
    ];
    const collect = () => {
      const fields: FormValues["fields"] = [];
      for (const field of shown) {
        if (field.file) for (const f of files.get(field.name) ?? []) fields.push({ name: field.name, value: f, filename: f.name });
        else if (textValues.has(field.name)) fields.push({ name: field.name, value: textValues.get(field.name)! });
      }
      bodyDrafts.set(media.mediaType, { fields });
      render();
    };
    const fieldRow = (field: PlanBodyField) => {
      const id = fresh(`body-${field.name}`);
      const label = el(
        "label",
        { class: "nb-tid-name", for: id },
        el("span", { class: "nb-tid-nametext" }, field.name, field.required ? el("span", { class: "nb-tid-reqmark", "aria-label": "required" }, "*") : null),
        el("span", { class: "nb-tid-type" }, field.file ? (field.file === "many" ? "files" : "file") : (field.schema.type ?? "string")),
      );
      if (field.file) {
        const input = el("input", { id, type: "file", class: "nb-tid-file", multiple: field.file === "many" });
        controls.set(`body:${field.name}`, input);
        const chosen = el("p", { class: "nb-tid-desc" });
        const showChosen = () => {
          const list = files.get(field.name) ?? [];
          chosen.textContent = `Sending ${list.map((f) => `${f.name} (${size(f.size)})`).join(", ")}`;
          chosen.hidden = list.length === 0;
        };
        showChosen();
        input.addEventListener("change", () => {
          files.set(field.name, [...(input.files ?? [])]);
          showChosen();
          collect();
        });
        return el("div", { class: "nb-tid-row" }, label, input, chosen, field.description ? el("p", { class: "nb-tid-desc" }, field.description) : null);
      }
      const input = el("input", { id, class: "nb-tid-input", type: "text", ...TEXT, ...NO_PM });
      input.value = textValues.get(field.name) ?? "";
      controls.set(`body:${field.name}`, input);
      input.addEventListener("input", () => {
        if (input.value === "" && !field.required) textValues.delete(field.name);
        else textValues.set(field.name, input.value);
        collect();
      });
      return el("div", { class: "nb-tid-row" }, label, input, field.description ? el("p", { class: "nb-tid-desc" }, field.description) : null);
    };
    for (const field of shown) rows.append(fieldRow(field));
    if (!shown.length) rows.append(note("The spec lists no fields for this body."));
    return rows;
  };
  const bodyCard = (): HTMLElement | null => {
    if (!plan.body || bodyless) return null;
    const tools: Node[] = [];
    const typeBadge = badge(bodyMedia, true);
    if (plan.body.media.length > 1) {
      const pick = el("select", { class: "nb-tid-input nb-tid-select nb-tid-example", "aria-label": "Media type" }, ...plan.body.media.map((m) => el("option", { value: m.mediaType }, m.mediaType)));
      pick.value = bodyMedia;
      pick.addEventListener("change", () => {
        bodyMedia = pick.value;
        typeBadge.textContent = bodyMedia;
        drawBody();
        render();
      });
      tools.push(pick);
    }
    if (plan.body.examples.length > 1) {
      const pick = el("select", { class: "nb-tid-input nb-tid-select nb-tid-example", "aria-label": "Example" }, ...plan.body.examples.map((e) => el("option", { value: e.id }, e.label)));
      pick.addEventListener("change", () => {
        const chosen = plan.body!.examples.find((e) => e.id === pick.value);
        const media = plan.body!.media.find((m) => m.mediaType === bodyMedia);
        if (!chosen || !media) return;
        bodyDrafts.set(media.mediaType, media.kind === "json" ? JSON.stringify(chosen.value, null, 2) : media.kind === "text" ? text(chosen.value) : formSeed(media, chosen.value));
        drawBody();
        render();
      });
      tools.push(pick);
    }
    if (!plan.body.required) {
      const { box, node } = checkbox("Send a body");
      box.checked = bodyOn;
      bodySlot.hidden = !bodyOn;
      box.addEventListener("change", () => {
        bodyOn = box.checked;
        bodySlot.hidden = !bodyOn;
        render();
      });
      tools.push(node);
    }
    const format = el("button", { type: "button", class: "nb-tid-btn nb-tid-format" }, "Format");
    format.addEventListener("click", () => {
      const area = bodySlot.querySelector<HTMLTextAreaElement>(".nb-tid-editor");
      if (!area) return;
      // Never rewrites a value: a number it would round stops it, and says so.
      try {
        area.value = JSON.stringify(parseExactJson(area.value), null, 2);
        area.dispatchEvent(new Event("input"));
      } catch (error) {
        if (error instanceof RangeError) bodyError.textContent = error.message;
        area.focus();
      }
    });
    if (plan.body.media.some((m) => m.kind === "json")) tools.push(format);
    drawBody();
    return card("Body", [bodySlot, bodyError], { badge: typeBadge, tools, grow: bodyOn });
  };

  const build = (): void => {
    form.replaceChildren();
    const parts = [authCard(), serverCard, ...LOCATIONS.map(([loc, label]) => locationSection(loc, label)).filter(Boolean), bodyCard()];
    const paramSections = parts.filter((p): p is HTMLElement => p !== null && p.classList.contains("nb-tid-section"));
    const others = parts.filter((p): p is HTMLElement => p !== null && !p.classList.contains("nb-tid-section"));
    // Parameters share one card, a group per location.
    const params = paramSections.length ? card("Parameters", paramSections, { badge: badge(String(plan.params.filter((p) => !p.ignored).length)) }) : null;
    const auth = plan.auth.length ? others.shift() : undefined;
    const [url, ...rest] = others;
    for (const part of [auth, url, params, ...rest]) if (part) form.append(part);
    drawServer();
    if (!plan.params.some((p) => !p.ignored) && !plan.body && !plan.auth.some((a) => a.schemes.length) && serverCard.hidden) {
      form.append(
        el(
          "div",
          { class: "nb-tid-empty" },
          el("p", {}, "Nothing to fill in"),
          safe ? el("p", { class: "nb-tid-hints" }, el("kbd", {}, isMac ? "⌘" : "Ctrl"), el("kbd", {}, "↵"), " to send") : null,
        ),
      );
    }
    const reset = el("button", { type: "button", class: "nb-tid-btn nb-tid-reset" }, "Reset the form");
    reset.addEventListener("click", () => {
      const before = serverOrigin();
      resetValues();
      store("tab")?.removeItem(VALUES_KEY);
      // The picker and the keys follow the server the reset went back to.
      placePicker();
      if (serverOrigin() !== before) {
        loadRemembered();
        rememberBox.checked = remember;
      }
      build();
      render();
      live.textContent = "The form is back to the documented example.";
    });
    form.append(el("div", { class: "nb-tid-formfoot" }, reset));
    render();
  };

  // ---- Response ---------------------------------------------------------------------------
  const showBody = (...nodes: Node[]) => respBody.replaceChildren(...nodes, pill);
  let tickFrame = 0;
  const startClock = () => {
    const t0 = performance.now();
    const tick = () => {
      elapsedEl.textContent = `${((performance.now() - t0) / 1000).toFixed(2)} s`;
      tickFrame = requestAnimationFrame(tick);
    };
    tick();
  };
  const stopClock = () => {
    cancelAnimationFrame(tickFrame);
    elapsedEl.textContent = "";
  };
  let settleId = 0;
  const settle = () => {
    const id = ++settleId;
    respBody.dataset.phase = "arrived";
    setTimeout(() => id === settleId && (respBody.dataset.phase = "pill-out"), 40);
    setTimeout(() => id === settleId && delete respBody.dataset.phase, 90);
  };
  const via = (mode: DeliveryMode) => (mode === "proxy" ? "via this site" : "direct");
  const notice = (...children: (Node | string)[]) => el("div", { class: "nb-tid-respnote" }, el("p", { class: "nb-tid-notice" }, ...children));
  const offerProxy = (): Node[] => {
    if (!meta.info.deliveryModes.includes("proxy")) return [];
    const b = el("button", { type: "button", class: "nb-tid-secondary" }, "Send via this site");
    b.addEventListener("click", () => {
      // Changes the choice and goes back to Send; it never sends by itself.
      delivery = "proxy";
      build();
      render();
      (small.matches ? sendBottom : sendTop).focus();
    });
    return [b, el("p", { class: "nb-tid-help" }, "The first request may already have reached the API.")];
  };

  // One download link at a time: the one it replaces is released.
  let downloadUrl = "";
  const freeDownload = () => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = "";
  };
  const bodyView = (bytes: Uint8Array, headers: [string, string][], textBody: string | undefined, truncated: boolean): Node[] => {
    freeDownload();
    const type = headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ?? "";
    if (bytes.byteLength === 0) return [notice("The response has no body.")];
    const binary = textBody === undefined || bytes.subarray(0, 1024).includes(0);
    const out: Node[] = [];
    if (binary) {
      const box = el("div", { class: "nb-cr-body nb-tid-respcode" });
      paint(box, hexPreview(bytes), "text", "First 1 KB as hex");
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
      downloadUrl = URL.createObjectURL(blob);
      const link = el("a", { class: "nb-tid-secondary", download: "response.bin", href: downloadUrl }, "Download");
      out.push(el("p", { class: "nb-tid-help" }, `${size(bytes.byteLength)} of ${type || "binary data"}. The first 1 KB as hex:`), box, link);
    } else {
      const shown = /json/i.test(type) || /^\s*[[{]/.test(textBody!) ? pretty(textBody!) : { code: textBody!, json: false };
      const box = el("div", { class: "nb-cr-body nb-tid-respcode" });
      paint(box, shown.code, shown.json ? "json" : "text", "Response body");
      out.push(box);
    }
    if (truncated) out.push(el("p", { class: "nb-tid-help" }, `Cut at ${size(plan.send.responseBytes)}, this site's limit.`));
    return out;
  };

  const paintResponse = (outcome: SendOutcome): void => {
    barStatus.hidden = false;
    barStatus.className = `nb-tid-barstatus ${outcome.ok && !outcome.redirect ? tone(outcome.status) : outcome.ok ? "nb-tid-info" : "nb-tid-err"}`;
    barCode.textContent = outcome.ok ? (outcome.redirect ? "Redirect" : String(outcome.status)) : outcome.failure === "stopped" ? "Stopped" : "Failed";
    paintBarAction();
    statusEl.className = "nb-tid-status";
    tabs.hidden = !outcome.ok;
    copyBody.hidden = !(outcome.ok && outcome.text);
    if (!outcome.ok) {
      const partial = outcome.partial;
      const seconds = partial ? `${(partial.durationMs / 1000).toFixed(1)} s` : "";
      statusEl.textContent = { stopped: "Stopped", timeout: "No answer", limited: "Busy", refused: "Not sent", upstream: "Didn't complete", network: "Didn't complete" }[outcome.failure];
      statusEl.classList.add("nb-tid-err");
      metaEl.textContent = [seconds, via(outcome.via)].filter(Boolean).join(" · ");
      const message =
        outcome.failure === "limited"
          ? `This site's proxy is busy; try again in ${outcome.retryAfterSeconds ?? 1} s.`
          : outcome.failure === "upstream" && !partial
            ? "This site couldn't reach the API: name resolution, TLS or the connection failed."
            : outcome.reason;
      const children: Node[] = [notice(message)];
      if (outcome.failure === "network" && outcome.via === "direct") children.push(...offerProxy());
      if (partial && partial.body.byteLength > 0) {
        const decoded = (() => {
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(partial.body);
          } catch {
            return undefined;
          }
        })();
        children.push(...bodyView(partial.body, partial.headers ?? [], decoded, false));
      }
      showBody(...children);
      return;
    }
    if (outcome.redirect) {
      statusEl.textContent = outcome.status ? `${outcome.status} ${REASONS[outcome.status] ?? ""}`.trim() : "Redirect";
      statusEl.classList.add("nb-tid-info");
      metaEl.textContent = `${outcome.durationMs} ms · ${via(outcome.via)}`;
      showBody(
        notice(
          outcome.redirect.location
            ? `The API redirected to ${outcome.redirect.location}. Try it doesn't follow redirects.`
            : outcome.status
              ? "The API answered with a redirect, but the response headers were cut, so where it points isn't shown."
              : "The API answered with a redirect. The browser doesn't show where; send through this site to see it.",
        ),
      );
      return;
    }
    statusEl.textContent = `${outcome.status} ${REASONS[outcome.status] ?? ""}`.trim();
    statusEl.classList.add(tone(outcome.status));
    metaEl.textContent = `${outcome.durationMs} ms · ${size(outcome.body.byteLength)} · ${via(outcome.via)}`;
    const notes: Node[] = [];
    const wait = retryAfter(outcome.headers);
    if (wait !== undefined && (outcome.status === 429 || outcome.status === 503 || outcome.status >= 300)) notes.push(notice(`The API asks you to wait ${wait} s.`));
    if ((outcome.status === 401 || outcome.status === 403) && plan.auth.some((a) => a.schemes.length)) {
      const go = el("button", { type: "button", class: "nb-tid-secondary" }, "Edit authorization");
      go.addEventListener("click", () => {
        const key = form.querySelector<HTMLElement>("[data-nb-tid-key]");
        key?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
        key?.focus({ preventScroll: true });
      });
      notes.push(el("div", { class: "nb-tid-authnote" }, el("p", { class: "nb-tid-notice" }, outcome.status === 401 ? "Authorization failed. Check your key." : "This key isn't allowed to do this."), go));
    }
    if (tab === "headers") {
      showBody(
        el("dl", { class: "nb-tid-headers" }, ...outcome.headers.flatMap(([n, v]) => [el("dt", {}, n), el("dd", {}, v)])),
        ...(outcome.headersTruncated ? [notice("Some headers were left out: they're over the 4 KiB this site passes on.")] : []),
        ...(outcome.via === "direct" ? [el("p", { class: "nb-tid-help" }, "The browser shows only the headers the API exposes to it.")] : []),
      );
    } else {
      showBody(...notes, ...bodyView(outcome.body, outcome.headers, outcome.text, outcome.truncated));
    }
  };
  tabs.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab as "body" | "headers";
    tabs.querySelectorAll<HTMLButtonElement>("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.tab === tab)));
    if (last) paintResponse(last.outcome);
  });

  // ---- Send ---------------------------------------------------------------------------------
  const stop = () => controller?.abort();
  const firstInvalid = (): HTMLElement | null => {
    // A credential the chosen method needs comes first: it sits at the top of the form.
    const missing = schemes().find((s) => {
      const value = credentials.get(credKey(s.scheme));
      // Basic needs a username or a password (`:token` is valid).
      return value === undefined || value === "" || (typeof value === "object" && !value.username && !value.password);
    });
    if (missing && !plan.auth[alternative]?.unsupported) {
      const field = [...authRows.querySelectorAll<HTMLInputElement>("input[data-nb-tid-key]")].find((i) => i.value === "") ?? authRows.querySelector<HTMLInputElement>("input[data-nb-tid-key]");
      live.textContent = missing.type === "basic" ? "Enter a username or password." : "Enter your key.";
      if (field) {
        field.setAttribute("aria-invalid", "true");
        field.addEventListener("input", () => field.removeAttribute("aria-invalid"), { once: true });
        field.scrollIntoView({ block: "center", behavior: scrollBehavior() });
        field.focus({ preventScroll: true });
      }
      return field ?? form;
    }
    const issues = validateValues(plan, requestValues(false)).filter((i) => i.blocking);
    const emptyPath = plan.params.find((p) => p.in === "path" && values.params[paramKey(p)] === "");
    const [unparsed] = badJson.keys();
    const first = emptyPath
      ? { key: paramKey(emptyPath), message: "A path parameter can't be empty." }
      : unparsed
        ? { key: unparsed, message: badJson.get(unparsed)!.trim() === "" ? "Fill in this value." : jsonProblem(badJson.get(unparsed)!) ?? "Not valid JSON." }
        : issues[0];
    if (!first) return null;
    touched.add(first.key);
    const name = first.key === "body" ? "Body" : first.key.split(":").slice(1).join(":");
    live.textContent = `${name}: ${first.message}`;
    const target = controls.get(first.key);
    if (!target || !target.isConnected) return form;
    target.dispatchEvent(new Event("focusout"));
    target.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    (target.matches("input, select, textarea") ? target : target.querySelector<HTMLElement>("input, select, textarea") ?? target).focus({ preventScroll: true });
    return target;
  };
  const send = async (): Promise<void> => {
    if (controller) return stop();
    // A field that commits on change (the origin) commits now: Ctrl/Cmd+Enter sends what's typed.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && dialog.contains(active)) active.dispatchEvent(new Event("change"));
    if (!safe && meta.confirmWrites && !confirming) {
      confirming = true;
      sendState({ confirm: true });
      live.textContent = `Activate Send again to send ${plan.method} to ${sendLabel().long.split(" to ")[1] ?? host}.`;
      return;
    }
    confirming = false;
    if (firstInvalid()) {
      sendState({});
      return;
    }
    const request = current(false);
    if ("refused" in request) {
      paintResponse({ ok: false, via: delivery, failure: "refused", reason: request.refused });
      live.textContent = request.refused;
      return;
    }
    const id = ++sendId;
    controller = new AbortController();
    sendState({ stop: true });
    barStatus.hidden = false;
    barStatus.className = "nb-tid-barstatus";
    barCode.textContent = "Sending…";
    response.dataset.has = "1";
    response.dataset.state = "sending";
    settleId++;
    staleEl.hidden = true;
    respBody.dataset.phase = "sending";
    startClock();
    // Streamed bodies show as they arrive, coalesced to one paint per frame.
    let streamText = "";
    let frame = 0;
    const streamBox = el("div", { class: "nb-cr-body nb-tid-respcode" });
    const onChunk = (_bytes: Uint8Array, decoded?: string) => {
      if (decoded === undefined) return;
      streamText = decoded;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (id !== sendId) return;
        if (!streamBox.isConnected) showBody(streamBox);
        paint(streamBox, streamText.length > 200_000 ? streamText.slice(-200_000) : streamText, "text", "Response body, arriving");
      });
    };
    const outcome = await sendRequest(plan, requestValues(false), {
      delivery,
      signal: controller.signal,
      onChunk,
      ...(meta.proxy ? { proxyUrl: meta.proxy } : {}),
      origin: location.origin,
    });
    cancelAnimationFrame(frame);
    if (id !== sendId) return;
    controller = null;
    delete response.dataset.state;
    stopClock();
    sendState({});
    last = { outcome, fingerprint: fingerprint(request) };
    paintResponse(outcome);
    settle();
    live.textContent = outcome.ok
      ? `Response ${outcome.status || "redirect"} ${REASONS[outcome.status] ?? ""}, ${outcome.durationMs} milliseconds, ${via(outcome.via)}`
      : `Request didn't complete: ${outcome.ok === false && outcome.failure === "stopped" ? "stopped" : outcome.reason}`;
    render();
    if (small.matches) response.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  };

  // ---- Wiring ---------------------------------------------------------------------------------
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("keydown", (e) => {
    // Enter never sends from a field.
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
  });
  const onKey = (e: KeyboardEvent) => {
    // ⌘↵ / Ctrl+↵ sends only reads; a write is sent by its button alone.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && safe) {
      e.preventDefault();
      void send();
    }
  };
  dialog.addEventListener("keydown", onKey);
  for (const b of sendButtons) b.addEventListener("click", () => void send());
  // Leaving a pending confirmation cancels it.
  dialog.addEventListener("focusout", (e) => {
    if (confirming && !sendButtons.includes(e.relatedTarget as HTMLButtonElement)) {
      confirming = false;
      sendState({});
    }
  });
  let responseInView = false;
  function paintBarAction() {
    barAction.textContent = responseInView ? "Edit request" : "View response";
    barStatus.dataset.dir = responseInView ? "up" : "down";
    barStatus.setAttribute("aria-label", `${barCode.textContent}. ${barAction.textContent}`);
  }
  const observer = new IntersectionObserver((entries) => {
    responseInView = entries.some((e) => e.isIntersecting);
    paintBarAction();
  }, { threshold: 0.25 });
  observer.observe(response);
  barStatus.addEventListener("click", () => {
    if (responseInView) {
      inputs.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      const title = dialog.querySelector<HTMLElement>(".nb-tid-title");
      if (title) {
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
      }
      return;
    }
    response.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    statusEl.tabIndex = -1;
    statusEl.focus({ preventScroll: true });
  });
  codeToggle.addEventListener("click", () => {
    const open = railCard.toggleAttribute("data-code-open");
    codeToggle.setAttribute("aria-expanded", String(open));
  });
  const envBase = el("span", { class: "nb-tid-envtext" });
  const placePicker = () => {
    if (plan.servers.length < 2) {
      envRow.hidden = !small.matches;
      envBase.textContent = readable(serverOrigin());
      if (small.matches) envRow.replaceChildren(el("span", { class: "nb-tid-envlabel" }, "Server"), envBase);
      urlEl.replaceChildren(...(small.matches ? [urlRest] : [urlBase, urlRest]));
      return;
    }
    basePicker.value = String(values.server?.index ?? 0);
    if (small.matches) {
      envRow.hidden = false;
      envRow.replaceChildren(el("span", { class: "nb-tid-envlabel" }, "Server"), basePicker);
      urlEl.replaceChildren(urlRest);
    } else {
      envRow.hidden = true;
      urlEl.replaceChildren(basePicker, urlRest);
    }
  };
  const onSmall = () => {
    placePicker();
    render();
  };
  small.addEventListener("change", onSmall);
  close.addEventListener("click", () => dialog.close());
  langSelect.addEventListener("change", () => {
    lang = langSelect.value as Lang;
    store("tab")?.setItem(LANG_KEY, lang);
    render();
  });
  const flash = (b: HTMLButtonElement) => {
    b.dataset.done = "1";
    setTimeout(() => delete b.dataset.done, 1400);
  };
  const copy = (b: HTMLButtonElement, value: string) => void navigator.clipboard.writeText(value).then(() => flash(b), () => {});
  copyUrl.addEventListener("click", () => {
    const r = current(true);
    if (!("refused" in r)) copy(copyUrl, maskText(r.url, r.secrets));
  });
  copySample.addEventListener("click", () => {
    const r = current(true);
    if (!("refused" in r)) copy(copySample, renderSample(r, lang, { mask: true }));
  });
  copyBody.addEventListener("click", () => {
    if (last?.outcome.ok && last.outcome.text !== undefined) copy(copyBody, last.outcome.text);
  });
  // Close on a backdrop click only when the press started there too.
  let pressedOn: EventTarget | null = null;
  dialog.addEventListener("pointerdown", (e) => (pressedOn = e.target));
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && pressedOn === dialog) dialog.close();
    pressedOn = null;
  });
  // Closing stops waiting: a late answer never lands in a closed dialog.
  const onClose = () => {
    unlockScroll();
    if (controller) stop();
    button.focus({ preventScroll: true });
  };
  dialog.addEventListener("close", onClose);

  // On phones the keyboard shrinks the visual viewport: size the dialog to what's visible.
  const vv = window.visualViewport;
  const syncViewport = () => {
    if (!vv) return;
    document.documentElement.style.setProperty("--nb-tid-vh", `${vv.height}px`);
    document.documentElement.style.setProperty("--nb-tid-vtop", `${vv.offsetTop}px`);
  };
  const onViewport = () => {
    syncViewport();
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialog.contains(active)) requestAnimationFrame(() => active.scrollIntoView({ block: "nearest" }));
  };
  vv?.addEventListener("resize", onViewport);
  vv?.addEventListener("scroll", syncViewport);

  if (ghost) paint(ghost, ghostText, /^\s*[[{]/.test(ghostText) ? "json" : "text", "");
  build();

  return {
    open() {
      if (dialog.open) return;
      syncViewport();
      placePicker();
      render();
      dialog.showModal();
      lockScroll();
      const firstEmpty = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea")].find(
        (i) => !i.disabled && i.value === "" && i.offsetParent !== null,
      );
      if (small.matches) close.focus({ preventScroll: true });
      else (firstEmpty ?? sendTop).focus({ preventScroll: true });
    },
    destroy() {
      // A send still in flight never paints (or makes a download link) after this.
      sendId++;
      stopClock();
      controller?.abort();
      freeDownload();
      observer.disconnect();
      small.removeEventListener("change", onSmall);
      vv?.removeEventListener("resize", onViewport);
      vv?.removeEventListener("scroll", syncViewport);
      if (dialog.open) {
        dialog.close();
      }
      dialog.remove();
    },
  };
}
