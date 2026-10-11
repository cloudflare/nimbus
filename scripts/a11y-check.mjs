#!/usr/bin/env node
// Accessibility gate: builds the starter source (what templates and the
// registry ship), then runs axe on every page in light and dark, with
// disclosures and dialogs opened, plus a check of how tabs pair with panels.
// Serious and critical violations fail; the rest are printed.
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const starter = join(root, "packages/nimbus-starter-source");
const out = join(root, ".generated/a11y");
const dist = join(out, "dist");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const FAILING = new Set(["serious", "critical"]);

const allowlist = JSON.parse(await readFile(join(root, "scripts/a11y-allowlist.json"), "utf8"));
const unexplained = allowlist.filter((entry) => !entry.rule || !entry.reason?.trim());
if (unexplained.length > 0) {
  console.error(`a11y-allowlist.json: every entry needs a rule and a reason:\n${JSON.stringify(unexplained, null, 2)}`);
  process.exit(1);
}

const require = createRequire(join(starter, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("astro")));
const originalPath = process.env.PATH;
process.env.PATH = join(starter, "node_modules/.bin") + delimiter + originalPath;
process.chdir(starter);
try {
  await build({
    root: pathToFileURL(starter + sep),
    outDir: dist,
    cacheDir: join(out, "cache"),
    logLevel: "error",
  });
} finally {
  process.chdir(root);
  process.env.PATH = originalPath;
}

const SKIP = new Set(["_astro", "og", "pagefind"]);
async function pages(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) found.push(...(await pages(join(dir, entry.name))));
    } else if (entry.name === "index.html") {
      found.push(`/${relative(dist, dir).split(sep).join("/")}${dir === dist ? "" : "/"}`);
    } else if (entry.name === "404.html") {
      found.push(`/${relative(dist, join(dir, entry.name)).split(sep).join("/")}`);
    }
  }
  return found;
}
const routes = (await pages(dist)).sort();

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
  const filename = resolve(dist, `.${pathname}`);
  if (filename !== dist && !filename.startsWith(dist + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const file = (await stat(filename)).isDirectory() ? join(filename, "index.html") : filename;
    const type = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", json: "application/json" }[
      file.split(".").pop()
    ];
    response.writeHead(200, type ? { "content-type": type } : {}).end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const allowed = (rule, target) =>
  allowlist.some((entry) => entry.rule === rule && (!entry.selector || target.includes(entry.selector)));

const findings = [];
let allowedCount = 0;
const coverage = { opened: 0, dialogs: 0, tablists: 0 };
function record(route, theme, state, results) {
  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      const target = node.target.flat().join(" ");
      if (allowed(violation.id, target)) {
        allowedCount++;
        continue;
      }
      findings.push({
        route,
        theme,
        state,
        rule: violation.id,
        impact: violation.impact ?? "minor",
        help: violation.help,
        helpUrl: violation.helpUrl,
        target,
        summary: node.failureSummary?.split("\n").slice(0, 2).join(" ") ?? "",
      });
    }
  }
}

