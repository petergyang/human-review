import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-lifecycle-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
// Short graces so the suite stays fast; the real values are seconds.
process.env.HUMAN_REVIEW_CLOSE_GRACE_MS = "150";
process.env.HUMAN_REVIEW_NO_REVIEW_GRACE_MS = "300";

const { start } = await import("../src/server.js");

function request(port, token, { method = "GET", route = "/", body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        // Node's client only chunks bodies on POST/PUT/PATCH; a DELETE body
        // needs an explicit length or it trails the request as garbage.
        headers: {
          ...(token ? { "x-human-review-token": token } : {}),
          ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(body))) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const j = (res) => JSON.parse(res.raw);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A long-poll as the CLI issues it. `.settled` says whether the server answered yet. */
function poll(port, token, target, { ack = false } = {}) {
  const state = { settled: false, req: null };
  state.promise = new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/api/poll?target=${encodeURIComponent(target)}${ack ? "&ack=1" : ""}`, headers: { "x-human-review-token": token } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          state.settled = true;
          resolve(raw.trim() ? JSON.parse(raw) : null);
        });
      }
    );
    req.on("error", (err) => (state.settled ? null : reject(err)));
    req.end();
    state.req = req;
  });
  return state;
}

/** Hold an SSE connection open like a browser tab does. */
function tab(port, sessionId) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/events/${sessionId}` }, (res) => {
      res.on("data", () => {});
      resolve({ close: () => req.destroy() });
    });
  });
}

async function open(port, token, target) {
  return j(await request(port, token, { method: "POST", route: "/api/session", body: { target } }));
}

async function comment(port, token, key, quote, feedback) {
  return j(await request(port, token, { method: "POST", route: `/api/page/${key}/comment`, body: { kind: "selection", quote, feedback } }));
}

async function edit(port, token, key, row) {
  return j(await request(port, token, { method: "POST", route: `/api/page/${key}/edit`, body: { kind: "edited", ...row } }));
}

async function send(port, token, key, sessionId, note = "") {
  return request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId, note } });
}

const htmlFile = (name, body = "<p>Alpha</p><p>Beta</p>") => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `<!DOCTYPE html>\n<html><head></head><body>${body}</body></html>\n`);
  return file;
};

