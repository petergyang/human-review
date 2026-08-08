import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Teach agents the command that will actually work here. A global install or
 * `npm link` puts `human-review` on PATH; otherwise fall back to npx, which only
 * resolves once the package is published.
 *
 * The probe has to discount its own npx run. `npx -y human-review setup --global`
 * puts this package on PATH for the duration of that one command, out of npm's
 * `_npx` cache, so a naive `which` succeeds and setup writes a bare
 * `human-review` into SKILL.md. That binary is gone the moment npx exits, and
 * every later agent invocation dies with "command not found".
 */
export function invocation(run = spawnSync) {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = run(probe, ["human-review"], { encoding: "utf8", windowsHide: true });
  const resolved = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0].trim() : "";
  return resolved && !isNpxCachePath(resolved) ? "human-review" : "npx -y human-review";
}

/** True for a binary npm placed in its transient `_npx` cache for one command. */
export function isNpxCachePath(binPath) {
  return binPath.split(/[\\/]/).includes("_npx");
}

/**
 * Quote a path for copy-paste into any shell. JSON.stringify would double
 * Windows backslashes; plain double quotes work in bash, zsh, cmd and
 * PowerShell alike, and paths cannot legally contain a double quote on Windows.
 */
export function shellQuote(arg) {
  const text = String(arg);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

/** The skill lives in its own markdown file so nothing needs escaping. */
export const readSkill = () => fs.readFileSync(path.join(here, "SKILL.md"), "utf8");

export const skillFor = (cmd) => readSkill().replaceAll("npx -y human-review", cmd);

const CODEX_BLOCK = `
## Reviewing files and localhost pages with human-review

After writing an HTML or Markdown file the user will read, open it for them with
\`npx -y human-review <file.html>\`. For a locally running web page, open the real
route with \`npx -y human-review http://localhost:3000/path\` instead of recreating
it as a static file. Then block on
\`npx -y human-review poll <target> --timeout 600\` until they send feedback.
If it prints \`{"status":"timeout"}\`, no feedback arrived yet — run the same
poll command again to keep waiting. When a \`{"status":"feedback"}\` batch
arrives, apply it, then poll again with \`--ack\`.

Keep the poll command in the foreground and do not end the turn while it waits.
If the shell returns a process or session handle, keep waiting on that handle until
the command exits. \`npx -y human-review status <target>\` reports instantly
whether feedback is already waiting, without blocking.

The batch groups feedback by page under \`pages\`, so fix every page listed. Items
under \`edits\` are changes the user already made: \`after\` is their exact wording,
so carry it across verbatim and never revert it — and if the HTML was generated
from MDX or Markdown, apply it to the source too. Markdown files open rendered
and are never written by human-review: apply their comments and edits to the
Markdown source, keeping its syntax. There is no reply channel; the user sees
your work when the page reloads. For a localhost page, direct edits and deletions
arrive with \`kind: "url"\`; find and update the matching MDX, TSX, template, or
component source. Never write the rendered HTTP response over project source.
`;

export function installSkills(cwd, { global: isGlobal = false, home = os.homedir() } = {}) {
  const done = [];
  const cmd = invocation();

  const skillRoots = isGlobal
    ? [
        ["Claude Code", path.join(home, ".claude")],
        ["Codex", path.join(home, ".codex")],
        ["Shared agents", path.join(home, ".agents")],
      ]
    : [["Claude Code", path.join(cwd, ".claude")]];

  for (const [agent, base] of skillRoots) {
    const skillFile = path.join(base, "skills", "human-review", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, skillFor(cmd));
    done.push(`${agent} skill  ${skillFile}${isGlobal ? "   (all projects)" : ""}`);
  }

  if (!isGlobal) {
    const agents = path.join(cwd, "AGENTS.md");
    const existing = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
    if (existing.includes("human-review")) {
      done.push("AGENTS.md already mentions human-review — left it alone");
    } else {
      const block = CODEX_BLOCK.replaceAll("npx -y human-review", cmd);
      fs.writeFileSync(agents, existing ? `${existing.trimEnd()}\n${block}` : block.trimStart());
      done.push(`${existing ? "Updated" : "Created"} AGENTS.md   (Codex)`);
    }
  }

  done.push("", `Agents will be told to run: ${cmd}`);
  if (cmd.startsWith("npx")) {
    done.push("Heads up: npx only works once human-review is published. Run `npm link` in the");
    done.push("human-review folder first if you want to use it locally, then re-run setup.");
  }
  done.push("Any other agent works too — see the JSON contract in the README.");
  return done;
}