// Every tablist has tabs, each tab names a panel that names it back, and
// clicking a visible tab selects it and shows its panel.
async function checkTabs(page, route, theme) {
  const problems = await page.evaluate(async () => {
    const out = [];
    const lists = [...document.querySelectorAll("[role=tablist]")];
    for (const [i, list] of lists.entries()) {
      const tabs = [...list.querySelectorAll("[role=tab]")];
      const where = `tablist #${i + 1}${list.id ? ` (#${list.id})` : ""}`;
      if (tabs.length === 0) {
        out.push(`${where} has no tabs`);
        continue;
      }
      for (const tab of tabs) {
        const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
        const name = JSON.stringify(tab.textContent.trim());
        if (!panel || panel.getAttribute("role") !== "tabpanel") {
          out.push(`${where}: tab ${name} doesn't control a tabpanel`);
          continue;
        }
        if (!(panel.getAttribute("aria-labelledby") ?? "").split(/\s+/).includes(tab.id)) {
          out.push(`${where}: the panel for tab ${name} isn't labelled by it`);
        }
        if (!tab.checkVisibility()) continue;
        tab.click();
        await new Promise((done) => requestAnimationFrame(done));
        if (tab.getAttribute("aria-selected") !== "true" || panel.hidden) {
          out.push(`${where}: clicking tab ${name} doesn't select it and show its panel`);
        }
      }
      tabs.find((tab) => tab.checkVisibility())?.click();
    }
    return { out, lists: lists.length };
  });
  coverage.tablists += problems.lists;
  for (const problem of problems.out) {
    findings.push({ route, theme, state: "tabs", rule: "tabs-wiring", impact: "serious", help: problem, helpUrl: "", target: "", summary: "" });
  }
}

const scan = (page, include) => {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  return (include ? builder.include(include) : builder).analyze();
};

const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const route of routes) {
      await page.goto(origin + route, { waitUntil: "load" });
      record(route, theme, "page", await scan(page));
      await checkTabs(page, route, theme);

      // Each disclosure and popover in the content, opened one at a time:
      // a popover closes on the next click, so opening them all first would
      // scan most of them closed.
      const triggers = await page.$$("main [aria-expanded=false], main [aria-haspopup]:not([aria-haspopup=dialog])");
      for (const trigger of triggers.slice(0, 20)) {
        if (!(await trigger.isVisible())) continue;
        const clicked = await trigger.click({ timeout: 2000 }).then(() => true, () => false);
        if (!clicked) continue;
        const opened = await trigger.evaluate((el) => {
          if (el.getAttribute("aria-expanded") === "true") return true;
          const id = el.getAttribute("aria-controls") ?? el.getAttribute("popovertarget");
          const target = id ? document.getElementById(id) : el.parentElement?.querySelector("[popover]");
          return !!target?.matches(":popover-open");
        });
        if (!opened) continue;
        coverage.opened++;
        record(route, theme, "opened", await scan(page, "main"));
        await page.keyboard.press("Escape");
        if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click({ timeout: 2000 }).catch(() => {});
      }

      // Every dialog, opened one at a time.
      const dialogs = await page.locator("dialog:not([open])").count();
      for (let i = 0; i < dialogs; i++) {
        const opened = await page.evaluate((index) => {
          const dialog = document.querySelectorAll("dialog:not([open])")[index];
          if (!dialog) return false;
          dialog.setAttribute("data-a11y-open", "");
          dialog.showModal();
          return true;
        }, i);
        if (!opened) continue;
        record(route, theme, "dialog", await scan(page, "dialog[data-a11y-open]"));
        coverage.dialogs++;
        await page.evaluate(() => {
          const dialog = document.querySelector("dialog[data-a11y-open]");
          dialog?.close();
          dialog?.removeAttribute("data-a11y-open");
        });
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

// One line per distinct problem, listing the pages it appears on.
const groups = new Map();
for (const finding of findings) {
  const key = [finding.impact, finding.rule, finding.theme, finding.state, finding.target, finding.help].join("\u0000");
  const group = groups.get(key) ?? { ...finding, routes: [] };
  group.routes.push(finding.route);
  groups.set(key, group);
}
const sorted = [...groups.values()].sort((a, b) => Number(FAILING.has(b.impact)) - Number(FAILING.has(a.impact)));
for (const group of sorted) {
  const pagesText = group.routes.length > 3 ? `${group.routes.slice(0, 3).join(", ")} +${group.routes.length - 3} more` : group.routes.join(", ");
  console.log(`${FAILING.has(group.impact) ? "✖" : "•"} [${group.impact}] ${group.rule} (${group.theme}, ${group.state}) ${group.help}`);
  if (group.target) console.log(`    ${group.target}`);
  if (group.summary) console.log(`    ${group.summary}`);
  if (group.helpUrl) console.log(`    ${group.helpUrl}`);
  console.log(`    on ${pagesText}`);
}

const failing = findings.filter((finding) => FAILING.has(finding.impact));
console.log(
  `\n${routes.length} pages × 2 themes: ${failing.length} serious or critical, ` +
    `${findings.length - failing.length} moderate or minor, ${allowedCount} allowlisted. ` +
    `Covered ${coverage.opened} opened controls, ${coverage.dialogs} open dialogs, ${coverage.tablists} tablists.`,
);
if (failing.length > 0) {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(findings, null, 2)}\n`);
  console.error(`Full report: ${relative(root, join(out, "report.json"))}`);
  process.exit(1);
}
