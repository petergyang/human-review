import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installSkills, invocation, isTransientBin } from "../src/setup.js";

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

test("a bin that exists only for one command or one project is not an install", () => {
  // npx: the package is on PATH for the length of the setup command only.
  assert.equal(isTransientBin("/Users/x/.npm/_npx/f043fcd613c7efad/node_modules/.bin/human-review"), true);
  assert.equal(isTransientBin("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\a1b2\\node_modules\\.bin\\human-review.cmd"), true);

  // pnpm dlx, yarn dlx, bunx, and a plain project-local dependency: durable on
  // disk, but only resolvable from inside one project.
  assert.equal(isTransientBin("/Users/x/project/node_modules/.bin/human-review"), true);
  assert.equal(isTransientBin("/Users/x/.cache/bun/node_modules/.bin/human-review"), true);

  // Durable installs must still win.
  assert.equal(isTransientBin("/opt/homebrew/bin/human-review"), false);
  assert.equal(isTransientBin("/usr/local/bin/human-review"), false);
  assert.equal(isTransientBin("/Users/x/.volta/bin/human-review"), false);

  // Both markers count only as whole path segments.
  assert.equal(isTransientBin("/Users/x/my_npx_tools/bin/human-review"), false);
  assert.equal(isTransientBin("/Users/x/node_modules_backup/bin/human-review"), false);
});

test("invocation prefers npx when the only bin on PATH is transient", () => {
  const probe = (bin) => (_probe, _args) => ({ status: bin ? 0 : 1, stdout: bin ? `${bin}\n` : "" });
  assert.equal(invocation(probe("/Users/x/.npm/_npx/deadbeef/node_modules/.bin/human-review")), "npx -y human-review");
  assert.equal(invocation(probe("/Users/x/project/node_modules/.bin/human-review")), "npx -y human-review");
  assert.equal(invocation(probe("/Users/x/.local/bin/human-review")), "human-review");
  assert.equal(invocation(probe("")), "npx -y human-review");
});

test("the CLI lookup hides its child process window", () => {
  let options;
  invocation((_probe, _args, receivedOptions) => {
    options = receivedOptions;
    return { status: 1, stdout: "" };
  });

  assert.equal(options?.windowsHide, true);
});
