import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

// Every variable the agent detector reads, so a "shell" run inside an agent
// session (this suite's own, say) isn't detected as one.
const NO_AGENT = Object.fromEntries(
  ["AI_AGENT", "CLAUDECODE", "CLAUDE_CODE", "CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID", "CURSOR_AGENT", "GEMINI_CLI", "OPENCODE", "OPENCODE_CLIENT", "REPL_ID"].map((name) => [name, ""]),
);

test("adapter install commands preserve the supported range without claiming an exact pin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  fs.writeFileSync(path.join(dir, "astro.config.ts"), 'export default {\n // nimbus:adapter\n output: "static"\n};');
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0", dependencies: { astro: "7.3.1" } }));
  try {
    const result = spawnSync(process.execPath, ["--import", TSX, CLI, "add", "adapter-cloudflare"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, ...NO_AGENT, NO_COLOR: "1", CI: "1", npm_config_offline: "true" },
    });
    const output = result.stdout + result.stderr;
    assert.match(output, /pnpm add .*@astrojs\/cloudflare@~14\.3\.0/);
    assert.doesNotMatch(output, /--save-exact/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter no-op reports a wrangler write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import cloudflare from "@astrojs/cloudflare";
export default {
  // nimbus:adapter
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
};
`,
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      dependencies: {
        astro: "7.0.9",
        "@astrojs/cloudflare": "14.3.3",
      },
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...NO_AGENT, NO_COLOR: "1" } },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.ok(fs.existsSync(path.join(dir, "wrangler.jsonc")));
    assert.match(output, /Wrote wrangler\.jsonc \(server\)/);
    assert.match(output, /hand request-rendering configuration to your coding agent/);
    assert.match(output, /adapter-cloudflare --print \| claude/);
    assert.doesNotMatch(output, /Nothing to do/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter names the rendering policy it inserts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const configPath = path.join(dir, "astro.config.ts");
  fs.writeFileSync(
    configPath,
    `import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  title: "Docs",
});

export default defineConfig({
  // nimbus:adapter
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  integrations: [nimbus(nimbusConfig)],
});
`,
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      dependencies: { astro: "7.0.9", "@astrojs/cloudflare": "14.3.3" },
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...NO_AGENT, NO_COLOR: "1" } },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(fs.readFileSync(configPath, "utf8"), /rendering: \{ default: "request" \}/);
    assert.match(
      output,
      /Set rendering: \{ default: "request" \} in the Nimbus config: every collection renders on request\./,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter --print emits the request-rendering agent recipe without editing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const config = `export default { output: "static" };\n`;
  fs.writeFileSync(path.join(dir, "astro.config.ts"), config);

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare", "--print"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...NO_AGENT, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Finish Nimbus Cloudflare request rendering/m);
    assert.match(result.stdout, /Find the default Nimbus integration/);
    assert.match(result.stdout, /run the project's build command/);
    assert.equal(fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8"), config);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const AGENT = { ...NO_AGENT, AI_AGENT: "test-agent" };
const RECIPE = /^# Finish Nimbus Cloudflare request rendering/m;
const INSTALLED = JSON.stringify({
  dependencies: { astro: "7.0.9", "@astrojs/cloudflare": "14.3.3", wrangler: "4.40.0" },
});

function runAdapter(files: Record<string, string>, env: Record<string, string>, adapter = "adapter-cloudflare") {
  // A fixed folder name, so names derived from it (the Worker name) match across runs.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const dir = path.join(parent, "site");
  fs.mkdirSync(dir);
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
  try {
    const result = spawnSync(process.execPath, ["--import", TSX, CLI, "add", adapter], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, NO_COLOR: "1", npm_config_offline: "true" },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      output: `${result.stdout}\n${result.stderr}`,
      config: fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8"),
      wrangler: fs.existsSync(path.join(dir, "wrangler.jsonc")),
      // Every file the run left, with its contents, for whole-project comparisons.
      // Not `node_modules`: a failed install can leave links to missing packages.
      files: Object.fromEntries(
        (fs.readdirSync(dir, { recursive: true }) as string[])
          .filter((file) => file.split(path.sep)[0] !== "node_modules")
          .filter((file) => fs.statSync(path.join(dir, file)).isFile())
          .sort()
          .map((file) => [file, fs.readFileSync(path.join(dir, file), "utf8")]),
      ),
    };
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

const MARKED = `import { defineConfig } from "astro/config";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  title: "Docs",
});

