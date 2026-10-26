import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listThreads, mergeThreads, saveThread, splitConflict, THREAD_FORMAT, threadDir } from "./threads.js";

/**
 * Shared threads travel through git. This module is the git side of them:
 * a merge driver so two branches that touched the same thread combine instead
 * of conflicting, a repair for files git already left with conflict markers,
 * and a read-only view of the threads on other branches (open pull requests)
 * so reviewers see each other's comments before anything is merged.
 */

export const DRIVER = "human-review-thread";
export const ATTRIBUTE_LINE = `**/*.review/*.json merge=${DRIVER}`;

function git(cwd, args, { input } = {}) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024, input });
  return { ok: out.status === 0, stdout: out.stdout || "", stderr: out.stderr || "" };
}

export function repoRoot(file) {
  const got = git(path.dirname(path.resolve(file)), ["rev-parse", "--show-toplevel"]);
  return got.ok ? path.resolve(got.stdout.trim()) : null;
}

const parse = (text) => {
  try {
    const thread = JSON.parse(text);
    return thread && thread.format === THREAD_FORMAT ? thread : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- setup

/**
 * Register the merge driver for one clone and declare it for every clone.
 * `.gitattributes` is committed, so everyone's git knows which files use the
 * driver; the driver command itself lives in each clone's own git config,
 * which is why every collaborator runs this once.
 */
export function setupGit(cwd, command) {
  const root = repoRoot(path.join(cwd, "x"));
  if (!root) throw new Error("Not inside a git repository.");
  const lines = [];
  git(root, ["config", `merge.${DRIVER}.name`, "human-review shared-thread merge"]);
  git(root, ["config", `merge.${DRIVER}.driver`, `${command} merge-thread %O %A %B`]);
  lines.push(`git config  merge.${DRIVER}.driver = ${command} merge-thread %O %A %B   (this clone)`);
  const attributes = path.join(root, ".gitattributes");
  const current = fs.existsSync(attributes) ? fs.readFileSync(attributes, "utf8") : "";
  if (!current.split(/\r?\n/).includes(ATTRIBUTE_LINE)) {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(attributes, `${current}${current && !current.endsWith("\n") ? eol : ""}${ATTRIBUTE_LINE}${eol}`);
    lines.push(`.gitattributes  + ${ATTRIBUTE_LINE}   (commit this, so every clone uses the driver)`);
  } else {
    lines.push(".gitattributes  already declares the driver");
  }
  return lines;
}

// ---------------------------------------------------------------- merging

/**
 * git's merge driver contract: base, ours, and theirs are temporary files;
 * the result goes into ours; exit 0 for a clean merge. Anything unreadable
 * returns false so git falls back to an ordinary conflict.
 */
export function mergeDriver(basePath, oursPath, theirsPath) {
  const ours = parse(fs.readFileSync(oursPath, "utf8"));
  const theirs = parse(fs.readFileSync(theirsPath, "utf8"));
  if (!ours || !theirs || ours.id !== theirs.id) return false;
  const merged = mergeThreads(ours, theirs);
  fs.writeFileSync(oursPath, `${JSON.stringify(merged, null, 2)}\n`);
  return true;
}

/**
 * Repair thread files that git left with conflict markers: after a merge or
 * rebase without the driver, or a merge done on a hosting site. Returns what
 * happened to each file so an agent can report it.
 */
export function fixThreads(start) {
  const results = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".review")) fixFolder(full);
        else visit(full);
      }
    }
  };
  const fixFolder = (folder) => {
    for (const name of fs.readdirSync(folder)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(folder, name);
      const text = fs.readFileSync(full, "utf8");
      const sides = splitConflict(text);
      if (!sides) continue;
      const ours = parse(sides.ours);
      const theirs = parse(sides.theirs);
      if (!ours || !theirs || ours.id !== theirs.id) {
        results.push({ file: full, fixed: false, reason: "one side is not a readable thread" });
        continue;
      }
      const merged = mergeThreads(ours, theirs);
      fs.writeFileSync(full, `${JSON.stringify(merged, null, 2)}\n`);
      results.push({ file: full, fixed: true, conflict: !!merged.conflict });
    }
  };
  const resolved = path.resolve(start);
  if (resolved.endsWith(".review") && fs.existsSync(resolved)) fixFolder(resolved);
  else visit(resolved);
  return results;
}

// ---------------------------------------------------------------- other branches

const branchCache = new Map();

