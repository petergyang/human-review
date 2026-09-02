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
 * The probe has to discount its own runner. `npx -y human-review setup --global`
 * puts this package on PATH for the length of that one command, and running
 * setup inside a project that depends on human-review puts that project's
 * `node_modules/.bin` there too. Either way a naive `which` succeeds and setup
 * writes a bare `human-review` into a SKILL.md that is meant to work from any
 * directory. The entry drops off PATH as soon as the runner exits, or stops
 * resolving as soon as the agent runs from somewhere else.
 */
export function invocation(run = spawnSync) {
  const probe = process.platform === "win32" ? "where" : "which";
  const found = run(probe, ["human-review"], { encoding: "utf8", windowsHide: true });
  const resolved = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0].trim() : "";
  return resolved && !isTransientBin(resolved) ? "human-review" : "npx -y human-review";
}

/**
 * True for a bin that exists only for one command or only inside one project.
 * Every transient channel routes through a `node_modules` directory: `npx`,
 * `pnpm dlx`, `yarn dlx`, `bunx`, and a plain project-local dependency. npm's
 * npx cache additionally sits under `_npx`, which is worth keeping as its own
 * check because npm may relocate the bin inside it. Durable installs resolve
 * through a bin directory with neither segment: `npm i -g`, `npm link`, volta,
 * nvm, asdf, and the pnpm and yarn globals.
 *
 * A durable path that happens to contain either segment degrades to the npx
 * form, which always works, so the failure direction here is cosmetic.
 */
export function isTransientBin(binPath) {
  const segments = binPath.split(/[\\/]/);
  return segments.includes("_npx") || segments.includes("node_modules");
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
it as a static file. Then start
\`npx -y human-review poll <target>\` in the background and end the turn: it
blocks until the user hits Send, prints the \`{"status":"feedback"}\` batch,
and exits, which wakes you. Do not add \`--timeout\` and do not poll on an
interval. Apply the batch, then start the next background poll with \`--ack\`.
\`{"status":"closed"}\` means the user ended the review; do not poll again.

Only if your harness cannot wake you when a background command exits, keep the
poll in the foreground (or wait on the process handle it returns) until it
exits. \`npx -y human-review status <target>\` reports instantly whether
feedback is already waiting, without blocking.

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
