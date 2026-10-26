import fs from "node:fs";
import path from "node:path";
import { buildContext, findQuote, tidy } from "./anchor-text.js";
import { renderedText } from "./page-text.js";
import { invocation } from "./setup.js";
import { adoptThread, combinedThreads, fixThreads, mergeDriver, setupGit } from "./thread-git.js";
import {
  agentWork,
  createThread,
  humanAuthor,
  listThreads,
  PALETTE,
  readProfile,
  replyToThread,
  setThreadStatus,
  threadDir,
  writeProfile,
} from "./threads.js";

/**
 * Shared-thread commands. They read and write the `.review` folder beside the
 * file directly, so they work with or without a review open in a browser; an
 * open review notices the change within a couple of seconds.
 */

export const THREAD_HELP = `
Shared review threads (stored beside the file in <file>.review/, meant to be committed):
  human-review threads <file>         List open threads and accepted suggestions, this branch and fetched ones
      --all                        Include resolved, rejected, and applied threads
      --for-agent                  Only this branch's threads waiting on an agent
      --local                      Only this branch, without other branches' threads
      --json                       Print the threads as JSON
  human-review text <file>            Print the rendered text that thread quotes must match
  human-review comment <file> --quote <text> --body <message> [--ask-agent]
  human-review suggest <file> --quote <text> --replacement <text> [--body <why>] [--ask-agent]
  human-review reply <file> <thread-id> --body <message>
  human-review resolve|reopen|accept|reject|applied <file> <thread-id> [--body <note>]
      --prefix/--suffix <text>     Text just before/after the quote, when it appears more than once
      --agent <name> [--model <id>]  Write as an agent (default: you, from your profile or git config user.name)
      --as <name>                  Write as a named person
      --color <#rrggbb>            Highlight colour for what you write (default: your profile's, or one picked from the name)
  human-review profile [--name <name>] [--color <#rrggbb>]  Show or set your reviewer name and colour

Working across branches and pull requests:
  human-review setup --git            Merge shared threads instead of conflicting (run once per clone)
  human-review fix-threads [<path>]   Repair thread files git left with conflict markers
`;

export const THREAD_COMMANDS = new Set(["merge-thread", "fix-threads", "profile", "threads", "text", "comment", "suggest", "reply", "resolve", "reopen", "accept", "reject", "applied"]);

const STATUS_VERBS = { resolve: "resolved", reopen: "open", accept: "accepted", reject: "rejected", applied: "applied" };

const VALUE_FLAGS = new Set(["--quote", "--prefix", "--suffix", "--body", "--replacement", "--agent", "--model", "--as", "--color", "--name"]);

function parse(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && arg.startsWith("--") ? arg.slice(eq + 1) : rest[(i += 1)];
      if (value === undefined) throw new Error(`${name} needs a value`);
      flags[name.slice(2)] = value;
    } else if (arg.startsWith("--")) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function reviewedFile(input) {
  if (!input) throw new Error("Name the reviewed file, e.g. human-review threads paper.tex");
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`No such file: ${input}`);
  return fs.realpathSync(resolved);
}

function author(flags, file) {
  const color = flags.color ? checkColor(flags.color) : undefined;
  if (flags.agent) return { name: String(flags.agent), type: "agent", ...(flags.model ? { model: String(flags.model) } : {}), ...(color ? { color } : {}) };
  if (flags.as) return { name: String(flags.as), type: "human", ...(color ? { color } : {}) };
  const me = humanAuthor(file);
  return color ? { ...me, color } : me;
}

function checkColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(String(color))) throw new Error(`--color wants a hex colour like ${PALETTE[0]}`);
  return String(color).toLowerCase();
}

/** Pin the quote to the rendered page, so the browser can highlight it. */
async function anchorFor(file, flags) {
  const quote = String(flags.quote || "");
  if (!quote.trim()) throw new Error("--quote is required: the exact text, as the rendered page shows it");
  const text = await renderedText(file);
  const hit = findQuote(text, { quote, prefix: String(flags.prefix || ""), suffix: String(flags.suffix || "") });
  if (!hit) {
    throw new Error(
      `That quote is not in the rendered text of ${path.basename(file)}. Quote what the page shows, not the source ` +
        `markup (macros, citations, and math render differently). See it with: human-review text ${path.basename(file)}`
    );
  }
  if (!hit.exact) process.stderr.write("Note: the quote matched only loosely (whitespace or repeats); add --prefix or --suffix to pin it.\n");
  return buildContext(text, hit.start, hit.end);
}