/** Branches other than the one checked out: local ones and every fetched remote branch. */
function otherRefs(root) {
  const head = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  const listed = git(root, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads", "refs/remotes"]);
  if (!listed.ok) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    // The remote copy of this branch stays in: a co-author may have pushed replies to it.
    .filter(([ref, sha]) => ref && sha && ref !== head && !ref.endsWith("/HEAD"));
}

/**
 * Every thread for `file` on other branches, keyed by thread id. Each entry
 * lists the branches it appears on and the version found there. Read with
 * `git show`, so nothing is checked out or changed. Cached per branch tip.
 */
export function branchThreads(file) {
  const root = repoRoot(file);
  if (!root) return new Map();
  // Ask git where the file sits in the repository rather than comparing
  // paths: on Windows the same folder can be spelled two ways (8.3 short
  // names such as RUNNER~1), and a relative path between them is nonsense.
  const prefix = git(path.dirname(path.resolve(file)), ["rev-parse", "--show-prefix"]).stdout.trim();
  const rel = `${prefix}${path.basename(threadDir(file))}`;
  const found = new Map();
  for (const [ref, sha] of otherRefs(root)) {
    const cacheKey = `${root}|${rel}|${sha}`;
    let threads = branchCache.get(cacheKey);
    if (!threads) {
      threads = [];
      const listing = git(root, ["ls-tree", "--name-only", sha, "--", `${rel}/`]);
      for (const name of listing.ok ? listing.stdout.split("\n").filter((n) => n.endsWith(".json")) : []) {
        const shown = git(root, ["show", `${sha}:${name}`]);
        const thread = shown.ok ? parse(shown.stdout) : null;
        if (thread) threads.push(thread);
      }
      branchCache.set(cacheKey, threads);
    }
    for (const thread of threads) {
      const entry = found.get(thread.id) || { refs: [], versions: [] };
      entry.refs.push(ref);
      entry.versions.push(thread);
      found.set(thread.id, entry);
    }
  }
  return found;
}

/**
 * The combined view a reviewer sees: this branch's threads, with every other
 * branch's version folded in. `branches` names where a thread also lives;
 * `elsewhere` marks threads this branch does not have at all.
 */
export function combinedThreads(file) {
  const local = listThreads(file);
  const others = branchThreads(file);
  const out = [];
  const seen = new Set();
  for (const thread of local) {
    seen.add(thread.id);
    const remote = others.get(thread.id);
    if (!remote) {
      out.push(thread);
      continue;
    }
    const merged = remote.versions.reduce((acc, version) => mergeThreads(acc, version, { record: false }), thread);
    const changed = JSON.stringify(merged.messages) !== JSON.stringify(thread.messages) || merged.status !== thread.status;
    out.push({ ...merged, branches: remote.refs, ...(changed ? { updates_elsewhere: true } : {}) });
  }
  for (const [id, remote] of others) {
    if (seen.has(id)) continue;
    const merged = remote.versions.reduce((acc, version) => mergeThreads(acc, version, { record: false }));
    out.push({ ...merged, branches: remote.refs, elsewhere: true });
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * Before writing to a thread, bring in what other branches added, so a reply
 * to a comment from another pull request lands on this branch with the whole
 * conversation, and merges cleanly later.
 */
export function adoptThread(file, id) {
  const remote = branchThreads(file).get(id);
  if (!remote) return null;
  const local = listThreads(file).find((t) => t.id === id) || null;
  const merged = remote.versions.reduce((acc, version) => mergeThreads(acc, version), local);
  const { branches, elsewhere, updates_elsewhere, ...clean } = merged;
  return saveThread(file, clean);
}

/** `git fetch` for the file's repository, so other branches' threads are current. */
export function fetchRemotes(file) {
  const root = repoRoot(file);
  if (!root) throw new Error("This file is not in a git repository.");
  const got = git(root, ["fetch", "--all", "--prune", "--quiet"]);
  if (!got.ok) throw new Error(got.stderr.trim() || "git fetch failed");
  return true;
}

const gitDirs = new Map();

/**
 * A cheap stamp that changes when branches move (a fetch, a commit, a
 * checkout), so an open page can refresh other branches' threads without
 * running git every couple of seconds.
 */
export function refsStamp(file) {
  const start = path.dirname(path.resolve(file));
  if (!gitDirs.has(start)) {
    const got = git(start, ["rev-parse", "--absolute-git-dir"]);
    gitDirs.set(start, got.ok ? got.stdout.trim() : "");
  }
  const dir = gitDirs.get(start);
  if (!dir) return "";
  return ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "packed-refs", "refs/heads", "refs/remotes"]
    .map((name) => {
      try {
        return fs.statSync(path.join(dir, name)).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(":");
}
