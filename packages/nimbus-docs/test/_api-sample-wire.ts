import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const sampleClientUnavailable = {
  curl: spawnSync("curl", ["--version"]).status !== 0 ? "curl is unavailable" : false,
  typescript: false,
  python: spawnSync("python3", ["-c", "import requests"]).status !== 0 ? "python3 with requests is unavailable" : false,
};

export interface CapturedSampleRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export async function startSampleCapture() {
  const requests: CapturedSampleRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async run(sample: { lang: string; source: string }): Promise<CapturedSampleRequest> {
      const before = requests.length;
      const command = sample.lang === "curl"
        ? ["bash", ["-c", sample.source]] as const
        : sample.lang === "python"
          ? ["python3", ["-c", sample.source]] as const
          : [process.execPath, ["--input-type=module", "--eval", sample.source]] as const;
      await exec(command[0], [...command[1]], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      assert.equal(requests.length, before + 1, `exactly one HTTP request from ${sample.lang}`);
      const request = requests[before]!;
      assert.equal(request.method, "POST");
      return request;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
