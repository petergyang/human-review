import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-test-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { Store, atomicWrite, resolveAsset } = await import("../src/state.js");
const { canonicalTarget, localUrl, targetKey } = await import("../src/paths.js");

function page(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}

test("openPage records the agent's version as the revert target", () => {
  const store = new Store();
  const file = page("a.html", "<h1>v1</h1>");
  const opened = store.openPage(file, "<h1>v1</h1>");
  assert.equal(opened.pristine, "<h1>v1</h1>");
  assert.deepEqual(opened.comments, []);
  assert.equal(store.pageForFile(file).key, opened.key);
});

test("reopening a page keeps its comments", () => {
  const store = new Store();
  const file = page("b.html", "<h1>v1</h1>");
  const { key } = store.openPage(file, "<h1>v1</h1>");
  store.addComment(key, { id: "c1", kind: "selection", quote: "v1", feedback: "tighten" });

  const reloaded = new Store();
  assert.equal(reloaded.page(key).comments.length, 1);
  assert.equal(reloaded.page(key).comments[0].feedback, "tighten");
});

test("edits dedupe on label and kind", () => {
  const store = new Store();
  const { key } = store.openPage(page("c.html", "<p>x</p>"), "<p>x</p>");
  store.addEdit(key, "Problem body", "edited");
  store.addEdit(key, "Problem body", "edited");
  store.addEdit(key, "Problem body", "deleted");
  assert.equal(store.page(key).edits.length, 2);
});

test("an agent rewrite becomes the new pristine and clears edits", () => {
  const store = new Store();
  const { key } = store.openPage(page("d.html", "<p>v1</p>"), "<p>v1</p>");
  store.addEdit(key, "Body", "edited");
  store.setPristine(key, "<p>v2</p>");
  assert.equal(store.page(key).pristine, "<p>v2</p>");
  assert.deepEqual(store.page(key).edits, []);
});

test("clearSent removes only the delivered comments", () => {
  const store = new Store();
  const { key } = store.openPage(page("e.html", "<p>x</p>"), "<p>x</p>");
  store.addComment(key, { id: "c1", feedback: "one" });
  store.addComment(key, { id: "c2", feedback: "two" });
  store.addEdit(key, "Body", "edited");
  store.clearSent(key, ["c1"]);
  assert.deepEqual(store.page(key).comments.map((c) => c.id), ["c2"]);
  assert.deepEqual(store.page(key).edits, []);
});

test("pages are independent of one another", () => {
  const store = new Store();
  const a = store.openPage(page("p1.html", "<p>a</p>"), "<p>a</p>");
  const b = store.openPage(page("p2.html", "<p>b</p>"), "<p>b</p>");
  store.addComment(a.key, { id: "x", feedback: "on a" });
  assert.equal(store.page(a.key).comments.length, 1);
  assert.equal(store.page(b.key).comments.length, 0);
});

test("localhost targets are canonical, durable, and distinct from files", () => {
  assert.equal(localUrl("http://localhost:3000/wiki#section"), "http://localhost:3000/wiki");
  assert.deepEqual(canonicalTarget("http://127.0.0.1:4000/plan"), {
    kind: "url",
    value: "http://127.0.0.1:4000/plan",
  });
  assert.throws(() => localUrl("https://example.com/wiki"), /limited to localhost/);

  const store = new Store();
  const opened = store.openUrl("http://localhost:3000/wiki#ignored");
  assert.equal(opened.kind, "url");
  assert.equal(opened.url, "http://localhost:3000/wiki");
  assert.equal(opened.key, targetKey(opened.url));
  assert.equal(store.pageForTarget(opened.url).key, opened.key);

  const reloaded = new Store();
  assert.equal(reloaded.page(opened.key).url, opened.url, "URL pages survive without a backing file");
});

test("stale pages and pages whose file vanished are pruned on load", () => {
  const store = new Store();
  const keepFile = page("keep.html", "<p>keep</p>");
  const staleFile = page("stale.html", "<p>stale</p>");
  const goneFile = page("gone.html", "<p>gone</p>");
  const keep = store.openPage(keepFile, "<p>keep</p>");
  const stale = store.openPage(staleFile, "<p>stale</p>");
  const gone = store.openPage(goneFile, "<p>gone</p>");

  store.data.pages[stale.key].updatedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(statePathFor(), JSON.stringify(store.data, null, 2));
  fs.rmSync(goneFile);

  const reloaded = new Store();
  assert.ok(reloaded.page(keep.key), "recent page with a live file survives");
  assert.equal(reloaded.page(stale.key), null, "month-old page is pruned");
  assert.equal(reloaded.page(gone.key), null, "page whose file vanished is pruned");
});

function statePathFor() {
  return path.join(process.env.HUMAN_REVIEW_STATE_DIR, "state.json");
}

