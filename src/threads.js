import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "./state.js";
import { ensureStateDir, stateDir } from "./paths.js";

/**
 * Shared review threads: comments and suggested changes that co-authors and
 * agents can all see, answer, and resolve.
 *
 * They live next to the reviewed file, one JSON file per thread, in a folder
 * named after it (`paper.tex` -> `paper.tex.review/`). That folder is meant to
 * be committed: git carries the discussion between co-authors, two people
 * adding threads never touch the same file, and an agent can read and write
 * threads with no server running. The private comments and edits a reviewer
 * sends to their own agent stay in the state directory, as before.
 */

export const THREAD_FORMAT = "human-review/thread@1";
export const KINDS = ["comment", "suggestion"];
export const STATUSES = ["open", "resolved", "accepted", "rejected", "applied"];

const BODY_CAP = 20000;

export const threadDir = (file) => `${file}.review`;

const threadPath = (file, id) => path.join(threadDir(file), `${id}.json`);
const validId = (id) => /^t_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{6}$/.test(String(id || ""));
const now = () => new Date().toISOString();

/** Sortable by creation time, unique enough for many writers on many machines. */
export function newThreadId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `t_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

const newMessageId = () => `m_${crypto.randomBytes(4).toString("hex")}`;

// ------------------------------------------------------------------ authors

/** Highlight colours that stay readable as a tint on light and dark pages. */
export const PALETTE = ["#4682e6", "#3ca05a", "#8a5cd6", "#e08a1e", "#d6487e", "#1f9fa3", "#d04a3a", "#8a9a2a"];

const validColor = (color) => /^#[0-9a-f]{6}$/i.test(String(color || ""));

/** A stable colour per name, for authors who never picked one. */
export function colorFor(name) {
  const sum = crypto.createHash("sha1").update(String(name || "")).digest()[0];
  return PALETTE[sum % PALETTE.length];
}

const profilePath = () => path.join(stateDir(), "profile.json");

/**
 * The name and colour this reviewer chose. It lives in the state directory,
 * not in the browser: the review server's port changes between runs, and
 * browser storage is per port. The CLI reads it too, so a person signs the
 * same way from both.
 */
export function readProfile() {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(), "utf8"));
    return {
      name: String(raw.name || "").trim().slice(0, 120),
      color: validColor(raw.color) ? raw.color.toLowerCase() : "",
    };
  } catch {
    return { name: "", color: "" };
  }
}

export function writeProfile({ name = "", color = "" } = {}) {
  const profile = { name: String(name).trim().slice(0, 120), color: validColor(color) ? String(color).toLowerCase() : "" };
  ensureStateDir();
  atomicWrite(profilePath(), `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}

const gitNames = new Map();

function gitName(file) {
  const dir = path.dirname(path.resolve(file));
  if (!gitNames.has(dir)) {
    let name = "";
    try {
      const got = spawnSync("git", ["config", "user.name"], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 3000 });
      if (got.status === 0) name = got.stdout.trim();
    } catch {}
    if (!name) {
      try {
        name = os.userInfo().username;
      } catch {}
    }
    gitNames.set(dir, name || "Reviewer");
  }
  return gitNames.get(dir);
}

/** The person at this keyboard: their chosen profile, else their git name for the file's repository, else their login. */
export function humanAuthor(file) {
  const profile = readProfile();
  const name = profile.name || gitName(file);
  return { name, type: "human", color: profile.color || colorFor(name) };
}

/** Normalize an author record from a client; only the fields we know survive. */
export function cleanAuthor(author, fallback) {
  if (!author || typeof author !== "object" || !String(author.name || "").trim()) return fallback;
  const type = author.type === "agent" ? "agent" : "human";
  const out = { name: String(author.name).trim().slice(0, 120), type };
  if (type === "agent" && String(author.model || "").trim()) out.model = String(author.model).trim().slice(0, 120);
  out.color = validColor(author.color) ? String(author.color).toLowerCase() : colorFor(out.name);
  return out;
}

/** Threads written before colours existed still get one, the same on every machine. */
export function withColors(thread) {
  const paint = (a) => (a && !validColor(a.color) ? { ...a, color: colorFor(a.name) } : a);
  return {
    ...thread,
    author: paint(thread.author),
    messages: thread.messages.map((m) => ({ ...m, author: paint(m.author) })),
    history: (thread.history || []).map((h) => ({ ...h, by: paint(h.by) })),
  };
}

// ------------------------------------------------------------------ reading

function readThread(file, id) {
  try {
    const thread = JSON.parse(fs.readFileSync(threadPath(file, id), "utf8"));
    return thread && thread.format === THREAD_FORMAT && thread.id === id ? thread : null;
  } catch {
    return null;
  }
}

