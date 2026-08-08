import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";

import { createServer } from "../src/server.js";

test("a review keeps the CLI invocation resolved when its server starts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-command-"));
  const originalPath = process.env.PATH;
  const originalStateDir = process.env.HUMAN_REVIEW_STATE_DIR;
  const bin = path.join(tmp, "bin");
  const state = path.join(tmp, "state");
  const file = path.join(tmp, "review.html");
  const locatorPath = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32") : "/usr/bin:/bin";

  fs.mkdirSync(bin);
  fs.writeFileSync(file, "<p>Review me</p>");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "human-review.cmd"), "@exit /b 0\r\n");
  } else {
    const command = path.join(bin, "human-review");
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(command, 0o755);
  }

  process.env.HUMAN_REVIEW_STATE_DIR = state;
  process.env.PATH = `${bin}${path.delimiter}${locatorPath}`;
  const review = createServer();
  review.server.listen(0, "127.0.0.1");
  await once(review.server, "listening");

  try {
    process.env.PATH = locatorPath;
    const port = review.server.address().port;
    const headers = { "x-human-review-token": review.token, "content-type": "application/json" };
    const opened = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ file }),
    }).then((response) => response.json());
    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/session/${opened.sessionId}/page`, { headers }).then((response) =>
      response.json(),
    );

    assert.match(stateResponse.page.pollCommand, /^human-review poll /);
  } finally {
    const closed = once(review.server, "close");
    review.dispose();
    await closed;
    process.env.PATH = originalPath;
    if (originalStateDir === undefined) delete process.env.HUMAN_REVIEW_STATE_DIR;
    else process.env.HUMAN_REVIEW_STATE_DIR = originalStateDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