test("sent batches persist across a restart, and an ack stays acked", () => {
  const store = new Store();
  const { key } = store.openPage(page("batch.html", "<p>x</p>"), "<p>x</p>");
  store.setBatch(key, { batch: { status: "feedback", pages: [] }, cleanup: [] });

  const restarted = new Store();
  assert.ok(restarted.batch(key), "an unacked batch survives a restart");

  restarted.clearBatch(key);
  restarted.save();
  const again = new Store();
  assert.equal(again.batch(key), null, "an acked batch is not resurrected by a later save");
});

test("resolveAsset refuses to escape the artifact's directory", () => {
  const file = path.join(tmp, "dir", "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "<p>x</p>");
  assert.equal(resolveAsset(file, "style.css"), path.join(tmp, "dir", "style.css"));
  assert.equal(resolveAsset(file, "nested/app.js"), path.join(tmp, "dir", "nested", "app.js"));
  assert.equal(resolveAsset(file, "../secret.txt"), null);
  assert.equal(resolveAsset(file, "../../etc/passwd"), null);
  assert.equal(resolveAsset(file, "%zz"), null, "malformed percent-encoding is a miss, not a crash");
});

test(
  "resolveAsset refuses a symlink that points outside the directory",
  { skip: process.platform === "win32" ? "symlink creation needs privileges on Windows" : false },
  () => {
    const dir = path.join(tmp, "symdir");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "<p>x</p>");
    const secret = path.join(tmp, "outside-secret.txt");
    fs.writeFileSync(secret, "top secret");
    fs.symlinkSync(secret, path.join(dir, "leak.txt"));
    assert.equal(resolveAsset(file, "leak.txt"), null);

    // A regular sibling still resolves (to its real path).
    fs.writeFileSync(path.join(dir, "style.css"), "body{}");
    assert.equal(resolveAsset(file, "style.css"), fs.realpathSync(path.join(dir, "style.css")));
  }
);

/**
 * atomicWrite's retry lives behind the fs calls it makes, not behind an
 * exported seam, so these tests swap those calls out and drive the real
 * two-argument entry point. Atomics.wait stands in for the backoff: sleepSync
 * is the only thing that calls it.
 */
const realRename = fs.renameSync;
const realUnlink = fs.unlinkSync;
const realWait = Atomics.wait;

function withPatchedFs({ rename, unlink, wait }, fn) {
  if (rename) fs.renameSync = rename;
  if (unlink) fs.unlinkSync = unlink;
  if (wait) Atomics.wait = wait;
  try {
    return fn();
  } finally {
    fs.renameSync = realRename;
    fs.unlinkSync = realUnlink;
    Atomics.wait = realWait;
  }
}

const fail = (code) => {
  const err = new Error(code + ": simulated");
  err.code = code;
  return err;
};

/** A rename that fails with `code` its first `times` calls, then succeeds. */
function flakyRename(code, times) {
  const calls = { count: 0 };
  return {
    calls,
    rename: (from, to) => {
      if (++calls.count <= times) throw fail(code);
      return realRename(from, to);
    },
  };
}

/** Records the backoff without actually waiting, so the suite stays fast. */
function recordWaits(slept) {
  return (...args) => {
    slept.push(args[3]);
    return "timed-out";
  };
}

const orphans = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".human-review.tmp"));
const scratch = (name) => fs.mkdtempSync(path.join(tmp, name));

function capture(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test("atomicWrite retries a " + code + " rename, which Windows scanners cause", () => {
    const dir = scratch("retry-");
    const file = path.join(dir, "state.json");
    const { calls, rename } = flakyRename(code, 2);
    const slept = [];

    withPatchedFs({ rename, wait: recordWaits(slept) }, () => atomicWrite(file, "payload"));

    assert.equal(fs.readFileSync(file, "utf8"), "payload");
    assert.equal(calls.count, 3, "two failures then a success");
    assert.deepEqual(slept, [1, 2], "backs off between attempts");
    assert.deepEqual(orphans(dir), [], "no tmp file left behind");
  });
}

test("atomicWrite gives up after a bounded number of retries", () => {
  const dir = scratch("give-up-");
  const file = path.join(dir, "state.json");
  const { calls, rename } = flakyRename("EPERM", Infinity);
  const slept = [];

  const thrown = withPatchedFs({ rename, wait: recordWaits(slept) }, () =>
    capture(() => atomicWrite(file, "payload"))
  );

  assert.equal(thrown?.code, "EPERM", "a truly stuck file still surfaces its error");
  assert.equal(calls.count, 5, "bounded");
  assert.deepEqual(slept, [1, 2, 4, 8], "no wait after the final attempt");
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(orphans(dir), [], "cleans up even when every attempt fails");
});

test("atomicWrite never retries an error that a retry cannot fix", () => {
  const dir = scratch("fatal-");
  const file = path.join(dir, "state.json");
  const { calls, rename } = flakyRename("ENOSPC", Infinity);
  const slept = [];

  const thrown = withPatchedFs({ rename, wait: recordWaits(slept) }, () =>
    capture(() => atomicWrite(file, "payload"))
  );

  assert.equal(thrown?.code, "ENOSPC");
  assert.equal(calls.count, 1, "fails fast");
  assert.deepEqual(slept, []);
  assert.deepEqual(orphans(dir), []);
});

