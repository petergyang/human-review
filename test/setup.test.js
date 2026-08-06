import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installSkills, invocation, isNpxCachePath } from "../src/setup.js";

test("global setup installs the skill for Claude Code, Codex, and shared agents", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-setup-"));

  try {
    const result = installSkills(home, { global: true, home });
    for (const root of [".claude", ".codex", ".agents"]) {
      const skill = path.join(home, root, "skills", "human-review", "SKILL.md");
      assert.equal(fs.existsSync(skill), true);
      assert.match(fs.readFileSync(skill, "utf8"), /human-review poll/);
    }
    assert.match(result.join("\n"), /Claude Code skill/);
    assert.match(result.join("\n"), /Codex skill/);
    assert.match(result.join("\n"), /Shared agents skill/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a binary from npm's _npx cache does not count as installed on PATH", () => {
  // `npx -y human-review setup --global` resolves `which human-review` to the
  // transient cache copy, which disappears when npx exits. Writing a bare
  // `human-review` into SKILL.md on the strength of that leaves every later
  // agent run failing with "command not found".
  assert.equal(
    isNpxCachePath("/Users/x/.npm/_npx/f043fcd613c7efad/node_modules/.bin/human-review"),
    true,
  );
  assert.equal(
    isNpxCachePath("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\a1b2\\human-review.cmd"),
    true,
  );

  // A real global install or `npm link` must still win.
  assert.equal(isNpxCachePath("/opt/homebrew/bin/human-review"), false);
  assert.equal(isNpxCachePath("/usr/local/bin/human-review"), false);

  // `_npx` only counts as a path segment, never as a substring of one.
  assert.equal(isNpxCachePath("/Users/x/my_npx_tools/bin/human-review"), false);
});

test("the CLI lookup hides its child process window", () => {
  let options;
  invocation((_probe, _args, receivedOptions) => {
    options = receivedOptions;
    return { status: 1, stdout: "" };
  });

  assert.equal(options?.windowsHide, true);
});
