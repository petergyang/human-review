import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-threads-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
process.env.HUMAN_REVIEW_THREAD_WATCH_MS = "50";

const { start } = await import("../src/server.js");
const threads = await import("../src/threads.js");
const { htmlToText } = await import("../src/page-text.js");

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: { "x-human-review-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw, json: () => JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const run = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", windowsHide: true });

function writeDoc(name = "plan.md") {
  const dir = fs.mkdtempSync(path.join(tmp, "doc-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, "# Plan\n\nSensors record **every** second. Cages are cleaned weekly. Cages are cleaned weekly.\n");
  return fs.realpathSync(file);
}

const anchor = (quote) => ({ prefix: "", quote, suffix: "" });
const agent = { name: "Claude Code", type: "agent", model: "claude-opus-5-5" };
// Every stored author carries a colour; one who never picked gets a stable one.
const signed = (a) => ({ ...a, color: threads.colorFor(a.name) });

test("threads live beside the file, one JSON file each, oldest first", () => {
  const file = writeDoc();
  const a = threads.createThread(file, { kind: "comment", anchor: anchor("every second"), body: "Which sensors?" });
  const b = threads.createThread(file, { kind: "suggestion", anchor: anchor("weekly"), replacement: "twice a week", author: agent });
  assert.deepEqual(fs.readdirSync(threads.threadDir(file)).sort(), [`${a.id}.json`, `${b.id}.json`].sort());
  assert.deepEqual(threads.listThreads(file).map((t) => t.id), [a.id, b.id].sort());
  assert.equal(a.author.type, "human");
  assert.ok(a.author.name);
  assert.deepEqual(b.author, signed(agent));
  assert.equal(b.messages.length, 0, "a suggestion needs no message");
});

test("a malformed or foreign file in the folder is skipped, never fatal", () => {
  const file = writeDoc();
  threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "ok" });
  fs.writeFileSync(path.join(threads.threadDir(file), "t_20260101T000000Z_abcdef.json"), "{ not json");
  fs.writeFileSync(path.join(threads.threadDir(file), "notes.txt"), "hello");
  assert.equal(threads.listThreads(file).length, 1);
});

test("creating a thread checks what it is about", () => {
  const file = writeDoc();
  assert.throws(() => threads.createThread(file, { kind: "comment", anchor: null, body: "x" }), /quoted text/);
  assert.throws(() => threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "  " }), /needs a message/);
  assert.throws(() => threads.createThread(file, { kind: "suggestion", anchor: anchor("weekly") }), /replacement/);
  assert.throws(() => threads.createThread(file, { kind: "suggestion", anchor: anchor("weekly"), replacement: "weekly" }), /does not change/);
  assert.throws(() => threads.createThread(file, { kind: "poll", anchor: anchor("weekly"), body: "x" }), /kind must be/);
});

test("statuses follow the thread kind, and every change is recorded", () => {
  const file = writeDoc();
  const c = threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "x" });
  assert.throws(() => threads.setThreadStatus(file, c.id, "accepted"), /cannot become accepted/);
  assert.equal(threads.setThreadStatus(file, c.id, "resolved").status, "resolved");
  assert.equal(threads.setThreadStatus(file, c.id, "open").history.length, 3);

  const s = threads.createThread(file, { kind: "suggestion", anchor: anchor("weekly"), replacement: "daily" });
  assert.throws(() => threads.setThreadStatus(file, s.id, "applied"), /cannot become applied/);
  threads.setThreadStatus(file, s.id, "accepted", { note: "Agreed" });
  const applied = threads.setThreadStatus(file, s.id, "applied", { author: agent });
  assert.equal(applied.status, "applied");
  assert.equal(applied.messages.at(-1).body, "Agreed");
  assert.deepEqual(applied.history.at(-1).by, signed(agent));
});

test("agent work is open asks plus accepted suggestions, and an agent reply answers the ask", () => {
  const file = writeDoc();
  const ask = threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "Agent, check this", askAgent: true });
  threads.createThread(file, { kind: "comment", anchor: anchor("second"), body: "Just for co-authors" });
  const s = threads.createThread(file, { kind: "suggestion", anchor: anchor("every"), replacement: "each" });
  assert.deepEqual(threads.agentWork(threads.listThreads(file)).map((t) => t.id), [ask.id]);
  threads.setThreadStatus(file, s.id, "accepted");
  assert.equal(threads.agentWork(threads.listThreads(file)).length, 2);

  threads.replyToThread(file, ask.id, { body: "A human chiming in" });
  assert.equal(threads.getThread(file, ask.id).ask_agent, true, "a human reply leaves the ask open");
  threads.replyToThread(file, ask.id, { body: "Checked: it is weekly.", author: agent });
  assert.equal(threads.getThread(file, ask.id).ask_agent, false);
  threads.setThreadStatus(file, s.id, "applied", { author: agent });
  assert.equal(threads.agentWork(threads.listThreads(file)).length, 0);
});