/** Every readable thread for a file, oldest first. A malformed file is skipped, never fatal. */
export function listThreads(file) {
  let names = [];
  try {
    names = fs.readdirSync(threadDir(file));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && validId(name.slice(0, -5)))
    .sort()
    .map((name) => readThread(file, name.slice(0, -5)))
    .filter(Boolean);
}

export function getThread(file, id) {
  return validId(id) ? readThread(file, id) : null;
}

/**
 * A cheap fingerprint of the thread folder, so a server can notice a
 * `git pull` or an agent's CLI write without reading every thread.
 */
export function threadsSignature(file) {
  try {
    const dir = threadDir(file);
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      })
      .join("|");
  } catch {
    return "";
  }
}

/**
 * Threads an agent should act on: open ones a human asked an agent about,
 * and accepted suggestions nobody has applied to the source yet.
 */
export function agentWork(threads) {
  return threads.filter((t) => (t.status === "open" && t.ask_agent) || (t.kind === "suggestion" && t.status === "accepted"));
}

// ------------------------------------------------------------------ writing

function write(file, thread) {
  fs.mkdirSync(threadDir(file), { recursive: true });
  atomicWrite(threadPath(file, thread.id), `${JSON.stringify(thread, null, 2)}\n`);
  return thread;
}

function cleanAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || !String(anchor.quote || "")) return null;
  return {
    prefix: String(anchor.prefix || ""),
    quote: String(anchor.quote),
    suffix: String(anchor.suffix || ""),
  };
}

const cleanBody = (body) => String(body || "").trim().slice(0, BODY_CAP);

export function createThread(file, { kind = "comment", anchor = null, replacement, body = "", author, askAgent = false } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  const quote = cleanAnchor(anchor);
  if (!quote) throw new Error("a thread needs the quoted text it is about");
  const text = cleanBody(body);
  if (kind === "suggestion") {
    if (typeof replacement !== "string") throw new Error("a suggestion needs replacement text");
    if (replacement === quote.quote) throw new Error("the suggestion does not change the text");
  } else if (!text) {
    throw new Error("a comment needs a message");
  }
  const at = now();
  const who = cleanAuthor(author, humanAuthor(file));
  const thread = {
    format: THREAD_FORMAT,
    id: newThreadId(),
    file: path.basename(file),
    kind,
    anchor: quote,
    ...(kind === "suggestion" ? { replacement: String(replacement).slice(0, BODY_CAP) } : {}),
    status: "open",
    ask_agent: !!askAgent,
    author: who,
    created_at: at,
    updated_at: at,
    messages: text ? [{ id: newMessageId(), author: who, body: text, at }] : [],
    history: [{ status: "open", by: who, at }],
  };
  return write(file, thread);
}

function mutate(file, id, change) {
  const thread = getThread(file, id);
  if (!thread) throw new Error(`no thread ${id} for ${path.basename(file)}`);
  change(thread);
  thread.updated_at = now();
  return write(file, thread);
}

/** An agent answering a thread is the answer a human asked for, so the ask clears. */
export function replyToThread(file, id, { body, author } = {}) {
  const text = cleanBody(body);
  if (!text) throw new Error("a reply needs a message");
  return mutate(file, id, (thread) => {
    const who = cleanAuthor(author, humanAuthor(file));
    thread.messages.push({ id: newMessageId(), author: who, body: text, at: now() });
    if (who.type === "agent") thread.ask_agent = false;
  });
}

const ALLOWED = {
  comment: { open: ["resolved"], resolved: ["open"] },
  suggestion: {
    open: ["accepted", "rejected"],
    accepted: ["applied", "open", "rejected"],
    rejected: ["open"],
    applied: ["open"],
  },
};

