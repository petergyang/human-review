import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-thread-git-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const threads = await import("../src/threads.js");
const tg = await import("../src/thread-git.js");

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js").split(path.sep).join("/");
const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const needsGit = { skip: hasGit ? false : "git is not installed" };

const anchor = (quote) => ({ prefix: "", quote, suffix: "" });
const alice = { name: "Alice", type: "human" };
const bob = { name: "Bob", type: "human" };

function git(cwd, ...args) {
  const out = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return out;
}

/** A repo whose main branch has a document and one open suggestion. */
function repoWithThread() {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(dir, "init", "-q", "-b", "main");
  const file = path.join(dir, "plan.md");
  fs.writeFileSync(file, "# Plan\n\nCages are cleaned weekly.\n");
  const thread = threads.createThread(file, { kind: "suggestion", anchor: anchor("weekly"), replacement: "twice a week", author: alice });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  return { dir, file: fs.realpathSync(file), id: thread.id };
}

const read = (file, id) => JSON.parse(fs.readFileSync(path.join(threads.threadDir(file), `${id}.json`), "utf8"));

// ------------------------------------------------------------------ merge rules

test("merging keeps every reply from both sides, in time order", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "m-"));
  const file = path.join(dir, "a.md");
  fs.writeFileSync(file, "x weekly\n");
  const base = threads.createThread(file, { kind: "comment", anchor: anchor("weekly"), body: "Start", author: alice });
  const ours = threads.replyToThread(file, base.id, { body: "Ours", author: alice });
  const theirs = { ...base, messages: [...base.messages, { id: "m_bbbbbbbb", author: bob, body: "Theirs", at: new Date(Date.now() + 1000).toISOString() }], updated_at: new Date(Date.now() + 1000).toISOString() };
  const merged = threads.mergeThreads(ours, theirs);
  assert.deepEqual(merged.messages.map((m) => m.body), ["Start", "Ours", "Theirs"]);
  assert.equal(merged.conflict, undefined);
  assert.deepEqual(threads.mergeThreads(merged, merged).messages.length, 3, "merging is idempotent");
});

test("a decision made on one side only is kept; different decisions reopen the thread for people", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "m-"));
  const file = path.join(dir, "a.md");
  fs.writeFileSync(file, "x weekly\n");
  const base = threads.createThread(file, { kind: "suggestion", anchor: anchor("weekly"), replacement: "daily", author: alice });
  const accepted = threads.setThreadStatus(file, base.id, "accepted", { author: alice });
  assert.equal(threads.mergeThreads(accepted, base).status, "accepted");
  assert.equal(threads.mergeThreads(base, accepted).status, "accepted");

  const rejected = { ...base, status: "rejected", history: [...base.history, { status: "rejected", by: bob, at: new Date(Date.now() + 500).toISOString() }] };
  const merged = threads.mergeThreads(accepted, rejected);
  assert.equal(merged.status, "open");
  assert.deepEqual(merged.conflict.outcomes.map((o) => [o.status, o.by.name]), [["accepted", "Alice"], ["rejected", "Bob"]]);
  assert.match(merged.messages.at(-1).body, /Alice marked it accepted, but Bob marked it rejected/);
  assert.equal(merged.messages.at(-1).author.type, "system");

  const viewOnly = threads.mergeThreads(accepted, rejected, { record: false });
  assert.ok(viewOnly.conflict);
  assert.equal(viewOnly.messages.length, base.messages.length, "showing a disagreement writes nothing into it");

  // Deciding again settles it.
  threads.saveThread(file, merged);
  const settled = threads.setThreadStatus(file, base.id, "accepted", { author: alice });
  assert.equal(settled.conflict, undefined);
});

test("conflict markers split back into both versions, in git's default and diff3 styles", () => {
  const plain = ["{", "<<<<<<< HEAD", '  "a": 1', "=======", '  "a": 2', ">>>>>>> other", "}"].join("\n");
  assert.deepEqual(threads.splitConflict(plain), { ours: '{\n  "a": 1\n}', theirs: '{\n  "a": 2\n}' });
  const diff3 = ["{", "<<<<<<< HEAD", '  "a": 1', "||||||| base", '  "a": 0', "=======", '  "a": 2', ">>>>>>> other", "}"].join("\n");
  assert.deepEqual(threads.splitConflict(diff3), { ours: '{\n  "a": 1\n}', theirs: '{\n  "a": 2\n}' });
  assert.equal(threads.splitConflict('{ "a": 1 }'), null);
});