export default defineConfig({
  // nimbus:adapter
  output: "static",
  integrations: [nimbus(nimbusConfig)],
});
`;

test("adapter-cloudflare applies in a coding agent session, as from a shell", () => {
  const agent = runAdapter({ "astro.config.ts": MARKED, "package.json": INSTALLED }, AGENT);
  const shell = runAdapter({ "astro.config.ts": MARKED, "package.json": INSTALLED }, NO_AGENT);
  assert.equal(agent.status, 0, agent.output);
  assert.match(agent.config, /output: "server"/);
  assert.match(agent.config, /adapter: cloudflare\(/);
  assert.match(agent.config, /rendering: \{ default: "request" \}/);
  assert.ok(agent.wrangler);
  assert.doesNotMatch(agent.stdout, RECIPE);
  assert.doesNotMatch(agent.output, /\x1b\[\?25[lh]/, "no cursor escapes without a terminal");
  assert.equal(shell.status, 0, shell.output);
  assert.deepEqual(agent.files, shell.files);
});

test("in an agent session, a config the CLI can't edit gets the reason, then the recipe", () => {
  for (const [label, files] of [
    ["no output marker", { "astro.config.ts": `export default { output: "static" };\n`, "package.json": INSTALLED }],
    ["symlinked config", { "real.config.ts": MARKED, "package.json": INSTALLED }],
  ] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
    if (label === "symlinked config") fs.symlinkSync(path.join(dir, "real.config.ts"), path.join(dir, "astro.config.ts"));
    const before = fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8");
    try {
      const result = spawnSync(process.execPath, ["--import", TSX, CLI, "add", "adapter-cloudflare"], {
        cwd: dir, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...AGENT, NO_COLOR: "1" },
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stdout, RECIPE, label);
      assert.equal(fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8"), before, label);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("in an agent session, refusals the recipe can't fix stay errors, and other adapters never get it", () => {
  const foreign = runAdapter(
    {
      "astro.config.ts": `import netlify from "@astrojs/netlify";\nexport default {\n  // nimbus:adapter\n  output: "server",\n  adapter: netlify(),\n};\n`,
      "package.json": INSTALLED,
    },
    AGENT,
  );
  assert.equal(foreign.status, 1, foreign.output);
  assert.doesNotMatch(foreign.stdout, RECIPE);
  const node = runAdapter({ "astro.config.ts": `export default { output: "static" };\n`, "package.json": INSTALLED }, AGENT, "adapter-node");
  assert.equal(node.status, 1, node.output);
  assert.doesNotMatch(node.stdout, RECIPE);
  const shell = runAdapter({ "astro.config.ts": `export default { output: "static" };\n`, "package.json": INSTALLED }, NO_AGENT);
  assert.equal(shell.status, 1, shell.output);
  assert.doesNotMatch(shell.stdout, RECIPE);
});

test("in an agent session, a failed install stays an error and a failed write gets the recipe", () => {
  // Offline, with the adapter not installed: the install fails before the config is touched.
  const install = runAdapter(
    { "astro.config.ts": MARKED, "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0", dependencies: { astro: "7.0.9" } }) },
    AGENT,
  );
  assert.equal(install.status, 1, install.output);
  assert.doesNotMatch(install.stdout, RECIPE);
  assert.equal(install.config, MARKED);

  // A folder the CLI can't write into: the config can't be replaced.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  fs.writeFileSync(path.join(dir, "astro.config.ts"), MARKED);
  fs.writeFileSync(path.join(dir, "package.json"), INSTALLED);
  fs.chmodSync(dir, 0o555);
  try {
    const result = spawnSync(process.execPath, ["--import", TSX, CLI, "add", "adapter-cloudflare"], {
      cwd: dir, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...AGENT, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /couldn't write/);
    assert.match(result.stdout, RECIPE);
    assert.equal(fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8"), MARKED);
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in an agent session, an imported Nimbus config gets the adapter wired, then the recipe without pipe hints", () => {
  const result = runAdapter(
    {
      "astro.config.ts": `import nimbus from "@cloudflare/nimbus-docs";\nimport nimbusConfig from "./nimbus.config";\nexport default {\n  // nimbus:adapter\n  output: "static",\n  integrations: [nimbus(nimbusConfig)],\n};\n`,
      "nimbus.config.ts": `export default { site: "https://example.com", title: "Docs" };\n`,
      "package.json": INSTALLED,
    },
    AGENT,
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.config, /output: "server"/);
  assert.match(result.stdout, RECIPE);
  assert.doesNotMatch(result.output, /\| claude|\| codex/);
});

test("non-Cloudflare adapter --print fails without editing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const config = `export default { output: "static" };\n`;
  fs.writeFileSync(path.join(dir, "astro.config.ts"), config);

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-vercel", "--print"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...NO_AGENT, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /only available for the Cloudflare adapter/);
    assert.equal(fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8"), config);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("component --print fails before writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "dialog", "--print"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...NO_AGENT, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /only available for features and the Cloudflare adapter/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter install reports partial success when wrangler cannot be written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  fs.writeFileSync(
    path.join(dir, "astro.config.ts"),
    `import cloudflare from "@astrojs/cloudflare";
export default {
  // nimbus:adapter
  output: "server",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
};
`,
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      dependencies: {
        astro: "7.0.9",
        "@astrojs/cloudflare": "14.3.3",
      },
    }),
  );

  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'mkdir "wrangler.jsonc" && exec "$NODE_BIN" --import "$TSX_PATH" "$CLI_PATH" add adapter-cloudflare',
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          NODE_BIN: process.execPath,
          TSX_PATH: TSX,
          CLI_PATH: CLI,
        },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /! Cloudflare server deployment is only partially configured/);
    assert.doesNotMatch(output, /Wrote wrangler\.jsonc/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter-node on a site without rendering says Nimbus builds every route it manages", () => {
  const config = `import nimbus from "@cloudflare/nimbus-docs";
import node from "@astrojs/node";
export default {
  // nimbus:adapter
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [nimbus({ site: "https://docs.example.com", title: "X" })],
};
`;
  const result = runAdapter(
    { "astro.config.ts": config, "package.json": JSON.stringify({ dependencies: { astro: "7.0.9", "@astrojs/node": "11.1.3" } }) },
    NO_AGENT,
    "adapter-node",
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /With no `rendering` set, Nimbus builds every route it manages ahead of time/);
  assert.doesNotMatch(result.output, /follows the `rendering` policy/);
});
