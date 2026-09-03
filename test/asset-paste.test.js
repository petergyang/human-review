import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-paste-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");

function request(port, { method = "GET", route = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, raw }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

test("pasted images land in assets/ next to the reviewed file", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const file = path.join(tmp, "My Spec.html");
  fs.writeFileSync(file, "<!doctype html><html><body><p>Hi</p></body></html>");
  const opened = JSON.parse(
    (
      await request(port, {
        method: "POST",
        route: "/api/session",
        headers: { "x-human-review-token": token, "content-type": "application/json" },
        body: JSON.stringify({ file }),
      })
    ).raw
  );
  const key = JSON.parse(
    (
      await request(port, {
        route: `/api/session/${opened.sessionId}/page`,
        headers: { "x-human-review-token": token },
      })
    ).raw
  ).page.key;

  await t.test("a png is written and its relative src returned", async () => {
    const res = await request(port, {
      method: "POST",
      route: `/api/page/${key}/asset?type=${encodeURIComponent("image/png")}`,
      headers: { "x-human-review-token": token, "content-type": "application/octet-stream" },
      body: PNG,
    });
    assert.equal(res.status, 200);
    const { src } = JSON.parse(res.raw);
    assert.equal(src, "assets/My-Spec-paste-1.png");
    const written = fs.readFileSync(path.join(tmp, "assets", "My-Spec-paste-1.png"));
    assert.deepEqual(written, PNG);
  });

  await t.test("a second paste never overwrites the first", async () => {
    const res = await request(port, {
      method: "POST",
      route: `/api/page/${key}/asset?type=${encodeURIComponent("image/png")}`,
      headers: { "x-human-review-token": token, "content-type": "application/octet-stream" },
      body: PNG,
    });
    assert.equal(JSON.parse(res.raw).src, "assets/My-Spec-paste-2.png");
  });

  await t.test("non-image types are refused", async () => {
    const res = await request(port, {
      method: "POST",
      route: `/api/page/${key}/asset?type=${encodeURIComponent("image/svg+xml")}`,
      headers: { "x-human-review-token": token, "content-type": "application/octet-stream" },
      body: Buffer.from("<svg onload=alert(1)></svg>"),
    });
    assert.equal(res.status, 400);
  });

  await t.test("a moved edit keeps its landing-spot fields through the API", async () => {
    const res = await request(port, {
      method: "POST",
      route: `/api/page/${key}/edit`,
      headers: { "x-human-review-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        label: "Hi block",
        kind: "moved",
        before: "Hi",
        after: "Hi",
        moved_after: "Intro paragraph",
        moved_before: "Closing paragraph",
      }),
    });
    assert.equal(res.status, 200);
    const row = JSON.parse(res.raw).page.edits.find((e) => e.kind === "moved");
    assert.equal(row.moved_after, "Intro paragraph");
    assert.equal(row.moved_before, "Closing paragraph");
  });
});