test("unknown or path-like thread ids are refused", () => {
  const file = writeDoc();
  assert.equal(threads.getThread(file, "../../etc/passwd"), null);
  assert.throws(() => threads.replyToThread(file, "t_nope", { body: "x" }), /no thread/);
});

test("rendered text drops tags, scripts, and styles and decodes entities", () => {
  const text = htmlToText("<html><head><title>T</title></head><body><style>p{}</style><p>A &amp; B&nbsp;C</p><script>x()</script><!-- c --><p>&#233;&#x41;</p></body></html>");
  assert.equal(text, "A & B CéA");
});

test("the CLI writes threads as an agent, anchored to the rendered text", () => {
  const file = writeDoc();
  const dir = path.dirname(file);
  const made = run(["suggest", "plan.md", "--quote", "every second", "--replacement", "each second", "--body", "Tighter", "--agent", "Claude Code", "--model", "claude-opus-5-5"], dir);
  assert.equal(made.status, 0, made.stderr);
  const thread = JSON.parse(made.stdout);
  assert.equal(thread.kind, "suggestion");
  assert.deepEqual(thread.author, signed(agent));
  assert.match(thread.anchor.prefix, /Sensors record $/, "context comes from the rendered page, so the bold markup is gone");

  const source = run(["comment", "plan.md", "--quote", "**every**", "--body", "x"], dir);
  assert.notEqual(source.status, 0);
  assert.match(source.stderr, /not in the rendered text/);

  const repeated = run(["comment", "plan.md", "--quote", "Cages are cleaned weekly.", "--body", "Twice?"], dir);
  assert.equal(repeated.status, 0);
  assert.match(repeated.stderr, /--prefix or --suffix/);

  assert.equal(run(["accept", "plan.md", thread.id], dir).status, 0);
  const work = JSON.parse(run(["threads", "plan.md", "--for-agent", "--json"], dir).stdout);
  assert.deepEqual(work.map((t) => t.id), [thread.id]);
  const applied = run(["applied", "plan.md", thread.id, "--agent", "Claude Code"], dir);
  assert.equal(JSON.parse(applied.stdout).status, "applied");
  assert.match(run(["threads", "plan.md", "--all"], dir).stdout, /suggestion · applied/);

  const text = run(["text", "plan.md"], dir);
  assert.match(text.stdout, /Sensors record every second\./);
});

test("the server shows threads, writes them as the local human, and ships agent work in the batch", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const file = writeDoc();
  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { file } });
  const { key, sessionId } = opened.json();

  const page = (await request(port, token, { route: `/api/page/${key}` })).json();
  assert.deepEqual(page.threads, []);
  assert.equal(page.me.type, "human");
  assert.equal(page.agentThreads, 0);

  const made = await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/thread`,
    body: { kind: "comment", anchor: { prefix: "Sensors record ", quote: "every second", suffix: ". Cages", selector: "p" }, body: "Which sensors?", askAgent: true, author: agent },
  });
  assert.equal(made.status, 200, made.raw);
  const { thread } = made.json();
  assert.equal(thread.author.type, "human", "the browser cannot claim to be an agent");
  assert.equal(thread.anchor.selector, undefined, "only the quote anchor is stored");
  assert.equal(made.json().page.agentThreads, 1);

  const bad = await request(port, token, { method: "POST", route: `/api/page/${key}/thread/${thread.id}/status`, body: { status: "accepted" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /cannot become accepted/);

  const sent = await request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId, note: "" } });
  assert.equal(sent.status, 200, sent.raw);
  const batch = (await request(port, token, { route: `/api/poll?file=${encodeURIComponent(file)}` })).json();
  const shipped = batch.pages[0].threads;
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0].id, thread.id);
  assert.equal(shipped[0].ask_agent, true);
  assert.match(batch.next_step, /reply <file> <id> --agent/);

  // An agent answering from the CLI clears the ask; the open page hears about it.
  threads.replyToThread(file, thread.id, { body: "Infrared and RFID.", author: agent });
  const after = (await request(port, token, { route: `/api/page/${key}` })).json();
  assert.equal(after.agentThreads, 0);
  assert.equal(after.threads[0].messages.at(-1).author.type, "agent");
});

test("localhost pages have no shared threads", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { target: "http://localhost:59999/" } });
  if (opened.status !== 200) return; // URL sessions need a live server in some setups.
  const { key } = opened.json();
  const page = (await request(port, token, { route: `/api/page/${key}` })).json();
  assert.equal(page.threads, undefined);
  const res = await request(port, token, { method: "POST", route: `/api/page/${key}/thread`, body: { kind: "comment", anchor: anchor("x"), body: "x" } });
  assert.equal(res.status, 400);
});

test("an open page hears about threads written outside the browser", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const file = writeDoc();
  const { sessionId } = (await request(port, token, { method: "POST", route: "/api/session", body: { file } })).json();

  const heard = new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/events/${sessionId}`, headers: { "x-human-review-token": token } }, (res) => {
      res.setEncoding("utf8");
      let seen = "";
      res.on("data", (chunk) => {
        seen += chunk;
        if (seen.includes("event: threads")) {
          req.destroy();
          resolve(true);
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("no threads event")), 5000);
  });
  // Let the watcher record the empty folder first, as an open page would.
  await new Promise((r) => setTimeout(r, 200));
  threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "From the CLI", author: agent });
  assert.equal(await heard, true);
});

