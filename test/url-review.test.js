import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-url-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("a localhost route is visually editable and returns source-directed feedback", async (t) => {
  const app = http.createServer((req, res) => {
    if (req.url === "/redirect-away") {
      res.writeHead(302, { location: "https://example.com/wiki" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      '<!doctype html><html><head><link rel="stylesheet" href="/_next/wiki.css"></head>' +
        '<body><main><h1>Wiki</h1><p data-block="Intro">Original copy</p></main></body></html>'
    );
  });
  const appPort = await listen(app);
  t.after(async () => {
    app.close();
    await once(app, "close");
  });

  const review = await start();
  t.after(() => review.dispose());
  const target = `http://localhost:${appPort}/wiki`;

  const opened = await request(review.port, review.token, {
    method: "POST",
    route: "/api/session",
    body: { target },
  });
  assert.equal(opened.status, 200, opened.raw);
  const { key, sessionId, artifactToken } = JSON.parse(opened.raw);

  const state = await request(review.port, review.token, { route: `/api/page/${key}` });
  const page = JSON.parse(state.raw);
  assert.equal(page.kind, "url");
  assert.equal(page.url, target);
  assert.equal(page.file, target, "the legacy file field still names the reviewed target");
  assert.equal(page.feedbackOnly, true);
  assert.equal(page.canRevert, false);

  const artifact = await request(review.port, review.token, { route: `/artifact/${artifactToken}/${key}/index.html` });
  assert.equal(artifact.status, 200, artifact.raw);
  assert.match(artifact.raw, /<h1>Wiki<\/h1>/);
  assert.doesNotMatch(artifact.raw, /<base/);
  assert.match(artifact.raw, new RegExp(`href="http://localhost:${appPort}/_next/wiki\\.css"`));
  assert.match(artifact.raw, /<script data-eh-route>history\.replaceState\(null,"",location\.origin\+"\/wiki"\)<\/script>/);
  assert.match(artifact.raw, new RegExp(`src="http://127\\.0\\.0\\.1:${review.port}/sdk\\.js\\?key=${key}"`));

  const save = await request(review.port, review.token, {
    method: "POST",
    route: `/api/page/${key}/save`,
    body: { html: "<p>Do not write this response into Next.js</p>" },
  });
  assert.equal(save.status, 400);
  assert.match(JSON.parse(save.raw).error, /app source/);

  await request(review.port, review.token, {
    method: "POST",
    route: `/api/page/${key}/edit`,
    body: { label: "Intro", kind: "edited", before: "Original copy", after: "Clearer copy" },
  });
  await request(review.port, review.token, {
    method: "POST",
    route: `/api/page/${key}/edit`,
    body: { label: "Old card", kind: "deleted", before: "Old card", after: "" },
  });
  await request(review.port, review.token, {
    method: "POST",
    route: `/api/page/${key}/send`,
    body: { sessionId, note: "Keep the rest of the layout." },
  });

  const polled = await request(review.port, review.token, {
    route: `/api/poll?target=${encodeURIComponent(target)}`,
  });
  const batch = JSON.parse(polled.raw);
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].kind, "url");
  assert.equal(batch.pages[0].url, target);
  assert.equal(batch.pages[0].file, target);
  assert.deepEqual(
    batch.pages[0].edits.map(({ kind, after }) => [kind, after]),
    [
      ["edited", "Clearer copy"],
      ["deleted", ""],
    ]
  );
  assert.match(batch.next_step, /Find the matching project source/);

  const redirect = await request(review.port, review.token, {
    method: "POST",
    route: "/api/session",
    body: { target: `http://localhost:${appPort}/redirect-away` },
  });
  assert.equal(redirect.status, 500);
  assert.match(JSON.parse(redirect.raw).error, /limited to localhost/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
