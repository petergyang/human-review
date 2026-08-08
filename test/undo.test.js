import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-undo-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { Store } = await import("../src/state.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-human-review-token": token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const j = (res) => JSON.parse(res.raw);

// ------------------------------------------------------------------- store

test("every edit row gets a durable id", () => {
  const store = new Store();
  const file = path.join(tmp, "ids.html");
  fs.writeFileSync(file, "<p>x</p>");
  const { key } = store.openPage(file, "<p>x</p>");
  store.addEdit(key, "Body", "edited", "a", "b");
  const [row] = store.page(key).edits;
  assert.match(row.id, /^e_[0-9a-f]{12}$/);
});

test("edits dedupe by cid first, so live twin labels stay separate rows", () => {
  const store = new Store();
  const file = path.join(tmp, "cid.html");
  fs.writeFileSync(file, "<p>x</p>");
  const { key } = store.openPage(file, "<p>x</p>");
  const boot = Date.now() - 1000; // both blocks live in the same frame
  store.addEdit(key, "Intro · p 2", "edited", "a", "b", undefined, undefined, { cid: "b1:edited" }, boot);
  store.addEdit(key, "Intro · p 2", "edited", "a", "c", undefined, undefined, { cid: "b1:edited" }, boot);
  store.addEdit(key, "Intro · p 2", "edited", "q", "r", undefined, undefined, { cid: "b2:edited" }, boot);
  const edits = store.page(key).edits;
  assert.equal(edits.length, 2, "same cid merges, a different live cid does not");
  assert.equal(edits[0].after, "c", "the merged row carries the latest wording");
});

test("label+kind fallback keeps one row across a frame reload", () => {
  const store = new Store();
  const file = path.join(tmp, "reload.html");
  fs.writeFileSync(file, "<p>x</p>");
  const { key } = store.openPage(file, "<p>x</p>");
  store.addEdit(key, "Body", "edited", "a", "b", undefined, undefined, { cid: "b1:edited" }, Date.now() - 1000);
  // After a reload the same block boots with a fresh cid; the old row predates
  // the new frame's boot, so it is the same block and merges.
  store.addEdit(key, "Body", "edited", "a", "c", undefined, undefined, { cid: "b9:edited" }, Date.now() + 1000);
  const edits = store.page(key).edits;
  assert.equal(edits.length, 1);
  assert.equal(edits[0].after, "c");
  assert.equal(edits[0].cid, "b9:edited", "the row now belongs to the fresh cid");
});

test("removeEdit drops exactly one row by id", () => {
  const store = new Store();
  const file = path.join(tmp, "remove.html");
  fs.writeFileSync(file, "<p>x</p>");
  const { key } = store.openPage(file, "<p>x</p>");
  store.addEdit(key, "Body", "edited", "a", "b");
  store.addEdit(key, "Body", "deleted", "gone", "");
  const [edited, deleted] = store.page(key).edits;
  assert.ok(store.removeEdit(key, deleted.id));
  assert.deepEqual(store.page(key).edits.map((e) => e.id), [edited.id]);
  assert.equal(store.removeEdit(key, "e_nope"), null, "an unknown id is a miss, not a crash");
});

// ------------------------------------------------------------------ server

let running;
let sessionKey;

test("DELETE /api/page/:key/edit/:id undoes one row over the wire", async () => {
  const file = path.join(tmp, "wire.html");
  fs.writeFileSync(file, "<p>Original</p>");
  running = await start(0);
  const { port, token } = running;

  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { file } }));
  sessionKey = opened.key;
  await request(port, token, {
    method: "POST",
    route: `/api/page/${sessionKey}/edit`,
    body: { cid: "b1:edited", label: "Body", kind: "edited", before: "Original", after: "Changed" },
  });
  await request(port, token, {
    method: "POST",
    route: `/api/page/${sessionKey}/edit`,
    body: { cid: "b2:deleted", label: "Aside", kind: "deleted", before: "Gone", after: "" },
  });

  const page = j(await request(port, token, { route: `/api/page/${sessionKey}` }));
  assert.equal(page.edits.length, 2);
  const deleted = page.edits.find((e) => e.kind === "deleted");
  assert.ok(deleted.id, "rows carry their id to the browser");
  assert.equal(deleted.cid, "b2:deleted", "rows carry their cid to the browser");

  const undone = await request(port, token, { method: "DELETE", route: `/api/page/${sessionKey}/edit/${deleted.id}` });
  assert.equal(undone.status, 200);
  assert.deepEqual(j(undone).page.edits.map((e) => e.kind), ["edited"]);

  const missing = await request(port, token, { method: "DELETE", route: `/api/page/${sessionKey}/edit/${deleted.id}` });
  assert.equal(missing.status, 404, "undoing the same row twice is a clean 404");
});

test("the agent batch is unchanged: no id or cid fields ship to the agent", async () => {
  const { port, token } = running;
  const sessions = j(await request(port, token, { route: `/api/page/${sessionKey}` }));
  assert.ok(sessions.edits.length >= 1);

  // Send what is left and read the batch the agent would receive.
  const opened = j(
    await request(port, token, { method: "POST", route: "/api/session", body: { file: path.join(tmp, "wire.html") } })
  );
  await request(port, token, {
    method: "POST",
    route: `/api/page/${sessionKey}/send`,
    body: { sessionId: opened.sessionId, note: "" },
  });
  const poll = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(path.join(tmp, "wire.html"))}` }));
  assert.equal(poll.status, "feedback");
  const keys = Object.keys(poll.pages[0].edits[0]);
  assert.ok(!keys.includes("id") && !keys.includes("cid"), `agent-facing edit keys stay clean: ${keys}`);
});

test.after(async () => {
  if (running) running.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});