test("closing the tab ends the review and releases the waiting poll with the unsent counts", async (t) => {
  const file = htmlFile("close.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const browser = await tab(port, opened.sessionId);
  await comment(port, token, opened.key, "Alpha", "Left behind");
  await edit(port, token, opened.key, { label: "p", before: "Beta", after: "Gamma" });

  const waiting = poll(port, token, file);
  await sleep(50);
  assert.equal(waiting.settled, false);

  // pagehide: the tab says it is leaving, then the connection drops.
  await request(port, token, { method: "POST", route: `/api/session/${opened.sessionId}/away` });
  browser.close();
  const answer = await waiting.promise;
  assert.equal(answer.status, "closed");
  assert.equal(answer.reason, "window_closed");
  assert.deepEqual(answer.unsent, { comments: 1, edits: 1 });
  assert.match(answer.next_step, /do not run the poll command again/);
  assert.match(answer.next_step, /2 unsent items/);

  const gone = await request(port, token, { route: `/api/session/${opened.sessionId}/page` });
  assert.equal(gone.status, 404, "the session is forgotten");
  const page = j(await request(port, token, { route: `/api/page/${opened.key}` }));
  assert.equal(page.comments.length, 1, "unsent feedback is kept for the next open");
});

test("a reload comes back inside the grace and nothing ends", async (t) => {
  const file = htmlFile("reload.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const first = await tab(port, opened.sessionId);
  const waiting = poll(port, token, file);
  await sleep(30);

  await request(port, token, { method: "POST", route: `/api/session/${opened.sessionId}/away` });
  first.close();
  const second = await tab(port, opened.sessionId);
  await sleep(300);
  assert.equal(waiting.settled, false, "the poll is still waiting after the grace");
  second.close();
  waiting.req.destroy();
});

test("a poll with no review open closes after a short grace, unless one opens", async (t) => {
  const file = htmlFile("noreview.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const orphan = poll(port, token, file);
  const answer = await orphan.promise;
  assert.equal(answer.status, "closed");
  assert.equal(answer.reason, "no_review_open");

  const rescued = poll(port, token, file);
  await sleep(100);
  await open(port, token, file);
  await sleep(350);
  assert.equal(rescued.settled, false, "a review that opened inside the grace keeps the poll alive");
  rescued.req.destroy();
});

test("a newer poll for the same target supersedes the older one", async (t) => {
  const file = htmlFile("supersede.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const older = poll(port, token, file);
  await sleep(30);
  const newer = poll(port, token, file);
  const answer = await older.promise;
  assert.equal(answer.status, "superseded");
  await comment(port, token, opened.key, "Alpha", "Only once");
  await send(port, token, opened.key, opened.sessionId);
  const batch = await newer.promise;
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].comments[0].feedback, "Only once");
});

test("sending while the agent works queues only the new items and one ack clears both", async (t) => {
  const file = htmlFile("queue.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const first = await comment(port, token, opened.key, "Alpha", "First round");
  const waiting = poll(port, token, file);
  await sleep(30);
  await send(port, token, opened.key, opened.sessionId);
  const batch1 = await waiting.promise;
  assert.equal(batch1.pages[0].comments.length, 1);

  // The agent is applying batch 1 (no poll open). A second Send must not
  // say "nobody is listening", and must not re-ship the first comment.
  await sleep(15);
  await comment(port, token, opened.key, "Beta", "Second round");
  const again = await send(port, token, opened.key, opened.sessionId);
  assert.equal(again.status, 200, again.raw);
  const status = j(await request(port, token, { route: `/api/status?target=${encodeURIComponent(file)}` }));
  assert.equal(status.feedback_waiting, true);

  // poll --ack: acks batch 1, delivers batch 2 with only the new comment.
  const batch2 = await poll(port, token, file, { ack: true }).promise;
  assert.equal(batch2.status, "feedback");
  assert.deepEqual(batch2.pages[0].comments.map((c) => c.feedback), ["Second round"]);
  let page = j(await request(port, token, { route: `/api/page/${opened.key}` }));
  assert.deepEqual(page.comments.map((c) => c.feedback), ["Second round"], "the first batch's comment is cleared by that ack");
  assert.ok(!page.comments.some((c) => c.id === first.comment.id));

  const done = poll(port, token, file, { ack: true });
  await sleep(50);
  page = j(await request(port, token, { route: `/api/page/${opened.key}` }));
  assert.deepEqual(page.comments, [], "the second ack clears the second batch");
  done.req.destroy();
});

test("delivery survives a server restart so the ack is honored instead of re-shipping", async (t) => {
  const file = htmlFile("restart.html");
  const target = file;
  let server = await start(0);
  const opened = await open(server.port, server.token, file);
  await comment(server.port, server.token, opened.key, "Alpha", "Once only");
  await send(server.port, server.token, opened.key, opened.sessionId);
  const delivered = await poll(server.port, server.token, target).promise;
  assert.equal(delivered.status, "feedback");
  server.dispose();
  await sleep(50);

  server = await start(0);
  t.after(() => server.dispose());
  const after = poll(server.port, server.token, target, { ack: true });
  await sleep(100);
  assert.equal(after.settled, false, "the ack cleared the batch instead of delivering it again");
  const page = j(await request(server.port, server.token, { route: `/api/page/${opened.key}` }));
  assert.deepEqual(page.comments, []);
  after.req.destroy();
});

test("edit text is cut with an explicit marker instead of silently at 4k", async (t) => {
  const file = htmlFile("long.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const long = "x".repeat(6000);
  const page = await edit(port, token, opened.key, { label: "p", before: "Alpha", after: long, after_html: `<p>${long}</p>` });
  assert.equal(page.page.edits[0].after, long, "6k is well under the cap");
  const huge = "y".repeat(250000);
  const cut = await edit(port, token, opened.key, { label: "p 2", before: "Beta", after: huge });
  const row = cut.page.edits.find((e) => e.label === "p 2");
  assert.equal(row.truncated, true);
  assert.match(row.after, /…\[truncated by human-review\]$/);
  await send(port, token, opened.key, opened.sessionId);
  const batch = await poll(port, token, file).promise;
  assert.equal(batch.pages[0].edits.find((e) => e.label === "p 2").truncated, true);
  assert.match(batch.next_step, /truncated/);
});

test("an external write keeps unsent edit rows on a Markdown page and drops them on an HTML file", async (t) => {
  const md = path.join(tmp, "notes.md");
  fs.writeFileSync(md, "# Notes\n\nFirst.\n");
  const html = htmlFile("external.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const mdPage = await open(port, token, md);
  const htmlPage = await open(port, token, html);
  await edit(port, token, mdPage.key, { label: "Notes · p", before: "First.", after: "Second." });
  await edit(port, token, htmlPage.key, { label: "p", before: "Alpha", after: "Omega" });
  await sleep(50);
  fs.writeFileSync(md, "# Notes\n\nFirst, formatted by an editor.\n");
  fs.writeFileSync(html, "<!DOCTYPE html>\n<html><head></head><body><p>Rewritten by the agent</p></body></html>\n");
  // fs.watchFile polls every 400ms.
  await sleep(1300);
  const mdState = j(await request(port, token, { route: `/api/page/${mdPage.key}` }));
  assert.equal(mdState.edits.length, 1, "Markdown edits are unsent feedback and survive");
  const htmlState = j(await request(port, token, { route: `/api/page/${htmlPage.key}` }));
  assert.equal(htmlState.edits.length, 0, "HTML edits were in the file the agent replaced");
});

test("undo removes the edit row; discard clears leftover feedback", async (t) => {
  const file = htmlFile("undo.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  await request(port, token, { method: "POST", route: `/api/page/${opened.key}/edit`, body: { label: "p", kind: "deleted", before: "Alpha", after: "" } });
  await edit(port, token, opened.key, { label: "p 2", before: "Beta", after: "Gamma" });
  let page = j(await request(port, token, { method: "DELETE", route: `/api/page/${opened.key}/edit`, body: { label: "p", kind: "deleted" } })).page;
  assert.deepEqual(page.edits.map((e) => e.label), ["p 2"]);
  await comment(port, token, opened.key, "Beta", "Old thought");

  // A later open reports what was left behind, and discard wipes it — and on
  // an HTML file, whose edits were autosaved, restores the agent's version.
  // The browser autosaves through the save route, so the file changes while
  // the agent's version stays the revert target.
  const raw = j(await request(port, token, { route: `/api/page/${opened.key}/raw` }));
  await request(port, token, {
    method: "POST",
    route: `/api/page/${opened.key}/save`,
    body: { html: "<!DOCTYPE html>\n<html><head></head><body><p>Gamma</p></body></html>\n", baseHash: raw.hash },
  });
  assert.match(fs.readFileSync(file, "utf8"), /Gamma/);
  const reopened = await open(port, token, file);
  assert.deepEqual(reopened.leftover, { comments: 1, edits: 1 });
  const discarded = j(await request(port, token, { method: "POST", route: `/api/page/${opened.key}/discard` }));
  page = discarded.page;
  assert.deepEqual(page.comments, []);
  assert.deepEqual(page.edits, []);
  assert.equal(discarded.reverted, true);
  assert.match(fs.readFileSync(file, "utf8"), /<p>Alpha<\/p>/, "the file is back to the agent's version");
  const fresh = await open(port, token, file);
  assert.deepEqual(fresh.leftover, { comments: 0, edits: 0 });
});

test("rewording a comment updates a waiting batch in place and takes a new id after delivery", async (t) => {
  const file = htmlFile("reword.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const added = await comment(port, token, opened.key, "Alpha", "Delete this");
  await send(port, token, opened.key, opened.sessionId);
  const pending = j(await request(port, token, { method: "PATCH", route: `/api/page/${opened.key}/comment/${added.comment.id}`, body: { feedback: "Shorten this" } }));
  assert.equal(pending.delivery, "updated-pending");
  const batch = await poll(port, token, file).promise;
  assert.equal(batch.pages[0].comments[0].feedback, "Shorten this");

  const after = j(await request(port, token, { method: "PATCH", route: `/api/page/${opened.key}/comment/${added.comment.id}`, body: { feedback: "Keep it, add an example" } }));
  assert.equal(after.delivery, "resend");
  assert.notEqual(after.page.comments[0].id, added.comment.id, "the delivered id is retired so the ack cannot clear the rewrite");
  assert.equal(typeof after.page.comments[0].updatedAt, "number");
  const acked = poll(port, token, file, { ack: true });
  await sleep(50);
  const page = j(await request(port, token, { route: `/api/page/${opened.key}` }));
  assert.deepEqual(page.comments.map((c) => c.feedback), ["Keep it, add an example"]);
  acked.req.destroy();
});

test("a formatting-only edit is flagged, and saved pages say their edits need no action", async (t) => {
  const file = htmlFile("bold.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  await edit(port, token, opened.key, {
    label: "p",
    before: "Alpha",
    after: "Alpha",
    before_html: "<p>Alpha</p>",
    after_html: "<p><b>Alpha</b></p>",
  });
  await edit(port, token, opened.key, { label: "p 2", before: "Beta", after: "Gamma", before_html: "<p>Beta</p>", after_html: "<p>Gamma</p>" });
  await send(port, token, opened.key, opened.sessionId);
  const batch = await poll(port, token, file).promise;
  const [bold, reworded] = batch.pages[0].edits;
  assert.equal(bold.formatting_only, true);
  assert.equal(bold.after_html, "<p><b>Alpha</b></p>");
  assert.equal(reworded.formatting_only, undefined);
  assert.match(batch.next_step, /formatting_only: true.*never write `after` back as plain text/);
  assert.match(batch.next_step, /edits_saved: true.*need no action/);
});

test("a self-rendering page reports edits_saved: false", async (t) => {
  const file = htmlFile("dynamic.html");
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  await request(port, token, { method: "POST", route: `/api/page/${opened.key}/mode`, body: { dynamic: true } });
  await edit(port, token, opened.key, { label: "p", before: "Alpha", after: "Rendered" });
  await send(port, token, opened.key, opened.sessionId);
  const batch = await poll(port, token, file).promise;
  assert.equal(batch.pages[0].edits_saved, false);
  assert.doesNotMatch(batch.next_step, /edits_saved: true/);
});

test("the artifact route needs the per-run secret, and a localhost app's own requests are proxied", async (t) => {
  const app = http.createServer((req, res) => {
    if (req.url === "/wiki") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end('<!doctype html><html><body><img srcset="/a.png 1x, /b.png 2x"><p>Hi</p></body></html>');
    }
    if (req.url === "/api/hello?x=1" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "app=1", "x-frame-options": "DENY" });
        res.end(JSON.stringify({ hello: "from the app", got: body, host: req.headers.host }));
      });
      return undefined;
    }
    res.writeHead(200, { "content-type": "text/css" });
    return res.end(`/* ${req.url} */`);
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const target = `http://localhost:${app.address().port}/wiki`;

  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, target);

  const noSecret = await request(port, "", { route: `/artifact/${opened.key}/index.html` });
  assert.equal(noSecret.status, 404);
  const page = await request(port, "", { route: `/artifact/${opened.artifactToken}/${opened.key}/index.html` });
  assert.equal(page.status, 200);
  assert.match(page.raw, new RegExp(`srcset="http://localhost:${app.address().port}/a.png 1x, http://localhost:${app.address().port}/b.png 2x"`));
  assert.match(String(page.headers["set-cookie"]), /__hr_page=/);

  const css = await request(port, "", { route: `/artifact/${opened.artifactToken}/${opened.key}/_next/wiki.css` });
  assert.equal(css.status, 200);
  assert.equal(css.raw, "/* /_next/wiki.css */");

  const proxied = await request(port, "", {
    method: "POST",
    route: "/api/hello?x=1",
    headers: { cookie: `__hr_page=${opened.key}`, "content-type": "text/plain" },
    body: { ping: true },
  });
  assert.equal(proxied.status, 200, proxied.raw);
  const answer = j(proxied);
  assert.equal(answer.hello, "from the app");
  assert.equal(answer.got, JSON.stringify({ ping: true }));
  assert.equal(answer.host, `localhost:${app.address().port}`);
  assert.equal(proxied.headers["set-cookie"], undefined, "app cookies do not land on the review origin");
  assert.equal(proxied.headers["x-frame-options"], undefined);

  // With the token it is our API, not the app's.
  const ours = await request(port, token, { route: "/api/hello?x=1", headers: { cookie: `__hr_page=${opened.key}` } });
  assert.equal(ours.status, 404);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
