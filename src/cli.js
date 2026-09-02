#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalTarget, ensureStateDir, SERVER_PROTOCOL, serverPath, statePath, targetKey } from "./paths.js";
import { installSkills, shellQuote } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const HELP = `human-review ${pkg.version}

  human-review <file-or-localhost-url> Open a file or localhost page for review
  human-review poll <target>          Block until the user hits Send, then print the batch as JSON
      --ack                        Acknowledge the last batch, then wait for the next
      --timeout <secs>             Give up with {"status":"timeout"} after this long (default: wait for Send)
  human-review status <target>        Report whether feedback is waiting, without blocking
  human-review setup                  Teach Claude Code / Codex how to use human-review
  human-review setup --global         ...for every project, not just this one

Everything runs locally. No account, no cloud, no database.
`;

// --------------------------------------------------------------- server glue

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

function request(server, options, body) {
  const port = typeof server === "number" ? server : server.port;
  const token = typeof server === "number" ? "" : server.token || "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        ...options,
        headers: { ...(token ? { "x-human-review-token": token } : {}), ...(options.headers || {}) },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (options.timeout) req.setTimeout(options.timeout, () => req.destroy(new Error("timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function alive(port) {
  try {
    const res = await request(port, { method: "GET", path: "/health", timeout: 1200 });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureServer() {
  ensureStateDir();
  const saved = readServerRecord();
  if (saved?.protocol === SERVER_PROTOCOL && saved.port && (await alive(saved.port))) return saved;

  const child = spawn(process.execPath, [path.join(here, "server-entry.js")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const record = readServerRecord();
    // Same protocol gate as above: a still-running server from an older
    // version answers /health too, and must not be adopted here.
    if (record?.protocol === SERVER_PROTOCOL && record.port && (await alive(record.port))) return record;
  }
  throw new Error("Could not start the local human-review server.");
}

function openBrowser(url) {
  const command =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  // A missing opener (headless Linux without xdg-open) surfaces as an async
  // 'error' event, not a throw. Printing the URL below is the fallback.
  child.on("error", () => {});
  child.unref();
}

// ------------------------------------------------------------------ commands

async function openCommand(input) {
  const target = canonicalTarget(input);
  if (target.kind === "file" && !fs.existsSync(target.value)) {
    console.error(`File not found: ${target.value}`);
    process.exit(1);
  }
  const server = await ensureServer();
  const res = await request(server, { method: "POST", path: "/api/session", headers: { "content-type": "application/json" } }, { target: target.value });
  const body = JSON.parse(res.raw);
  if (res.status !== 200) {
    console.error(body.error || "Could not open that file.");
    process.exit(1);
  }
  const url = `http://127.0.0.1:${server.port}${body.path}`;
  openBrowser(url);
  console.log(`Reviewing ${target.kind === "url" ? target.value : path.basename(target.value)}`);
  console.log(url);
  console.log(`\nWaiting for feedback? Run this in the background; it exits when the user hits Send:\n  human-review poll ${shellQuote(target.value)}`);
}

/**
 * One long-poll attempt. Resolves { kind: "data", raw } when the server
 * answers, or { kind: "timeout" } when the caller's deadline passes first.
 */
function pollOnce(server, target, ack, timeoutMs) {
  const query = `target=${encodeURIComponent(target)}${ack ? "&ack=1" : ""}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: `/api/poll?${query}`,
        headers: { "x-human-review-token": server.token || "" },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => settle(resolve, { kind: "data", raw: raw.trim() }));
        res.on("error", (err) => settle(reject, err));
        // The server went away mid-wait: the socket closes without an 'end'.
        // Left unhandled, the promise never settles and Node exits the
        // process as soon as the loop drains — with the agent still asleep.
        res.on("close", () => settle(reject, new Error("server connection closed")));
      }
    );
    const timer = timeoutMs
      ? setTimeout(() => {
          settle(resolve, { kind: "timeout" });
          req.destroy();
        }, timeoutMs)
      : null;
    req.on("error", (err) => settle(reject, err));
    req.end();
  });
}

/**
 * The consumer is an agent reading a pipe. process.exit() does not wait for
 * pending stdout writes, so a large payload could arrive truncated — always
 * wait for the write to hand off before returning.
 */
function writeStdout(text) {
  return new Promise((resolve) => process.stdout.write(text, resolve));
}

/** An open-ended wait still ends eventually: a forgotten tab must not pin a process for days. */
const MAX_OPEN_WAIT_MS = 12 * 60 * 60 * 1000;

function printTimeout(waitedSecs, { capped = false } = {}) {
  const payload = {
    status: "timeout",
    waited_seconds: waitedSecs,
    next_step: capped
      ? "Nothing arrived in 12 hours. Run `human-review status <target>`: if the review is still open, start the same background poll again; otherwise stop."
      : "No feedback yet. Run the same poll command again to keep waiting, or `human-review status <target>` to check without blocking.",
  };
  return writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Without --timeout this is an open-ended wait: the agent parks this process
 * in the background and is woken only when it exits, which should happen
 * when the user hits Send or closes the review — never because the detached
 * server went away underneath it (a newer CLI replaced it, or the machine
 * slept). So a lost connection reconnects, restarting the server if needed,
 * instead of giving up. A poll with a deadline keeps the old bounded retries.
 */
async function pollCommand(input, { ack = false, timeoutSecs = 0 } = {}) {
  const target = canonicalTarget(input).value;
  let server = await ensureServer();

  const label = /^https?:\/\//i.test(target) ? target : path.basename(target);
  process.stderr.write(`Waiting for feedback on ${label} — comment in the browser, then hit Send.\n`);

  const bounded = timeoutSecs > 0;
  const started = Date.now();
  const deadline = bounded ? started + timeoutSecs * 1000 : started + MAX_OPEN_WAIT_MS;
  const timedOut = () => printTimeout(bounded ? timeoutSecs : Math.round((Date.now() - started) / 1000), { capped: !bounded });
  // The ack rides on the first request that actually reaches the server.
  let ackPending = ack;
  let failures = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return timedOut();
    let result;
    try {
      result = await pollOnce(server, target, ackPending, remaining);
    } catch (err) {
      failures += 1;
      if (bounded && failures >= 3) break;
      process.stderr.write(`Lost the connection (${err.message}); reconnecting.\n`);
      await sleep(Math.min(2000 * failures, 10000));
      server = await ensureServer();
      continue;
    }
    ackPending = false;
    if (result.kind === "timeout") return timedOut();
    if (result.raw) {
      try {
        const batch = JSON.parse(result.raw);
        await writeStdout(`${JSON.stringify(batch, null, 2)}\n`);
        return;
      } catch {
        process.stderr.write("Unexpected response from the human-review server; retrying.\n");
      }
    }
    // An empty or garbled answer means the server closed the request without
    // a batch; wait a beat so a misbehaving server cannot spin this loop.
    failures += 1;
    if (bounded && failures >= 3) break;
    await sleep(500);
  }
  process.stderr.write("Gave up waiting for feedback.\n");
  process.exit(1);
}

/**
 * Instant answer, no blocking. Asks the running server when there is one;
 * otherwise reads the persisted state directly, so a dead server still
 * reports feedback that is waiting for a fresh poll.
 */
async function statusCommand(input) {
  const target = canonicalTarget(input).value;
  const saved = readServerRecord();
  if (saved?.protocol === SERVER_PROTOCOL && saved.port && (await alive(saved.port))) {
    const res = await request(saved, { method: "GET", path: `/api/status?target=${encodeURIComponent(target)}` });
    if (res.status === 200) {
      process.stdout.write(`${JSON.stringify(JSON.parse(res.raw), null, 2)}\n`);
      return;
    }
  }

  let data = { pages: {}, batches: {} };
  try {
    data = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    // No state yet: everything below reads as empty.
  }
  const key = targetKey(target);
  const pending = (data.batches || {})[key];
  const page = (data.pages || {})[key];
  const payload = {
    status: pending ? "feedback-waiting" : "idle",
    feedback_waiting: !!pending,
    agent_listening: false,
    server_running: false,
    unsent: {
      comments: page ? page.comments.length : 0,
      edits: page ? page.edits.length : 0,
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------- main

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  console.log(HELP);
  process.exit(0);
}

if (argv[0] === "--version" || argv[0] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

process.on("SIGINT", () => {
  process.stderr.write("\nStopped waiting. Your feedback is safe — run the same command again to pick it up.\n");
  process.exit(130);
});

function parsePollArgs(rest) {
  const parsed = { file: "", ack: false, timeoutSecs: 0 };
  let sawTimeout = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--ack") parsed.ack = true;
    else if (arg === "--timeout") {
      sawTimeout = true;
      parsed.timeoutSecs = Number(rest[(i += 1)]);
    } else if (arg.startsWith("--timeout=")) {
      sawTimeout = true;
      parsed.timeoutSecs = Number(arg.slice("--timeout=".length));
    } else if (!arg.startsWith("-") && !parsed.file) parsed.file = arg;
  }
  // A malformed value must fail loudly — NaN or 0 silently waiting forever is
  // the exact hang the flag exists to prevent.
  if (sawTimeout && (!Number.isFinite(parsed.timeoutSecs) || parsed.timeoutSecs <= 0)) {
    throw new Error("--timeout wants a number of seconds, e.g. --timeout 300");
  }
  return parsed;
}

try {
  if (argv[0] === "poll") {
    const { file, ack, timeoutSecs } = parsePollArgs(argv.slice(1));
    if (!file) throw new Error("Usage: human-review poll <file-or-localhost-url> [--ack] [--timeout <secs>]");
    await pollCommand(file, { ack, timeoutSecs });
  } else if (argv[0] === "status") {
    const file = argv.find((a, i) => i > 0 && !a.startsWith("-"));
    if (!file) throw new Error("Usage: human-review status <file-or-localhost-url>");
    await statusCommand(file);
  } else if (argv[0] === "setup") {
    const isGlobal = argv.includes("--global") || argv.includes("-g");
    installSkills(process.cwd(), { global: isGlobal }).forEach((line) => console.log(line));
  } else {
    await openCommand(argv[0]);
  }
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}

// A finished command must never linger on stray handles (keep-alive sockets
// from health checks, for one) — on Windows that hangs the calling shell.
process.exit(0);