test("atomicWrite clears the temp file even when the unlink is blocked too", () => {
  const dir = scratch("unlink-blocked-");
  const file = path.join(dir, "state.json");
  const { rename } = flakyRename("EPERM", Infinity);
  const slept = [];

  // The handle that blocks the rename blocks the unlink for just as long.
  let unlinkCalls = 0;
  const unlink = (target) => {
    if (++unlinkCalls <= 2) throw fail("EPERM");
    return realUnlink(target);
  };

  const thrown = withPatchedFs({ rename, unlink, wait: recordWaits(slept) }, () =>
    capture(() => atomicWrite(file, "payload"))
  );

  assert.equal(thrown?.code, "EPERM");
  assert.equal(unlinkCalls, 3, "keeps trying while the handle is held");
  assert.deepEqual(orphans(dir), [], "nothing stranded in the state directory");
  // The first four waits are the rename retries; the rest is cleanup backing
  // off, so dropping that sleep would fail here.
  assert.deepEqual(slept, [1, 2, 4, 8, 1, 2], "cleanup backs off as well");
});

test("cleanup exhaustion is bounded the same way the rename retry is", () => {
  const dir = scratch("unlink-stuck-");
  const file = path.join(dir, "state.json");
  const { rename } = flakyRename("EPERM", Infinity);
  const slept = [];

  const cleanupFailure = fail("EPERM");
  let unlinkCalls = 0;
  const unlink = () => {
    unlinkCalls++;
    throw cleanupFailure;
  };

  const thrown = withPatchedFs({ rename, unlink, wait: recordWaits(slept) }, () =>
    capture(() => atomicWrite(file, "payload"))
  );

  // Both errors carry EPERM, so only identity can tell them apart.
  assert.ok(thrown, "the write failure has to reach the caller");
  assert.notEqual(thrown, cleanupFailure, "the write error survives, not the cleanup error");
  assert.equal(unlinkCalls, 5, "cleanup gives up after the same number of attempts");
  assert.deepEqual(slept, [1, 2, 4, 8, 1, 2, 4, 8], "no wait after the final attempt");
});

test("a sleep that throws mid-retry cannot hijack the rename error", () => {
  const dir = scratch("retry-sleep-throws-");
  const file = path.join(dir, "state.json");
  const { rename } = flakyRename("EPERM", Infinity);
  const sleepFailure = new Error("sleep exploded");

  // The very first wait belongs to the retry loop, so this covers the retry
  // phase; the cleanup phase is covered below.
  const thrown = withPatchedFs(
    {
      rename,
      wait: () => {
        throw sleepFailure;
      },
    },
    () => capture(() => atomicWrite(file, "payload"))
  );

  assert.ok(thrown, "the write failure has to reach the caller");
  assert.notEqual(thrown, sleepFailure, "a broken sleeper must not become the reported error");
  assert.equal(thrown.code, "EPERM");
  assert.deepEqual(orphans(dir), []);
});

test("a sleep that throws during cleanup cannot hijack the write error either", () => {
  const dir = scratch("cleanup-sleep-throws-");
  const file = path.join(dir, "state.json");
  const { rename } = flakyRename("EPERM", Infinity);
  const sleepFailure = new Error("sleep exploded");

  // Cleanup is the only phase that calls unlink, so that marks the boundary.
  let inCleanup = false;
  const unlink = () => {
    inCleanup = true;
    throw fail("EPERM");
  };

  const thrown = withPatchedFs(
    {
      rename,
      unlink,
      wait: () => {
        if (inCleanup) throw sleepFailure;
        return "timed-out";
      },
    },
    () => capture(() => atomicWrite(file, "payload"))
  );

  assert.ok(inCleanup, "the test has to actually reach the cleanup path");
  assert.ok(thrown, "the write failure has to reach the caller");
  assert.notEqual(thrown, sleepFailure, "a broken sleeper must not become the reported error");
  assert.equal(thrown.code, "EPERM");
});

test("the backoff really sleeps, on Node's main thread", () => {
  const dir = scratch("real-sleep-");
  const file = path.join(dir, "state.json");
  const { calls, rename } = flakyRename("EPERM", 3);

  // Atomics.wait is left alone here, so this runs the real sleeper. Spying on
  // it would prove it was called but not that it waited; elapsed time is the
  // part a no-op cannot fake.
  const started = process.hrtime.bigint();
  withPatchedFs({ rename }, () => atomicWrite(file, "payload"));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(fs.readFileSync(file, "utf8"), "payload");
  assert.equal(calls.count, 4);
  // Waits total 1 + 2 + 4 = 7ms; allow a little timer granularity, but stay
  // far above the ~0ms a no-op or throwing sleeper would take.
  assert.ok(elapsedMs >= 6, "expected a real delay, waited " + elapsedMs.toFixed(2) + "ms");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
