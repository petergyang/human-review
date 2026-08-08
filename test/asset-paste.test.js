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