test("localhost image pastes are staged, previewed, and delivered to the agent", async (t) => {
  const app = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><p data-block="Intro">Hello</p></body></html>');
  });
  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => app.close());

  const review = await start();
  t.after(() => review.dispose());
  const target = `http://localhost:${app.address().port}/wiki`;
  const opened = JSON.parse(
    (
      await request(review.port, {
        method: "POST",
        route: "/api/session",
        headers: { "x-human-review-token": review.token, "content-type": "application/json" },
        body: JSON.stringify({ target }),
      })
    ).raw
  );

  const pasted = await request(review.port, {
    method: "POST",
    route: `/api/page/${opened.key}/asset?type=${encodeURIComponent("image/png")}`,
    headers: { "x-human-review-token": review.token, "content-type": "application/octet-stream" },
    body: PNG,
  });
  assert.equal(pasted.status, 200, pasted.raw);
  const asset = JSON.parse(pasted.raw);
  assert.equal(asset.src, `/artifact/${opened.artifactToken}/${opened.key}/__human_review_paste__/localhost-paste-1.png`);
  assert.equal(asset.stagedId, "localhost-paste-1.png");
  const stagedPath = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "pasted", opened.key, asset.stagedId);
  assert.deepEqual(fs.readFileSync(stagedPath), PNG);

  const preview = await request(review.port, { route: asset.src });
  assert.equal(preview.status, 200);

  const afterHtml = `<p data-block="Intro">Hello<img src="${asset.src}"></p>`;
  await request(review.port, {
    method: "POST",
    route: `/api/page/${opened.key}/edit`,
    headers: { "x-human-review-token": review.token, "content-type": "application/json" },
    body: JSON.stringify({
      label: "Intro",
      kind: "edited",
      before: "Hello",
      after: "Hello",
      after_html: afterHtml,
      staged_assets: [{ id: asset.stagedId, preview_src: asset.src }],
    }),
  });
  await request(review.port, {
    method: "POST",
    route: `/api/page/${opened.key}/send`,
    headers: { "x-human-review-token": review.token, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: opened.sessionId, note: "" }),
  });

  const polled = await request(review.port, {
    route: `/api/poll?target=${encodeURIComponent(target)}`,
    headers: { "x-human-review-token": review.token },
  });
  const edit = JSON.parse(polled.raw).pages[0].edits[0];
  assert.equal(edit.after_html, afterHtml);
  assert.deepEqual(edit.staged_assets, [{ path: stagedPath, preview_src: asset.src }]);

  const acknowledged = await fetch(
    `http://127.0.0.1:${review.port}/api/poll?target=${encodeURIComponent(target)}&ack=1`,
    { headers: { "x-human-review-token": review.token } }
  );
  await acknowledged.body.cancel();
  assert.equal(fs.existsSync(stagedPath), false, "the staged copy is removed after the agent acknowledges the batch");
});

test("server start sweeps staged pastes that no edit or batch still references", async (t) => {
  const app = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><p data-block="Intro">Hello</p></body></html>');
  });
  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => app.close());

  // Paste once so a staged file is referenced by a live edit, then plant
  // orphans beside it and under a key no page owns any more.
  const first = await start();
  const target = `http://localhost:${app.address().port}/wiki`;
  const opened = JSON.parse(
    (
      await request(first.port, {
        method: "POST",
        route: "/api/session",
        headers: { "x-human-review-token": first.token, "content-type": "application/json" },
        body: JSON.stringify({ target }),
      })
    ).raw
  );
  const asset = JSON.parse(
    (
      await request(first.port, {
        method: "POST",
        route: `/api/page/${opened.key}/asset?type=${encodeURIComponent("image/png")}`,
        headers: { "x-human-review-token": first.token, "content-type": "application/octet-stream" },
        body: PNG,
      })
    ).raw
  );
  await request(first.port, {
    method: "POST",
    route: `/api/page/${opened.key}/edit`,
    headers: { "x-human-review-token": first.token, "content-type": "application/json" },
    body: JSON.stringify({
      label: "Intro",
      kind: "edited",
      before: "Hello",
      after: "Hello",
      after_html: `<p data-block="Intro">Hello<img src="${asset.src}"></p>`,
      staged_assets: [{ id: asset.stagedId, preview_src: asset.src }],
    }),
  });
  await first.dispose();

  const stagedRoot = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "pasted");
  const kept = path.join(stagedRoot, opened.key, asset.stagedId);
  const orphanBeside = path.join(stagedRoot, opened.key, "localhost-paste-9.png");
  const orphanDir = path.join(stagedRoot, "no-such-page");
  fs.writeFileSync(orphanBeside, PNG);
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, "localhost-paste-1.png"), PNG);

  const second = await start();
  t.after(() => second.dispose());
  assert.equal(fs.existsSync(kept), true, "a staged file referenced by a live edit survives");
  assert.equal(fs.existsSync(orphanBeside), false, "an unreferenced file next to it is removed");
  assert.equal(fs.existsSync(orphanDir), false, "a staging folder for a forgotten page is removed");
});
