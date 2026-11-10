#!/usr/bin/env node
/**
 * Reports what a test run is stuck on, then stops it.
 *
 *   node scripts/report-stuck-tests.mjs <runner-pid> <seconds>
 *
 * node's test runner waits for every test file's process to exit and for its
 * output pipes to close. --test-timeout can't end that wait: a file that
 * never exits after its last test, or a process it started that keeps its
 * stdout or stderr open, holds the run until the job times out, and the log
 * names neither.
 *
 * If the runner outlives <seconds>, this prints the process tree, every
 * process holding one of the runner's pipes, and for each test file still
 * running a node report summary (JavaScript stack and the handles keeping it
 * alive). Then it stops the runner so the step fails with the report. It
 * exits on its own once the runner ends. Linux only (reads /proc).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

const runner = Number(process.argv[2]);
const deadline = Date.now() + Number(process.argv[3]) * 1000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
};

const fds = (pid) => {
  try {
    return readdirSync(`/proc/${pid}/fd`).map((fd) => [Number(fd), readlinkSync(`/proc/${pid}/fd/${fd}`)]);
  } catch {
    return [];
  }
};

const pids = () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function report() {
  const minutes = Math.round(Number(process.argv[3]) / 60);
  console.log(`::group::Tests still running after ${minutes} minutes: process tree`);
  console.log(execFileSync("ps", ["-eo", "pid,ppid,stat,etimes,args", "--forest"], { encoding: "utf8" }));
  console.log("::endgroup::");

  // A test file's output reaches the runner over socketpairs (libuv's stdio
  // pipes). Any process whose stdio is the far end of one keeps that file
  // "running". `ss -x` pairs each socket with its peer.
  const peer = new Map();
  for (const line of execFileSync("ss", ["-xn"], { encoding: "utf8" }).split("\n")) {
    const match = /^u_str\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)/.exec(line);
    if (match) peer.set(`socket:[${match[1]}]`, `socket:[${match[2]}]`);
  }
  const runnerEnds = new Set(
    fds(runner).flatMap(([, target]) => (target.startsWith("pipe:") ? [target] : peer.has(target) ? [peer.get(target)] : [])),
  );
  const files = [];
  console.log("Processes holding the runner's pipes:");
  for (const pid of pids()) {
    if (pid === runner || pid === process.pid) continue;
    const held = fds(pid).filter(([fd, target]) => fd <= 2 && runnerEnds.has(target));
    if (held.length === 0) continue;
    const args = cmdline(pid);
    const file = args.find((arg) => arg.endsWith(".test.ts"));
    if (file) files.push({ pid, file });
    console.log(`  ${pid} (fd ${held.map(([fd]) => fd).join(", ")}): ${file ? `test file ${file}` : args.join(" ").slice(0, 300)}`);
  }

  for (const { pid, file } of files) {
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
      process.kill(pid, "SIGUSR2"); // the runner starts each file with --report-signal=SIGUSR2
    } catch {
      continue;
    }
    summarise(pid, file, cwd);
  }
}

function summarise(pid, file, cwd) {
  // Written synchronously by the signal handler; give the file a moment.
  const until = Date.now() + 5000;
  let path;
  while (!path && Date.now() < until) {
    path = readdirSync(cwd).find((name) => name.startsWith("report.") && name.includes(`.${pid}.`));
    if (!path) execFileSync("sleep", ["0.2"]);
  }
  console.log(`::group::${file} (pid ${pid}): node report`);
  if (!path) {
    console.log("No report: the process didn't answer SIGUSR2, so its main thread is blocked.");
  } else {
    const full = join(cwd, path);
    // Only the parts that say what it waits on; the report also holds environment variables.
    const data = JSON.parse(readFileSync(full, "utf8"));
    rmSync(full, { force: true });
    console.log("JavaScript stack:", data.javascriptStack.message || "(empty: idle in the event loop)");
    for (const frame of data.javascriptStack.stack ?? []) console.log(`  ${frame}`);
    console.log("Handles keeping it alive:");
    for (const handle of data.libuv.filter((h) => h.is_active && h.is_referenced)) {
      const { address, is_active, is_referenced, ...rest } = handle;
      console.log(`  ${JSON.stringify(rest)}`);
    }
    console.log(`Worker threads: ${data.workers.length}`);
  }
  console.log("::endgroup::");
}

while (alive(runner)) {
  if (Date.now() > deadline) {
    if (existsSync("/proc")) report();
    console.log(`::error::Tests still running after ${Math.round(Number(process.argv[3]) / 60)} minutes; stopping them. The report above names what they wait on.`);
    process.kill(runner, "SIGTERM");
    break;
  }
  await sleep(5000);
}