test("a reviewer's chosen name and colour sign their threads; others get a stable colour", () => {
  const file = writeDoc();
  threads.writeProfile({ name: "Damien H.", color: "#D6487E" });
  try {
    const mine = threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "Mine" });
    assert.deepEqual(mine.author, { name: "Damien H.", type: "human", color: "#d6487e" });
    const theirs = threads.createThread(file, { kind: "comment", anchor: anchor("second"), body: "Theirs", author: { name: "Cyril", type: "human" } });
    assert.equal(theirs.author.color, threads.colorFor("Cyril"));
    assert.ok(threads.PALETTE.includes(theirs.author.color));
    const bad = threads.createThread(file, { kind: "comment", anchor: anchor("every"), body: "x", author: { name: "Eve", type: "human", color: "red; background:url(x)" } });
    assert.equal(bad.author.color, threads.colorFor("Eve"), "only #rrggbb colours are kept");

    // A thread from before colours existed is painted on read.
    const legacy = { ...mine, author: { name: "Old", type: "human" }, messages: [{ id: "m_1", author: { name: "Old", type: "human" }, body: "x", at: mine.created_at }] };
    assert.equal(threads.withColors(legacy).messages[0].author.color, threads.colorFor("Old"));
  } finally {
    threads.writeProfile({ name: "", color: "" });
  }
});

test("the profile route sets the name and colour the browser writes threads with", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => {
    threads.writeProfile({ name: "", color: "" });
    dispose();
  });
  const file = writeDoc();
  const { key } = (await request(port, token, { method: "POST", route: "/api/session", body: { file } })).json();
  const set = await request(port, token, { method: "POST", route: "/api/profile", body: { name: "Konstantin", color: "#1f9fa3" } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json().profile, { name: "Konstantin", color: "#1f9fa3" });
  assert.equal(set.json().palette.length, threads.PALETTE.length);
  const page = (await request(port, token, { route: `/api/page/${key}` })).json();
  assert.deepEqual(page.me, { name: "Konstantin", type: "human", color: "#1f9fa3" });
  const made = await request(port, token, { method: "POST", route: `/api/page/${key}/thread`, body: { kind: "comment", anchor: anchor("weekly"), body: "Hi" } });
  assert.equal(made.json().thread.author.name, "Konstantin");
});

test("the CLI shows and sets the profile, and --color signs agent writes", () => {
  const file = writeDoc();
  const dir = path.dirname(file);
  try {
    const set = run(["profile", "--name", "Pierre", "--color", "#8a5cd6"], dir);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(set.stdout).name, "Pierre");
    assert.notEqual(run(["profile", "--color", "purple"], dir).status, 0);
    const mine = JSON.parse(run(["comment", "plan.md", "--quote", "every second", "--body", "x"], dir).stdout);
    assert.deepEqual(mine.author, { name: "Pierre", type: "human", color: "#8a5cd6" });
    const bot = JSON.parse(run(["comment", "plan.md", "--quote", "every second", "--body", "y", "--agent", "Codex", "--color", "#E08A1E"], dir).stdout);
    assert.equal(bot.author.color, "#e08a1e");
  } finally {
    threads.writeProfile({ name: "", color: "" });
  }
});
