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
import { readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

const runner = Number(process.argv[2]);
const seconds = Number(process.argv[3]);
const deadline = Date.now() + seconds * 1000;
const minutes = `${Math.round(seconds / 60)} minutes`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// One fd at a time: an fd closing mid-read drops only itself.
const fds = (pid) => {
  let names;
  try {
    names = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  return names.flatMap((fd) => {
    try {
      return [[Number(fd), readlinkSync(`/proc/${pid}/fd/${fd}`)]];
    } catch {
      return [];
    }
  });
};

const pids = () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);

const reportsIn = (dir, pid) => {
  try {
    // node names them report.<date>.<time>.<pid>.<thread>.<seq>.json
    return readdirSync(dir).filter((name) => Number(/^report\.\d{8}\.\d{6}\.(\d+)\.\d+\.\d+\.json$/.exec(name)?.[1]) === pid);
  } catch {
    return [];
  }
};

/** Test files still running, with the directory node writes their reports to. */
function holders() {
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
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    if (file && cwd) files.push({ pid, file, cwd });
    console.log(`  ${pid} (fd ${held.map(([fd]) => fd).join(", ")}): ${file ? `test file ${file}` : args.join(" ").slice(0, 300)}`);
  }
  return files;
}

/** Reads a SIGUSR2 report once it parses; null if none is complete in 5 s. */
async function readReport(pid, cwd) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [name] = reportsIn(cwd, pid);
    if (name) {
      try {
        return JSON.parse(readFileSync(join(cwd, name), "utf8"));
      } catch {
        // Still being written.
      }
    }
    await sleep(200);
  }
  return null;
}

async function summarise({ pid, file, cwd }) {
  try {
    process.kill(pid, "SIGUSR2"); // the runner starts each file with --report-signal=SIGUSR2
  } catch {
    return; // exited since
  }
  const data = await readReport(pid, cwd);
  console.log(`::group::${file} (pid ${pid}): node report`);
  if (!data) {
    console.log("No report: the process didn't answer SIGUSR2, so its main thread is blocked.");
  } else {
    // Only what it waits on; the report also holds environment variables.
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

while (alive(runner) && Date.now() <= deadline) await sleep(5000);

if (alive(runner)) {
  const signalled = [];
  try {
    console.log(`::group::Tests still running after ${minutes}: process tree`);
    console.log(execFileSync("ps", ["-eo", "pid,ppid,stat,etimes,args", "--forest"], { encoding: "utf8" }));
    console.log("::endgroup::");
    for (const holder of holders()) {
      signalled.push(holder);
      await summarise(holder);
    }
  } catch (error) {
    console.log(`The report failed: ${error.message}`);
  } finally {
    console.log(`::error::Tests still running after ${minutes}; stopping them. The report above names what they wait on.`);
    try {
      process.kill(runner, "SIGTERM");
    } catch {}
    // The runner stops its test files; then no report is still being written.
    const until = Date.now() + 10000;
    while (alive(runner) && Date.now() < until) await sleep(200);
    // Only the reports this asked for.
    for (const { pid, cwd } of signalled) for (const name of reportsIn(cwd, pid)) rmSync(join(cwd, name), { force: true });
  }
}
