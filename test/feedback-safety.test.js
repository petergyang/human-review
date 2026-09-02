import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-safety-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { start } = await import("../src/server.js");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fire `poll --ack` the way an agent whose feedback is already delivered
 * does: the ack clears the batch, then the request long-polls for the next
 * one. The test only needs the ack side effect, so the poll is abandoned.
 */
function ackAndAbandon(port, token, target, ms = 200) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/api/poll?target=${encodeURIComponent(target)}&ack=1`,
      headers: { "x-human-review-token": token },
    });
    req.on("error", () => {});
    req.on("response", () => setTimeout(() => {
      req.destroy();
      resolve();
    }, ms));
    req.end();
  });
}

test("ack after a timeout delivers a stranded batch instead of destroying it", async (t) => {
  const file = path.join(tmp, "plan.html");
  fs.writeFileSync(file, "<!DOCTYPE html>\n<html><head></head><body><h1>Head</h1><p>Alpha</p></body></html>\n");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { file } }));
  const key = opened.key;

  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/comment`,
    body: { kind: "selection", quote: "Alpha", feedback: "Tighten this." },
  });
  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/edit`,
    body: { label: "p", kind: "edited", before: "Alpha", after: "Beta" },
  });
  // Send with no agent listening: the batch is stranded, never delivered.
  const sent = j(await request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId: opened.sessionId, note: "" } }));
  assert.equal(sent.ok, true);

  // The agent's previous poll timed out, so it re-runs the same `poll --ack`.
  // That ack refers to a batch it already applied — it must not destroy the
  // stranded one, which must be delivered instead.
  const polled = await request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}&ack=1` });
  const batch = JSON.parse(polled.raw);
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].comments[0].feedback, "Tighten this.");

  const status = j(await request(port, token, { route: `/api/status?target=${encodeURIComponent(file)}` }));
  assert.equal(status.feedback_waiting, true, "the delivered batch still awaits a real ack");

  // Feedback added between delivery and ack belongs to the next batch.
  await sleep(15);
  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/edit`,
    body: { label: "h1", kind: "edited", before: "Head", after: "New head", before_html: "Head", after_html: "New <strong>head</strong>" },
  });
  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/comment`,
    body: { kind: "selection", quote: "Head", feedback: "Late comment." },
  });

  await ackAndAbandon(port, token, file);

  const after = j(await request(port, token, { route: `/api/status?target=${encodeURIComponent(file)}` }));
  assert.equal(after.feedback_waiting, false, "a delivered batch acks normally");

  const page = j(await request(port, token, { route: `/api/page/${key}` }));
  assert.deepEqual(page.comments.map((c) => c.feedback), ["Late comment."], "post-send comments survive the ack");
  assert.deepEqual(page.edits.map((e) => e.label), ["h1"], "post-send edits survive the ack");
  assert.equal(page.edits[0].after_html, "New <strong>head</strong>", "formatting travels with the edit");

  // The surviving edit ships in the next batch, formatting included.
  await request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId: opened.sessionId, note: "" } });
  const next = JSON.parse((await request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}` })).raw);
  const shipped = next.pages[0].edits.find((e) => e.label === "h1");
  assert.equal(shipped.after_html, "New <strong>head</strong>");
  await ackAndAbandon(port, token, file);
});

test("a comment can be reworded before it is sent", async (t) => {
  const file = path.join(tmp, "reword.html");
  fs.writeFileSync(file, "<!DOCTYPE html>\n<html><head></head><body><p>Draft</p></body></html>\n");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { file } }));
  const key = opened.key;
  const added = j(await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/comment`,
    body: { kind: "selection", quote: "Draft", feedback: "First thoughts" },
  }));

  const reworded = await request(port, token, {
    method: "PATCH",
    route: `/api/page/${key}/comment/${added.comment.id}`,
    body: { feedback: "Sharper thoughts" },
  });
  assert.equal(reworded.status, 200);
  assert.deepEqual(j(reworded).page.comments.map((c) => c.feedback), ["Sharper thoughts"]);
  assert.equal(typeof j(reworded).page.comments[0].updatedAt, "number");

  const missing = await request(port, token, { method: "PATCH", route: `/api/page/${key}/comment/c_nope`, body: { feedback: "x" } });
  assert.equal(missing.status, 404);
  const empty = await request(port, token, { method: "PATCH", route: `/api/page/${key}/comment/${added.comment.id}`, body: { feedback: "  " } });
  assert.equal(empty.status, 400);

  // The reworded text is what ships.
  await request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId: opened.sessionId, note: "" } });
  const batch = JSON.parse((await request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}` })).raw);
  assert.deepEqual(batch.pages[0].comments.map((c) => c.feedback), ["Sharper thoughts"]);
  await ackAndAbandon(port, token, file);
});

test("rewording replaces a waiting batch and becomes a correction after delivery", async (t) => {
  const file = path.join(tmp, "reword-after-send.html");
  fs.writeFileSync(file, "<!DOCTYPE html><html><body><p>Draft</p></body></html>");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { file } }));
  const added = j(await request(port, token, {
    method: "POST",
    route: `/api/page/${opened.key}/comment`,
    body: { kind: "selection", quote: "Draft", feedback: "Delete this" },
  }));

  // Nothing is polling yet, so editing should replace the stranded batch in place.
  await request(port, token, { method: "POST", route: `/api/page/${opened.key}/send`, body: { sessionId: opened.sessionId, note: "" } });
  const waitingEdit = j(await request(port, token, {
    method: "PATCH",
    route: `/api/page/${opened.key}/comment/${added.comment.id}`,
    body: { feedback: "Shorten this" },
  }));
  assert.equal(waitingEdit.delivery, "updated-pending");

  const delivered = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}` }));
  assert.equal(delivered.pages[0].comments[0].feedback, "Shorten this", "the agent never sees the superseded wording");

  // Once delivered, a further revision must survive ack as an explicit correction.
  const correction = j(await request(port, token, {
    method: "PATCH",
    route: `/api/page/${opened.key}/comment/${added.comment.id}`,
    body: { feedback: "Keep it, but add an example" },
  }));
  assert.equal(correction.delivery, "correction");
  assert.equal(correction.page.comments[0].correction, true);
  assert.equal(correction.page.comments[0].correctionOf, "Shorten this");
  assert.notEqual(correction.page.comments[0].id, added.comment.id, "the delivered id is retired so ack cannot clear the correction");

  await ackAndAbandon(port, token, file);
  const afterAck = j(await request(port, token, { route: `/api/page/${opened.key}` }));
  assert.equal(afterAck.comments.length, 1);
  assert.equal(afterAck.comments[0].feedback, "Keep it, but add an example");

  await request(port, token, { method: "POST", route: `/api/page/${opened.key}/send`, body: { sessionId: opened.sessionId, note: "" } });
  const correctedBatch = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}` }));
  const shipped = correctedBatch.pages[0].comments[0];
  assert.equal(shipped.correction, true);
  assert.equal(shipped.correction_of, "Shorten this");
  assert.match(correctedBatch.next_step, /replace their `correction_of` instruction/);
  await ackAndAbandon(port, token, file);
});

test("a save based on a stale version of the file is refused", async (t) => {
  const file = path.join(tmp, "save.html");
  const v1 = "<!DOCTYPE html>\n<html><head></head><body><p>One</p></body></html>\n";
  fs.writeFileSync(file, v1);
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { file } }));
  const key = opened.key;

  const raw = j(await request(port, token, { route: `/api/page/${key}/raw` }));
  assert.equal(raw.html, v1);
  assert.ok(raw.hash, "raw hands out the save precondition");

  const v2 = v1.replace("One", "Two");
  const stale = await request(port, token, { method: "POST", route: `/api/page/${key}/save`, body: { html: v2, baseHash: "not-the-hash" } });
  assert.equal(stale.status, 409, "a save that names the wrong base version loses");
  assert.equal(fs.readFileSync(file, "utf8"), v1, "the refused save wrote nothing");

  const good = j(await request(port, token, { method: "POST", route: `/api/page/${key}/save`, body: { html: v2, baseHash: raw.hash } }));
  assert.ok(good.hash, "a successful save returns the next precondition");
  assert.equal(fs.readFileSync(file, "utf8"), v2);

  // The agent-rewrite race: a queued autosave still naming the old version.
  const late = await request(port, token, { method: "POST", route: `/api/page/${key}/save`, body: { html: v1, baseHash: raw.hash } });
  assert.equal(late.status, 409, "the pre-rewrite hash no longer wins");
  assert.equal(fs.readFileSync(file, "utf8"), v2);
});

test("ending a review releases the waiting agent and keeps unsent feedback", async (t) => {
  const file = path.join(tmp, "ended.html");
  fs.writeFileSync(file, "<!DOCTYPE html>\n<html><head></head><body><p>Alpha</p></body></html>\n");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { file } }));
  const key = opened.key;
  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/comment`,
    body: { kind: "selection", quote: "Alpha", feedback: "Unsent thought" },
  });

  // An agent is mid-poll with nothing to deliver.
  const polled = request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}` });
  await sleep(100);

  const ended = await request(port, token, { method: "POST", route: `/api/session/${opened.sessionId}/end` });
  assert.equal(ended.status, 200);

  const answer = JSON.parse((await polled).raw);
  assert.equal(answer.status, "closed", "the poller is released, not left to time out");
  assert.match(answer.next_step, /Stop polling/);

  const gone = await request(port, token, { route: `/api/session/${opened.sessionId}/page` });
  assert.equal(gone.status, 404, "the session is forgotten");

  const page = j(await request(port, token, { route: `/api/page/${key}` }));
  assert.deepEqual(page.comments.map((c) => c.feedback), ["Unsent thought"], "unsent feedback survives the end");
});

test("poll --timeout rejects malformed values instead of waiting forever", async () => {
  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: process.env.HUMAN_REVIEW_STATE_DIR };
  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["src/cli.js", ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    });

  for (const args of [
    ["poll", "x.html", "--timeout", "nope"],
    ["poll", "x.html", "--timeout=abc"],
    ["poll", "x.html", "--timeout", "0"],
    ["poll", "x.html", "--timeout"],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1, `${args.join(" ")} must fail`);
    assert.match(result.stderr, /--timeout/, `${args.join(" ")} names the flag`);
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