const who = (a) => (a.type === "agent" ? `${a.name} (agent${a.model ? `, ${a.model}` : ""})` : a.name);

function describe(thread) {
  const where = thread.elsewhere ? ` · only on ${thread.branches.join(", ")}` : thread.updates_elsewhere ? ` · updates on ${thread.branches.join(", ")}` : "";
  const lines = [`${thread.id}  ${thread.kind} · ${thread.status}${thread.conflict ? " · CONFLICT" : ""}${thread.ask_agent ? " · ask agent" : ""} · ${who(thread.author)}${where}`];
  if (thread.conflict) lines.push(`  branches disagree: ${thread.conflict.outcomes.map((o) => `${o.by ? o.by.name : "someone"} -> ${o.status}`).join(" vs ")}`);
  lines.push(`  "${tidy(thread.anchor.quote, 160)}"`);
  if (thread.kind === "suggestion") lines.push(`  -> "${tidy(thread.replacement, 160)}"`);
  for (const m of thread.messages) lines.push(`  ${who(m.author)}: ${tidy(m.body, 400)}`);
  return lines.join("\n");
}

const print = (thread) => process.stdout.write(`${JSON.stringify(thread, null, 2)}\n`);

export async function runThreadCommand(argv) {
  const [command, ...rest] = argv;

  // git's merge driver: base, ours, theirs. Exit 1 hands the file back to git as a conflict.
  if (command === "merge-thread") {
    const [base, ours, theirs] = rest;
    if (!mergeDriver(base, ours, theirs)) process.exit(1);
    return;
  }

  const { flags, positional } = parse(rest);

  if (command === "fix-threads") {
    const results = fixThreads(positional[0] || process.cwd());
    if (flags.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    else if (!results.length) process.stdout.write("No thread files with conflict markers.\n");
    else {
      for (const r of results) {
        const where = path.relative(process.cwd(), r.file) || r.file;
        process.stdout.write(`${r.fixed ? (r.conflict ? "merged, decision needed" : "merged") : `left as is (${r.reason})`}  ${where}\n`);
      }
    }
    if (results.some((r) => !r.fixed)) process.exitCode = 1;
    return;
  }

  if (command === "profile") {
    let profile = readProfile();
    if (flags.name !== undefined || flags.color !== undefined) {
      profile = writeProfile({
        name: flags.name !== undefined ? String(flags.name) : profile.name,
        color: flags.color !== undefined ? checkColor(flags.color) : profile.color,
      });
    }
    process.stdout.write(`${JSON.stringify({ ...profile, palette: PALETTE }, null, 2)}\n`);
    return;
  }

  const file = reviewedFile(positional[0]);

  if (command === "text") {
    process.stdout.write(`${(await renderedText(file)).replace(/\n{3,}/g, "\n\n").trim()}\n`);
    return;
  }

  if (command === "threads") {
    let threads = flags.local || flags["for-agent"] ? listThreads(file) : combinedThreads(file);
    if (flags["for-agent"]) threads = agentWork(threads);
    else if (!flags.all) threads = threads.filter((t) => t.status === "open" || t.status === "accepted");
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(threads, null, 2)}\n`);
      return;
    }
    if (!threads.length) {
      process.stdout.write(`No ${flags.all ? "" : "open "}threads in ${path.relative(process.cwd(), threadDir(file)) || threadDir(file)}\n`);
      return;
    }
    process.stdout.write(`${threads.map(describe).join("\n\n")}\n`);
    return;
  }

  const me = author(flags, file);
  const ask = !!flags["ask-agent"];

  if (command === "comment") {
    print(createThread(file, { kind: "comment", anchor: await anchorFor(file, flags), body: flags.body, author: me, askAgent: ask }));
    return;
  }
  if (command === "suggest") {
    if (typeof flags.replacement !== "string") throw new Error("--replacement is required: the text that should replace the quote");
    print(createThread(file, { kind: "suggestion", anchor: await anchorFor(file, flags), replacement: flags.replacement, body: flags.body, author: me, askAgent: ask }));
    return;
  }

  const id = positional[1];
  if (!id) throw new Error(`Usage: human-review ${command} <file> <thread-id>`);
  // Answering a thread from another branch brings it onto this one first.
  adoptThread(file, id);
  if (command === "reply") {
    print(replyToThread(file, id, { body: flags.body, author: me }));
    return;
  }
  print(setThreadStatus(file, id, STATUS_VERBS[command], { author: me, note: flags.body }));
}
