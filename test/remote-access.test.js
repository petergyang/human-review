import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-remote-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");

function request(port, { method = "GET", route = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
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

/** Open a review session for a tiny file and return { sessionId, key }. */
async function openSession(port, token) {
  const file = path.join(tmp, "page.html");
  fs.writeFileSync(file, "<!doctype html><html><body><p>Hi</p></body></html>");
  const res = await request(port, {
    method: "POST",
    route: "/api/session",
    headers: { "x-human-review-token": token },
    body: { file },
  });
  assert.equal(res.status, 200);
  return JSON.parse(res.raw); // { sessionId, key, path }
}

test("remote phone access via env-configurable hosts", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  await t.test("HUMAN_REVIEW_ALLOWED_HOSTS admits an extra Host header", async () => {
    process.env.HUMAN_REVIEW_ALLOWED_HOSTS = `allowed.example.com:${port}`;
    t.after(() => delete process.env.HUMAN_REVIEW_ALLOWED_HOSTS);

    const allowed = await request(port, { route: "/health", headers: { host: `allowed.example.com:${port}` } });
    assert.equal(allowed.status, 200);

    const stranger = await request(port, { route: "/health", headers: { host: `evil.example.com:${port}` } });
    assert.equal(stranger.status, 403);
  });

  await t.test("HUMAN_REVIEW_ARTIFACT_HOST is injected into the shell page", async () => {
    process.env.HUMAN_REVIEW_ARTIFACT_HOST = "artifact.example.com";
    t.after(() => delete process.env.HUMAN_REVIEW_ARTIFACT_HOST);

    const { path: sessionPath } = await openSession(port, token);
    const shell = await request(port, { route: sessionPath });
    assert.equal(shell.status, 200);
    assert.match(shell.raw, /data-artifact-host="artifact\.example\.com"/);
  });

  await t.test("HUMAN_REVIEW_CHROME_ORIGIN is injected into the artifact", async () => {
    process.env.HUMAN_REVIEW_CHROME_ORIGIN = "http://chrome.example.com:8124";
    t.after(() => delete process.env.HUMAN_REVIEW_CHROME_ORIGIN);

    const { key } = await openSession(port, token);
    const artifact = await request(port, { route: `/artifact/${key}/index.html` });
    assert.equal(artifact.status, 200);
    assert.match(artifact.raw, /data-chrome-origin="http:\/\/chrome\.example\.com:8124"/);
  });

  await t.test("loopback-only default still rejects every other host", async () => {
    delete process.env.HUMAN_REVIEW_ALLOWED_HOSTS;
    const stranger = await request(port, { route: "/health", headers: { host: `lan.example.com:${port}` } });
    assert.equal(stranger.status, 403);
  });
});