export function setThreadStatus(file, id, status, { author, note = "" } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}`);
  return mutate(file, id, (thread) => {
    const next = (ALLOWED[thread.kind] || {})[thread.status] || [];
    if (!next.includes(status)) {
      throw new Error(`a ${thread.kind} that is ${thread.status} cannot become ${status}`);
    }
    const who = cleanAuthor(author, humanAuthor(file));
    thread.status = status;
    thread.history.push({ status, by: who, at: now() });
    // A human or agent deciding again settles a decision two branches disagreed on.
    delete thread.conflict;
    const text = cleanBody(note);
    if (text) thread.messages.push({ id: newMessageId(), author: who, body: text, at: now() });
    if (status !== "open" && status !== "accepted") thread.ask_agent = false;
  });
}

export function setAskAgent(file, id, ask) {
  return mutate(file, id, (thread) => {
    thread.ask_agent = !!ask;
  });
}

// ------------------------------------------------------------------ merging

/**
 * Combine two versions of one thread, as two branches left it. Messages and
 * status changes are append-only records, so both sides keep all of theirs.
 * The one thing that can genuinely disagree is the decision: when each side
 * moved the status somewhere different, neither wins. The thread reopens with
 * a `conflict` naming both outcomes, for a person to decide again.
 *
 * The shared starting point is read from the history both sides still have in
 * common, so this works the same with or without git's base version.
 *
 * `record: false` only flags a disagreement, for showing other branches
 * without writing; a real merge also records it in the thread.
 */
export function mergeThreads(ours, theirs, { record = true } = {}) {
  if (!ours) return theirs;
  if (!theirs) return ours;
  if (ours.id !== theirs.id) throw new Error(`cannot merge different threads (${ours.id}, ${theirs.id})`);

  const historyKey = (h) => `${h.status}|${h.at}|${(h.by && h.by.name) || ""}`;
  const theirKeys = new Set((theirs.history || []).map(historyKey));
  const common = (ours.history || []).filter((h) => theirKeys.has(historyKey(h)));
  const baseStatus = common.length ? common[common.length - 1].status : "open";

  const byTime = (a, b) => String(a.at).localeCompare(String(b.at));
  const history = [...new Map([...(ours.history || []), ...(theirs.history || [])].map((h) => [historyKey(h), h])).values()].sort(byTime);
  const messages = [...new Map([...ours.messages, ...theirs.messages].map((m) => [m.id, m])).values()].sort(
    (a, b) => byTime(a, b) || String(a.id).localeCompare(String(b.id))
  );

  const latest = String(ours.updated_at) >= String(theirs.updated_at) ? ours : theirs;
  const merged = {
    ...latest,
    messages,
    history,
    updated_at: latest.updated_at,
    ask_agent: ours.ask_agent === theirs.ask_agent ? !!ours.ask_agent : !!latest.ask_agent,
  };
  delete merged.conflict;

  const lastBy = (side) => [...(side.history || [])].reverse().find((h) => h.status === side.status) || null;
  if (ours.status === theirs.status) merged.status = ours.status;
  else if (ours.status === baseStatus) merged.status = theirs.status;
  else if (theirs.status === baseStatus) merged.status = ours.status;
  else {
    const sides = [ours, theirs].map((side) => {
      const h = lastBy(side);
      return { status: side.status, by: h ? h.by : null, at: h ? h.at : side.updated_at };
    });
    merged.status = "open";
    merged.conflict = { reason: "two branches decided differently", outcomes: sides };
    if (!record) return fill(merged, theirs);
    const names = sides.map((s) => `${s.by ? s.by.name : "someone"} ${s.status === "open" ? "reopened it" : `marked it ${s.status}`}`);
    const at = new Date().toISOString();
    merged.history = [...merged.history, { status: "open", by: { name: "human-review", type: "system" }, at }];
    merged.messages = [
      ...merged.messages,
      {
        id: `m_${crypto.randomBytes(4).toString("hex")}`,
        author: { name: "human-review", type: "system" },
        body: `Merged branches disagree: ${names.join(", but ")}. Reopened for a decision.`,
        at,
      },
    ];
    merged.updated_at = at;
  }
  return fill(merged, theirs);
}

/** A thread from either side may predate a field the other has. */
function fill(merged, other) {
  for (const field of ["format", "id", "file", "kind", "anchor", "replacement", "author", "created_at"]) {
    if (merged[field] === undefined && other[field] !== undefined) merged[field] = other[field];
  }
  return merged;
}

/**
 * Split a file git left with conflict markers into the two versions it came
 * from. Text outside the conflict blocks belongs to both. Returns null when the
 * file has no markers. Handles git's default and diff3 styles.
 */
export function splitConflict(text) {
  if (!/^<{7}( |$)/m.test(text)) return null;
  const ours = [];
  const theirs = [];
  let side = "both";
  for (const line of text.split(/\r?\n/)) {
    if (/^<{7}( |$)/.test(line)) side = "ours";
    else if (/^\|{7}( |$)/.test(line) && side === "ours") side = "base";
    else if (/^={7}$/.test(line) && (side === "ours" || side === "base")) side = "theirs";
    else if (/^>{7}( |$)/.test(line) && side === "theirs") side = "both";
    else if (side === "both") {
      ours.push(line);
      theirs.push(line);
    } else if (side === "ours") ours.push(line);
    else if (side === "theirs") theirs.push(line);
  }
  return { ours: ours.join("\n"), theirs: theirs.join("\n") };
}

/** Write a thread exactly as given: a merge result, or a copy adopted from another branch. */
export function saveThread(file, thread) {
  if (!thread || thread.format !== THREAD_FORMAT || !validId(thread.id)) throw new Error("not a human-review thread");
  return write(file, thread);
}