// ------------------------------------------------------------------ real git

function divergingDecisions({ withDriver }) {
  const { dir, file, id } = repoWithThread();
  if (withDriver) tg.setupGit(dir, `node "${cli}"`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "driver", "--allow-empty");
  git(dir, "checkout", "-q", "-b", "alice");
  threads.replyToThread(file, id, { body: "Yes, twice a week.", author: alice });
  threads.setThreadStatus(file, id, "accepted", { author: alice });
  git(dir, "commit", "-q", "-am", "alice accepts");
  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-q", "-b", "bob");
  threads.replyToThread(file, id, { body: "No, weekly is the SOP.", author: bob });
  threads.setThreadStatus(file, id, "rejected", { author: bob });
  git(dir, "commit", "-q", "-am", "bob rejects");
  git(dir, "checkout", "-q", "alice");
  const merged = git(dir, "merge", "--no-edit", "bob");
  return { dir, file, id, merged };
}

test("with the merge driver, two branches that both answered a thread merge cleanly", needsGit, () => {
  const { dir, file, id, merged } = divergingDecisions({ withDriver: true });
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  const thread = read(file, id);
  assert.deepEqual(
    thread.messages.filter((m) => m.author.type === "human").map((m) => m.body).sort(),
    ["No, weekly is the SOP.", "Yes, twice a week."]
  );
  assert.equal(thread.status, "open");
  assert.equal(thread.conflict.outcomes.length, 2);
  assert.match(fs.readFileSync(path.join(dir, ".gitattributes"), "utf8"), /\*\*\/\*\.review\/\*\.json merge=human-review-thread/);
});

test("without the driver, fix-threads repairs the conflict git left behind", needsGit, () => {
  const { dir, file, id, merged } = divergingDecisions({ withDriver: false });
  assert.notEqual(merged.status, 0, "plain git conflicts on the shared thread file");
  assert.match(fs.readFileSync(path.join(threads.threadDir(file), `${id}.json`), "utf8"), /^<{7}/m);

  const fixed = spawnSync(process.execPath, [cli, "fix-threads", "--json"], { cwd: dir, encoding: "utf8", windowsHide: true });
  const results = JSON.parse(fixed.stdout);
  assert.equal(results.length, 1);
  assert.equal(results[0].fixed, true);
  assert.equal(results[0].conflict, true);
  const thread = read(file, id);
  assert.equal(thread.status, "open");
  assert.equal(thread.messages.filter((m) => m.author.type === "human").length, 2);
});

test("threads on other branches show up, marked, and replying brings them onto this branch", needsGit, () => {
  const { dir, file, id } = repoWithThread();
  git(dir, "checkout", "-q", "-b", "pr-cyril");
  const theirs = threads.createThread(file, { kind: "comment", anchor: anchor("Cages"), body: "Which cages?", author: { name: "Cyril", type: "human" } });
  threads.replyToThread(file, id, { body: "Seen on my branch too", author: { name: "Cyril", type: "human" } });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "cyril comments");
  git(dir, "checkout", "-q", "main");

  assert.equal(threads.listThreads(file).length, 1, "the working tree has only main's thread");
  const view = tg.combinedThreads(file);
  const elsewhere = view.find((t) => t.id === theirs.id);
  assert.equal(elsewhere.elsewhere, true);
  assert.deepEqual(elsewhere.branches, ["pr-cyril"]);
  const shared = view.find((t) => t.id === id);
  assert.equal(shared.updates_elsewhere, true);
  assert.equal(shared.messages.at(-1).body, "Seen on my branch too");

  tg.adoptThread(file, theirs.id);
  const adopted = read(file, theirs.id);
  assert.equal(adopted.messages[0].body, "Which cages?");
  assert.equal(adopted.branches, undefined, "view-only fields never reach the file");
});

test("setup --git registers the driver once and is safe to rerun", needsGit, () => {
  const { dir } = repoWithThread();
  tg.setupGit(dir, "human-review");
  const again = tg.setupGit(dir, "human-review");
  assert.match(again.join("\n"), /already declares/);
  const lines = fs.readFileSync(path.join(dir, ".gitattributes"), "utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(git(dir, "config", "merge.human-review-thread.driver").stdout.trim(), "human-review merge-thread %O %A %B");
});
