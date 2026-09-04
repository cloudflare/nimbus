import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

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
        "@astrojs/cloudflare": "14.1.7",
      },
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
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

test("adapter --print emits the request-rendering agent recipe without editing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const config = `export default { output: "static" };\n`;
  fs.writeFileSync(path.join(dir, "astro.config.ts"), config);

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare", "--print"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
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

test("adapter emits the recipe by default inside a coding agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const config = `export default { output: "static" };\n`;
  fs.writeFileSync(path.join(dir, "astro.config.ts"), config);

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, AI_AGENT: "test-agent", NO_COLOR: "1" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Finish Nimbus Cloudflare request rendering/m);
    assert.equal(fs.readFileSync(path.join(dir, "astro.config.ts"), "utf8"), config);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-Cloudflare adapter --print fails without editing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));
  const config = `export default { output: "static" };\n`;
  fs.writeFileSync(path.join(dir, "astro.config.ts"), config);

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-vercel", "--print"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /only available for the Cloudflare adapter/);
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
      { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /only available for features and the Cloudflare adapter/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registry resolution failure with --print keeps stdout empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nimbus-adapter-cli-"));

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "not-bundled", "--print"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          NIMBUS_REGISTRY_URL: "http://127.0.0.1:1",
          NO_COLOR: "1",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Could not reach the registry/);
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
        "@astrojs/cloudflare": "14.1.7",
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

test("adapter install reports partial success for a retained foreign wrangler", () => {
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
      dependencies: { astro: "7.0.9", "@astrojs/cloudflare": "14.1.7" },
    }),
  );
  const wrangler = JSON.stringify({
    name: "docs",
    compatibility_date: "2025-01-01",
    assets: {
      directory: "./dist",
      not_found_handling: "404-page",
      binding: "ASSETS",
    },
  });
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), wrangler);

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", TSX, CLI, "add", "adapter-cloudflare"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.equal(fs.readFileSync(path.join(dir, "wrangler.jsonc"), "utf8"), wrangler);
    assert.match(output, /only partially configured/);
    assert.match(output, /static 404 before Astro/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
