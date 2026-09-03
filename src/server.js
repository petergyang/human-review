import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWrite, Store, resolveAsset } from "./state.js";
import { injectSdk, stripSdk } from "./html-transform.js";
import { isMarkdown, renderMarkdownPage } from "./markdown.js";
import { canonicalTarget, ensureStateDir, localUrl, SERVER_PROTOCOL, serverPath, stateDir, targetKey } from "./paths.js";
import { invocation, shellQuote } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const MAX_BODY = 24 * 1024 * 1024;
const POLL_HEARTBEAT_MS = 15000;
const WATCH_INTERVAL_MS = 400;
const IDLE_SHUTDOWN_MS = Number(process.env.HUMAN_REVIEW_IDLE_MS || 45 * 60 * 1000);
/** A window with no live connection this long is treated as closed for good. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** After a tab says it is going away, how long a reload has to come back. */
const CLOSE_GRACE_MS = Number(process.env.HUMAN_REVIEW_CLOSE_GRACE_MS || 5000);
/** A session no tab ever connected to (the browser never opened) is dropped after this long. */
const NEVER_OPENED_MS = Number(process.env.HUMAN_REVIEW_NEVER_OPENED_MS || 60 * 1000);
/** A poll with no review open waits this long for one before giving up. */
const NO_REVIEW_GRACE_MS = Number(process.env.HUMAN_REVIEW_NO_REVIEW_GRACE_MS || 10000);
/** Edit text is capped so one pasted novel cannot bloat the state file; the cut is marked. */
const EDIT_TEXT_CAP = 200000;
const TRUNCATED_MARK = " …[truncated by human-review]";

const SUPERSEDED = {
  status: "superseded",
  next_step: "A newer poll for this target took over the wait. Stop here and do not run the poll command again from this task.",
};
const MAX_LOCAL_REDIRECTS = 5;
/** Generous enough for a dev server's cold compile, but a wedged one can't hang us forever. */
const LOCAL_FETCH_TIMEOUT_MS = 30000;
const MAX_LOCAL_PAGE_BYTES = 24 * 1024 * 1024;

const hash = (text) => crypto.createHash("sha1").update(text).digest("hex");
const uid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;

/** Read an HTML response with a hard size cap, since text() is unbounded. */
async function readCapped(response, url) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LOCAL_PAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`The page at ${url} is larger than ${MAX_LOCAL_PAGE_BYTES / (1024 * 1024)}MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchLocalPage(target, redirects = 0) {
  const url = localUrl(target);
  let response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Localhost did not answer within ${LOCAL_FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    }
    throw err;
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Localhost returned redirect ${response.status} without a location.`);
    if (redirects >= MAX_LOCAL_REDIRECTS) throw new Error("Too many redirects while loading the localhost page.");
    return fetchLocalPage(new URL(location, url).href, redirects + 1);
  }
  if (!response.ok) throw new Error(`Localhost returned ${response.status} for ${url}`);
  const contentType = response.headers.get("content-type") || "";
  if (!/html|xhtml/i.test(contentType)) {
    throw new Error(`Expected an HTML page from localhost, but received ${contentType || "an unknown content type"}.`);
  }
  return { html: await readCapped(response, url), resolvedUrl: response.url || url };
}

/**
 * Staged localhost pastes are deleted when their batch is acked. A batch that
 * never gets acked (the agent died, the page was pruned) would leave them
 * behind forever, so on start drop every staged file that no live edit or
 * pending batch still refers to.
 */
function sweepStagedPastes(store) {
  const root = path.join(stateDir(), "pasted");
  let keys;
  try {
    keys = fs.readdirSync(root);
  } catch {
    return;
  }
  const live = new Set();
  for (const page of Object.values(store.data.pages)) {
    for (const edit of page.edits || []) {
      for (const asset of edit.staged_assets || []) live.add(path.resolve(asset.path));
    }
  }
  for (const record of Object.values(store.allBatches())) {
    for (const entry of record.cleanup || []) {
      for (const file of entry.staged || []) live.add(path.resolve(file));
    }
  }
  for (const key of keys) {
    const dir = path.join(root, key);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      if (live.has(path.resolve(full))) continue;
      try {
        fs.unlinkSync(full);
      } catch {}
    }
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
}

export function createServer() {
  const store = new Store();
  sweepStagedPastes(store);
  const cliInvocation = invocation();

  /**
   * Random per-run secret. Every /api route requires it, so a malicious web
   * page firing blind cross-origin POSTs at 127.0.0.1 cannot write files.
   * The CLI reads it from server.json; the chrome page gets it injected.
   */
  const token = crypto.randomBytes(16).toString("hex");

  /** Browser windows. Ephemeral — nothing durable lives here. */
  const sessions = new Map(); // sessionId -> { id, entryKey, activeKey, visited, clients:Set<res>, lastSeen }
  /** Agent long-polls, keyed by the entry page they were started on. */
  const pollers = new Map(); // entryKey -> Set<{ res, timer }>
  /** Pending batches awaiting --ack; mirrored to the store so they survive restarts. */
  const batches = new Map(
    Object.entries(store.allBatches()).map(([key, record]) => [
      key,
      { batch: record.batch, cleanup: record.cleanup, delivered: !!record.delivered, priorCleanup: record.priorCleanup || null },
    ])
  );
  /** Unguessable path segment for the artifact route, which the iframe cannot send a header to. */
  const viewToken = crypto.randomBytes(8).toString("hex");
  /** The localhost page most recently served, for proxying its app's own requests. */
  let lastUrlPageKey = null;
  const watched = new Map(); // key -> { file }
  const lastWritten = new Map(); // key -> content hash human-review itself wrote

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  const seen = (session) => {
    if (session) session.lastSeen = Date.now();
  };

  // ---------------------------------------------------------------- helpers

  function sessionsForKey(key) {
    return [...sessions.values()].filter((s) => s.activeKey === key);
  }

  function sessionsForEntry(entryKey) {
    return [...sessions.values()].filter((s) => s.entryKey === entryKey);
  }

  function emit(session, event, data) {
    for (const res of session.clients) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
    }
  }

  /**
   * A pending batch only means "working" once an agent has actually taken it.
   * Feedback sent with nothing listening is "stranded", and the browser says so.
   */
  function agentState(entryKey) {
    const pending = batches.get(entryKey);
    if (pending && pending.delivered) return "working";
    // Sent while the agent was still applying the previous batch: it ships
    // with the agent's next poll, so nobody needs to do anything.
    if (pending && pending.priorCleanup) return "queued";
    const set = pollers.get(entryKey);
    if (set && set.size) return "listening";
    return pending ? "stranded" : "idle";
  }

  function broadcastAgent(entryKey) {
    const state = agentState(entryKey);
    for (const session of sessionsForEntry(entryKey)) emit(session, "agent", { state });
  }

  /** Unsent feedback on every page reachable from this entry target. */
  function unsentCounts(entryKey) {
    const keys = new Set([entryKey]);
    for (const session of sessions.values()) {
      if (session.entryKey !== entryKey) continue;
      for (const k of session.visited) keys.add(k);
    }
    let comments = 0;
    let edits = 0;
    for (const k of keys) {
      const page = store.page(k);
      if (!page) continue;
      comments += page.comments.length;
      edits += page.edits.length;
    }
    return { comments, edits };
  }

  const CLOSE_REASONS = {
    ended: "The user ended this review from the browser.",
    window_closed: "The user closed the review tab without sending.",
    no_review_open: "No review is open for this target in the browser.",
  };

  function closedPayload(entryKey, reason) {
    const unsent = unsentCounts(entryKey);
    const left = unsent.comments + unsent.edits;
    return {
      status: "closed",
      reason,
      unsent,
      next_step:
        `${CLOSE_REASONS[reason] || CLOSE_REASONS.ended} Stop waiting — do not run the poll command again. ` +
        (left
          ? `${left} unsent ${left === 1 ? "item was" : "items were"} left behind; they are kept and the user can restore or discard them the next time this target is reviewed. Tell the user in one line, then stop.`
          : "Nothing was left unsent. Tell the user the review closed, then stop."),
    };
  }

  /** Hand every waiting poll for a target its final answer. */
  function releasePollers(entryKey, payload) {
    const set = pollers.get(entryKey);
    if (!set) return;
    for (const poller of [...set]) {
      clearInterval(poller.timer);
      clearTimeout(poller.graceTimer);
      set.delete(poller);
      poller.res.end(JSON.stringify(payload));
    }
  }

  // ------------------------------------------------------------- file watch

  function watchPage(key) {
    if (watched.has(key)) return;
    const page = store.page(key);
    if (!page || page.kind === "url") return;
    watched.set(key, { file: page.file });

    fs.watchFile(page.file, { interval: WATCH_INTERVAL_MS }, () => {
      let html = "";
      try {
        html = fs.readFileSync(page.file, "utf8");
      } catch {
        return;
      }
      const current = hash(html);
      // Our own autosave must never bounce back as a reload.
      if (lastWritten.get(key) === current) return;
      lastWritten.set(key, current);
      // Rows on a Markdown or self-rendering page are unsent feedback, not
      // something this write already contains; keep them.
      store.setPristine(key, html, { keepEdits: isMarkdown(page.file) || !!store.page(key)?.dynamic });
      for (const session of sessionsForKey(key)) emit(session, "reload", { key });
    });
  }

  function writePage(key, html) {
    const page = store.page(key);
    if (!page) throw new Error("unknown page");
    if (page.kind === "url") throw new Error("localhost pages are applied through their source files");
    const clean = stripSdk(html);
    atomicWrite(page.file, clean);
    lastWritten.set(key, hash(clean));
    store.setSavedHash(key, hash(clean));
    return clean;
  }

  /**
   * Register a file for review. The file as it sits on disk becomes the
   * agent's version — the revert target — unless the page still carries
   * unsent edits and the file is exactly what the browser last autosaved:
   * then the disk copy *is* those edits, and the agent's version stays.
   */
  function openFile(file) {
    const html = stripSdk(fs.readFileSync(file, "utf8"));
    const existing = store.pageForFile(file);
    const keep = !!existing && existing.kind !== "url" && existing.edits.length > 0 && existing.savedHash === hash(html);
    const page = store.openPage(file, keep ? undefined : html);
    lastWritten.set(page.key, hash(html));
    return page;
  }

  // ------------------------------------------------------------------ batch

  function deliver(entryKey, batch) {
    const set = pollers.get(entryKey);
    if (!set || set.size === 0) return false;
    for (const poller of [...set]) {
      clearInterval(poller.timer);
      set.delete(poller);
      poller.res.end(JSON.stringify(batch));
    }
    return true;
  }

  /**
   * Every page you left feedback on ships in one batch, grouped by target.
   * `already` is the cleanup of a batch the agent has but has not acked yet:
   * anything it covers is in the agent's hands already and must not ship twice.
   */
  function collectPages(session, already = []) {
    const out = [];
    for (const key of session.visited) {
      const page = store.page(key);
      if (!page) continue;
      const covered = already.filter((entry) => entry.key === key);
      const coveredIds = new Set(covered.flatMap((entry) => entry.ids));
      const coveredUntil = covered.reduce((max, entry) => Math.max(max, entry.sentAt || 0), 0);
      const comments = page.comments.filter((c) => !coveredIds.has(c.id));
      const edits = page.edits.filter((e) => (e.updatedAt || e.at || 0) >= coveredUntil);
      if (!comments.length && !edits.length) continue;
      const markdown = page.kind !== "url" && isMarkdown(page.file);
      out.push({
        key,
        kind: page.kind === "url" ? "url" : "file",
        file: page.kind === "url" ? page.url : page.file,
        url: page.kind === "url" ? page.url : undefined,
        markdown,
        // Direct edits to a plain HTML file are autosaved into it as they
        // happen; everywhere else they exist only in this batch.
        edits_saved: page.kind !== "url" && !markdown && !page.dynamic,
        comments: comments.map((c) => ({
          id: c.id,
          kind: c.kind,
          quote: c.quote,
          anchor: c.anchor,
          feedback: c.feedback,
        })),
        edits: edits.map((e) => ({
          label: e.label,
          kind: e.kind,
          before: e.before,
          after: e.after,
          ...(e.before_html !== undefined && e.before_html !== e.before ? { before_html: e.before_html } : {}),
          ...(e.after_html !== undefined && e.after_html !== e.after ? { after_html: e.after_html } : {}),
          ...(e.kind === "moved" ? { moved_after: e.moved_after || "", moved_before: e.moved_before || "" } : {}),
          ...(Array.isArray(e.staged_assets) && e.staged_assets.length ? { staged_assets: e.staged_assets } : {}),
          ...(e.truncated ? { truncated: true } : {}),
        })),
      });
    }
    return out;
  }

  /** Pages with feedback that are not the one on screen. */
  function otherPages(session) {
    return collectPages(session)
      .filter((p) => p.key !== session.activeKey)
      .map((p) => ({
        key: p.key,
        filename: p.kind === "url" ? new URL(p.url).pathname || p.url : path.basename(p.file),
        count: p.comments.length + p.edits.length,
      }));
  }

  function sendBatch(sessionId, note) {
    const session = sessions.get(sessionId);
    if (!session) return { error: "unknown session" };

    // A batch the agent took but has not acked is in its hands: the new Send
    // carries only what came after it, and the old cleanup rides along so the
    // agent's next --ack clears both.
    const previous = batches.get(session.entryKey);
    const inFlight = previous && previous.delivered ? previous : null;
    const already = inFlight ? [...(inFlight.priorCleanup || []), ...inFlight.cleanup] : previous ? previous.priorCleanup || [] : [];
    const pages = collectPages(session, already);
    if (!pages.length && !note) return { error: inFlight ? "nothing new since the batch the agent is working on" : "nothing to send" };

    const hasMarkdown = pages.some((p) => p.markdown);
    const hasUrl = pages.some((p) => p.kind === "url");
    const hasSaved = pages.some((p) => p.edits_saved && p.edits.length);
    const hasTruncated = pages.some((p) => p.edits.some((e) => e.truncated));
    const batch = {
      status: "feedback",
      pages: pages.map(({ kind, file, url, markdown, edits_saved, comments, edits }) => ({
        kind,
        file,
        ...(url ? { url } : {}),
        ...(markdown ? { markdown: true } : {}),
        edits_saved,
        comments,
        edits,
      })),
      overall_note: note || "",
      sent_at: new Date().toISOString(),
      next_step:
        "Apply this feedback. Each entry in `pages` names the reviewed file or localhost URL. Items under `edits` are " +
        "changes the human already made: `after` is their exact new wording, so carry it across verbatim, and " +
        "never revert it. When an edit carries `after_html`, the human changed formatting (bold, italic, links) — " +
        "use the HTML version, translated into the source's own syntax. " +
        (hasSaved
          ? "Pages with `edits_saved: true` already contain those edits on disk: re-read the file before touching it and " +
            "make targeted changes only — never regenerate it from an older copy, or their work disappears. "
          : "") +
        (hasTruncated
          ? "An edit marked `truncated` had its text cut at " + EDIT_TEXT_CAP + " characters; read the block from the page itself. "
          : "") +
        (hasMarkdown
          ? "Markdown pages were reviewed rendered, so quotes and `after` wording use the rendered text — apply " +
            "the change to the Markdown source, keeping its formatting syntax. "
          : "") +
        (hasUrl
          ? "Localhost pages were edited directly in the review UI. Find the matching project source (such as MDX or TSX) " +
            "and apply every exact edit or deletion there; never try to write the rendered HTML response back to the app. " +
            "When an edit includes `staged_assets`, copy each local image into the app's appropriate asset folder, replace its " +
            "temporary preview URL in `after_html`, and preserve the image at the user's insertion point. "
          : "") +
        "When every page is updated, run the same poll command again with --ack to clear this " +
        "batch and wait for more.",
    };

    const record = {
      batch,
      delivered: false,
      priorCleanup: already.length ? already : null,
      cleanup: pages.map((p) => ({
        key: p.key,
        ids: p.comments.map((c) => c.id),
        staged: p.edits.flatMap((edit) => (edit.staged_assets || []).map((asset) => asset.path)),
        sentAt: Date.now(),
      })),
    };
    batches.set(session.entryKey, record);
    record.delivered = deliver(session.entryKey, batch);
    store.setBatch(session.entryKey, record);
    broadcastAgent(session.entryKey);
    return { ok: true };
  }

  /** Forget the feedback a batch carried, now that the agent has applied it. */
  function applyCleanup(entryKey, cleanup) {
    const stagedRoot = path.join(stateDir(), "pasted");
    for (const file of cleanup.flatMap((entry) => entry.staged || [])) {
      const resolved = path.resolve(file);
      const relative = path.relative(stagedRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      try {
        fs.unlinkSync(resolved);
        fs.rmdirSync(path.dirname(resolved));
      } catch {}
    }
    for (const { key, ids, sentAt } of cleanup) store.clearSent(key, ids, sentAt);
    for (const session of sessionsForEntry(entryKey)) emit(session, "refresh", {});
    // File targets reload through fs.watch. URL targets have no source file to
    // watch, so acknowledgement is the signal to fetch the rebuilt route.
    for (const { key } of cleanup) {
      if (store.page(key)?.kind === "url") {
        for (const session of sessionsForKey(key)) emit(session, "reload", { key });
      }
    }
  }

  function ack(entryKey) {
    const pending = batches.get(entryKey) || store.batchFromDisk(entryKey);
    if (!pending) return false;
    if (!pending.delivered) {
      // The agent is acking the batch it had, which a newer Send has since
      // queued behind. Clear that one; the new batch is delivered untouched.
      if (!pending.priorCleanup) return false;
      const prior = pending.priorCleanup;
      pending.priorCleanup = null;
      batches.set(entryKey, pending);
      store.setBatch(entryKey, pending);
      applyCleanup(entryKey, prior);
      broadcastAgent(entryKey);
      return true;
    }
    batches.delete(entryKey);
    store.clearBatch(entryKey);
    applyCleanup(entryKey, [...(pending.priorCleanup || []), ...pending.cleanup]);
    broadcastAgent(entryKey);
    return true;
  }

  /**
   * The review is over — the user hit End review, closed the tab, or the tab
   * never came back. The browser forgets the session and any waiting agent is
   * released with a clear "stop" answer instead of waiting forever. Unsent
   * feedback stays in the store; the next open offers to restore or discard it.
   */
  function endSession(session, reason = "ended") {
    clearTimeout(session.awayTimer);
    sessions.delete(session.id);
    for (const res of session.clients) {
      res.write(`event: ended\ndata: ${JSON.stringify({ reason })}\n\n`);
      res.end();
    }
    session.clients.clear();
    // Another window on the same target keeps its agent connection alive.
    if (sessionsForEntry(session.entryKey).length > 0) return;
    // A batch the user sent must reach the agent before the close does; the
    // poll route returns it first, and the closed answer follows on the next poll.
    if (batches.get(session.entryKey)) return;
    releasePollers(session.entryKey, closedPayload(session.entryKey, reason));
  }

  /**
   * The tab said it is unloading. A reload reconnects within moments; a real
   * close never does, and then the review ends and the waiting agent is freed.
   */
  function scheduleAway(session) {
    clearTimeout(session.awayTimer);
    session.awayTimer = setTimeout(() => {
      if (!sessions.has(session.id) || session.clients.size > 0) return;
      endSession(session, "window_closed");
    }, CLOSE_GRACE_MS);
  }

  // ----------------------------------------------------------------- routes

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  /** Binary request body (pasted images), capped like readBody. */
  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const json = (res, code, payload) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  function serveFile(res, file, extraHeaders) {
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(extraHeaders || {}),
      });
      res.end(buf);
    });
  }

  // The artifact iframe uses the alternate loopback hostname to stay isolated
  // from the review shell, so its SDK module needs CORS to load.
  const CORS = { "access-control-allow-origin": "*" };

  function pageState(key, session) {
    const page = store.page(key);
    if (!page) return null;
    // The entry target is what the agent polls, even after navigating elsewhere.
    const entry = session ? store.page(session.entryKey) : null;
    const currentTarget = page.kind === "url" ? page.url : page.file;
    const pollTarget = entry ? (entry.kind === "url" ? entry.url : entry.file) : currentTarget;
    return {
      key: page.key,
      kind: page.kind === "url" ? "url" : "file",
      file: currentTarget,
      ...(page.kind === "url" ? { url: page.url } : {}),
      filename: page.kind === "url" ? new URL(page.url).pathname || page.url : path.basename(page.file),
      markdown: page.kind !== "url" && isMarkdown(page.file),
      feedbackOnly: page.kind === "url",
      comments: page.comments,
      edits: page.edits,
      canRevert: page.kind !== "url" && typeof page.pristine === "string" && page.pristine.length > 0,
      pollCommand: `${cliInvocation} poll ${shellQuote(pollTarget)}`,
    };
  }

  const STATIC = {
    "/chrome.css": ["chrome.css", null],
    "/chrome.js": ["chrome-client.js", CORS],
    "/chrome-session.js": ["chrome-session.js", CORS],
    "/sdk.js": ["sdk.js", CORS],
    "/editing.js": ["editing.js", CORS],
    "/anchor-text.js": ["anchor-text.js", CORS],
    "/frame-policy.js": ["frame-policy.js", CORS],
    "/click-target.js": ["click-target.js", CORS],
    "/serialize.js": ["serialize.js", CORS],
  };

  /**
   * A localhost app under review keeps fetching from its own origin: API
   * calls, route prefetches, chunk loads, images from `srcset`. Inside the
   * review those land here instead, so anything that is not ours is passed
   * through to the app, unchanged in both directions.
   */
  function proxyToApp(req, res, target) {
    const headers = { ...req.headers, host: target.host };
    delete headers.cookie;
    const upstream = http.request(target, { method: req.method, headers }, (up) => {
      const out = { ...up.headers };
      // The response now lives on the review origin; app cookies must not
      // land here, and frame-blocking headers would blank the iframe.
      delete out["set-cookie"];
      delete out["x-frame-options"];
      delete out["content-security-policy"];
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Could not reach ${target.href}: ${err.message}`);
    });
    req.pipe(upstream);
  }

  /** The localhost page whose app a stray request belongs to, if any. */
  function appPageFor(req) {
    const cookie = String(req.headers.cookie || "");
    const match = cookie.match(/(?:^|;\s*)__hr_page=([a-f0-9]+)/);
    const fromCookie = match ? store.page(match[1]) : null;
    if (fromCookie && fromCookie.kind === "url") return fromCookie;
    const last = lastUrlPageKey ? store.page(lastUrlPageKey) : null;
    return last && last.kind === "url" ? last : null;
  }

  const server = http.createServer(async (req, res) => {
    touch();
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname;

    try {
      // A request that arrived via a DNS-rebound hostname carries that hostname
      // in Host. Refusing it means a malicious page can never speak to us as if
      // it were same-origin.
      const host = String(req.headers.host || "");
      const port = req.socket.localPort;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("Forbidden");
      }

      if (route === "/health") return json(res, 200, { ok: true, pid: process.pid, protocol: SERVER_PROTOCOL });

      // Our own callers always send the token; an app under review never
      // does. Anything else it asks for is its own, and goes to the app.
      const ours = STATIC[route] || route.startsWith("/artifact/") || route.startsWith("/s/") || route.startsWith("/events/");
      if (!ours && !req.headers["x-human-review-token"]) {
        const appPage = appPageFor(req);
        if (appPage) return proxyToApp(req, res, new URL(`${route}${url.search}`, appPage.url));
      }

      // Every API route needs the per-run token; static assets and the
      // unguessable /s/<id> chrome page do not.
      // Header only — a token in a query string would leak into logs and
      // history. Constant-time compare, so timing can't narrow the secret.
      if (route.startsWith("/api/")) {
        const provided = Buffer.from(String(req.headers["x-human-review-token"] || ""));
        const expected = Buffer.from(token);
        const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        if (!ok) return json(res, 401, { error: "missing or invalid token" });
      }

      // --- static chrome assets
      if (STATIC[route]) return serveFile(res, path.join(here, STATIC[route][0]), STATIC[route][1] || undefined);

      // --- open a browser session for a file or localhost URL
      if (route === "/api/session" && req.method === "POST") {
        const body = await readBody(req);
        const target = canonicalTarget(body.target || body.file || "");
        let page;
        if (target.kind === "url") {
          // Fail during open with a useful message rather than opening a blank review.
          await fetchLocalPage(target.value);
          page = store.openUrl(target.value);
        } else {
          if (!fs.existsSync(target.value)) return json(res, 404, { error: `File not found: ${target.value}` });
          page = openFile(target.value);
        }
        watchPage(page.key);
        const id = uid("s");
        // Feedback already on the page is from an earlier review that ended
        // without a Send; the browser offers to restore or discard it.
        const leftover = { comments: page.comments.length, edits: page.edits.length };
        sessions.set(id, {
          id,
          entryKey: page.key,
          activeKey: page.key,
          visited: new Set([page.key]),
          clients: new Set(),
          lastSeen: Date.now(),
          createdAt: Date.now(),
          everConnected: false,
          leftover,
          awayTimer: null,
        });
        // A poll that was about to give up for lack of a review has one now.
        for (const poller of pollers.get(page.key) || []) clearTimeout(poller.graceTimer);
        broadcastAgent(page.key);
        return json(res, 200, { sessionId: id, key: page.key, path: `/s/${id}`, artifactToken: viewToken, leftover });
      }

      // --- the chrome page
      if (route.startsWith("/s/")) {
        const id = route.slice(3);
        if (!sessions.has(id)) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("This review session has ended. Run human-review <target> again.");
        }
        seen(sessions.get(id));
        const shell = fs.readFileSync(path.join(here, "chrome.html"), "utf8");
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        return res.end(shell.replace("__SESSION_ID__", id).replace("__TOKEN__", token));
      }

      // --- the reviewed page itself, plus sibling assets for file targets.
      // The iframe cannot send the token header, so the URL carries a secret
      // of its own: the page key alone is derived from the file path, which a
      // dev server on another port could guess.
      if (route.startsWith("/artifact/")) {
        const parts = route.slice("/artifact/".length).split("/");
        const [vt, key = ""] = parts;
        const asset = parts.slice(2).join("/");
        const page = vt === viewToken ? store.page(key) : null;
        if (!page) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("Unknown page");
        }
        if (!asset || asset === "index.html") {
          let html = "";
          let sdkOptions = {};
          if (page.kind === "url") {
            try {
              const fetched = await fetchLocalPage(page.url);
              html = fetched.html;
              sdkOptions = {
                baseHref: fetched.resolvedUrl,
                src: `http://${host}/sdk.js?key=${encodeURIComponent(key)}`,
              };
            } catch (err) {
              res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
              return res.end(`Could not load ${page.url}: ${err.message}`);
            }
          } else {
            try {
              html = fs.readFileSync(page.file, "utf8");
            } catch {
              res.writeHead(404, { "content-type": "text/plain" });
              return res.end("File is gone");
            }
            // Markdown reviews render on the fly; the source file stays untouched.
            if (isMarkdown(page.file)) html = renderMarkdownPage(html, page.file);
          }
          const headers = { "content-type": MIME[".html"], "cache-control": "no-store" };
          if (page.kind === "url") {
            // Names the app that later same-origin requests belong to.
            lastUrlPageKey = key;
            headers["set-cookie"] = `__hr_page=${key}; Path=/; SameSite=Lax`;
          }
          res.writeHead(200, headers);
          return res.end(injectSdk(html, key, sdkOptions));
        }
        if (page.kind === "url") {
          const stagedPrefix = "__human_review_paste__/";
          if (asset.startsWith(stagedPrefix)) {
            const name = asset.slice(stagedPrefix.length);
            if (!name || path.basename(name) !== name) {
              res.writeHead(403, { "content-type": "text/plain" });
              return res.end("Forbidden");
            }
            return serveFile(res, path.join(stateDir(), "pasted", key, name));
          }
          return proxyToApp(req, res, new URL(`${asset}${url.search}`, page.url));
        }
        const target = resolveAsset(page.file, asset.split("?")[0]);
        if (!target) {
          res.writeHead(403, { "content-type": "text/plain" });
          return res.end("Forbidden");
        }
        return serveFile(res, target);
      }

      // --- agent status probe: is feedback waiting? is anyone listening?
      if (route === "/api/status" && req.method === "GET") {
        const entryKey = targetKey(url.searchParams.get("target") || url.searchParams.get("file") || "");
        const pending = batches.get(entryKey) || store.batchFromDisk(entryKey);
        const listening = (pollers.get(entryKey) || new Set()).size > 0;
        const reviewOpen = sessionsForEntry(entryKey).length > 0;
        return json(res, 200, {
          status: pending ? "feedback-waiting" : "idle",
          feedback_waiting: !!pending,
          agent_listening: listening,
          review_open: reviewOpen,
          server_running: true,
          unsent: unsentCounts(entryKey),
        });
      }

      // --- page data
      const pageMatch = route.match(/^\/api\/page\/([a-f0-9]+)(?:\/(\w+))?(?:\/(.+))?$/);
      if (pageMatch) {
        const [, key, action, tail] = pageMatch;
        if (!store.page(key)) return json(res, 404, { error: "unknown page" });

        if (!action && req.method === "GET") {
          const sid = url.searchParams.get("session");
          const session = sid ? sessions.get(sid) : null;
          seen(session);
          const body = pageState(key, session);
          if (session) body.others = otherPages(session);
          return json(res, 200, body);
        }

        // The file as it sits on disk, so the SDK can tell whether the page's
        // own scripts have already rewritten the live DOM.
        if (action === "raw" && req.method === "GET") {
          if (store.page(key).kind === "url") {
            return json(res, 400, { error: "localhost pages do not have a writable raw file" });
          }
          let html = "";
          try {
            html = fs.readFileSync(store.page(key).file, "utf8");
          } catch {
            return json(res, 404, { error: "file is gone" });
          }
          const clean = stripSdk(html);
          // The hash is the save precondition: a later save must name the
          // version it was based on, or it loses to a concurrent rewrite.
          return json(res, 200, { html: clean, hash: hash(clean) });
        }

        if (action === "comment" && req.method === "POST") {
          const body = await readBody(req);
          const comment = {
            id: uid("c"),
            kind: body.kind === "element" ? "element" : "selection",
            quote: String(body.quote || ""),
            anchor: body.anchor || null,
            feedback: String(body.feedback || ""),
            createdAt: Date.now(),
          };
          if (!comment.feedback) return json(res, 400, { error: "empty feedback" });
          store.addComment(key, comment);
          return json(res, 200, { comment, page: pageState(key) });
        }

        if (action === "comment" && req.method === "DELETE") {
          store.removeComment(key, tail);
          return json(res, 200, { page: pageState(key) });
        }

        if (action === "comment" && req.method === "PATCH" && tail) {
          const body = await readBody(req);
          const feedback = String(body.feedback || "").trim();
          if (!feedback) return json(res, 400, { error: "empty feedback" });
          const carrying = [...batches.entries()].find(([, record]) =>
            [...(record.priorCleanup || []), ...record.cleanup].some((entry) => entry.key === key && entry.ids.includes(tail))
          );
          if (carrying && !carrying[1].delivered && !(carrying[1].priorCleanup || []).some((e) => e.ids.includes(tail))) {
            // Sent but not yet taken: the waiting batch can still be reworded in place.
            if (!store.updateComment(key, tail, feedback)) return json(res, 404, { error: "unknown comment" });
            const [entryKey, record] = carrying;
            for (const page of record.batch.pages) {
              for (const comment of page.comments) if (comment.id === tail) comment.feedback = feedback;
            }
            store.setBatch(entryKey, record);
            return json(res, 200, { delivery: "updated-pending", page: pageState(key) });
          }
          if (carrying) {
            // The agent already has the old wording. Retire that id so the
            // ack does not clear the rewrite; it ships with the next Send.
            if (!store.updateComment(key, tail, feedback, { newId: uid("c") })) return json(res, 404, { error: "unknown comment" });
            return json(res, 200, { delivery: "resend", page: pageState(key) });
          }
          if (!store.updateComment(key, tail, feedback)) return json(res, 404, { error: "unknown comment" });
          return json(res, 200, { delivery: "unsent", page: pageState(key) });
        }

        if (action === "edit" && req.method === "POST") {
          const body = await readBody(req);
          const label = String(body.label || "Document");
          const kind = body.kind === "deleted" ? "deleted" : body.kind === "moved" ? "moved" : "edited";
          let truncated = false;
          const cap = (s) => {
            if (typeof s !== "string") return undefined;
            if (s.length <= EDIT_TEXT_CAP) return s;
            truncated = true;
            return `${s.slice(0, EDIT_TEXT_CAP)}${TRUNCATED_MARK}`;
          };
          const stagedRoot = path.join(stateDir(), "pasted", key);
          const stagedAssets = Array.isArray(body.staged_assets)
            ? body.staged_assets
                .slice(0, 20)
                .map((asset) => {
                  const id = String(asset?.id || "");
                  return {
                    id,
                    path: path.join(stagedRoot, id),
                    preview_src: String(asset?.preview_src || ""),
                  };
                })
                .filter((asset) => {
                  const relative = path.relative(stagedRoot, path.resolve(asset.path));
                  return asset.id && path.basename(asset.id) === asset.id && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(asset.path);
                })
                .map(({ path: assetPath, preview_src }) => ({ path: assetPath, preview_src }))
            : [];
          const fields = [cap(body.before), cap(body.after), cap(body.before_html), cap(body.after_html)];
          const extra = {
            ...(kind === "moved" ? { moved_after: cap(body.moved_after) || "", moved_before: cap(body.moved_before) || "" } : {}),
            ...(stagedAssets.length ? { staged_assets: stagedAssets } : {}),
            ...(truncated ? { truncated: true } : {}),
          };
          store.addEdit(key, label, kind, ...fields, extra);
          return json(res, 200, { page: pageState(key) });
        }

        // Undo of a delete or move: the block is back where it was.
        if (action === "edit" && req.method === "DELETE") {
          const body = await readBody(req);
          const kind = body.kind === "deleted" ? "deleted" : body.kind === "moved" ? "moved" : "edited";
          store.removeEdit(key, String(body.label || ""), kind);
          return json(res, 200, { page: pageState(key) });
        }

        // The SDK found the page renders itself; its edits are feedback only.
        if (action === "mode" && req.method === "POST") {
          const body = await readBody(req);
          store.setDynamic(key, !!body.dynamic);
          return json(res, 200, { page: pageState(key) });
        }

        // Leftover feedback from an earlier review the user chose not to keep.
        if (action === "discard" && req.method === "POST") {
          const page = store.page(key);
          // On a plain HTML file the edits were autosaved into it; discarding
          // them means putting the agent's version back, not just dropping rows.
          const reverted = page.kind !== "url" && !isMarkdown(page.file) && !page.dynamic && !!page.pristine;
          if (reverted) writePage(key, page.pristine);
          store.discardFeedback(key);
          for (const session of sessionsForKey(key)) emit(session, reverted ? "reload" : "refresh", reverted ? { key } : {});
          return json(res, 200, { page: pageState(key), reverted });
        }

        // File reviews keep pasted images beside the document. Localhost
        // reviews stage them privately until the agent moves them into source.
        if (action === "asset" && req.method === "POST") {
          const page = store.page(key);
          const type = String(url.searchParams.get("type") || "");
          const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[type];
          if (!ext) return json(res, 400, { error: `unsupported image type: ${type || "unknown"}` });
          const bytes = await readRawBody(req);
          if (!bytes.length) return json(res, 400, { error: "empty image" });
          const staged = page.kind === "url";
          const dir = staged ? path.join(stateDir(), "pasted", key) : path.join(path.dirname(page.file), "assets");
          fs.mkdirSync(dir, { recursive: true });
          const base = staged
            ? "localhost"
            : path
                .basename(page.file)
                .replace(/\.[^.]+$/, "")
                .replace(/[^\w-]+/g, "-");
          let name = "";
          for (let n = 1; ; n += 1) {
            name = `${base}-paste-${n}.${ext}`;
            if (!fs.existsSync(path.join(dir, name))) break;
          }
          const saved = path.join(dir, name);
          fs.writeFileSync(saved, bytes);
          return json(res, 200, {
            src: staged ? `/artifact/${viewToken}/${key}/__human_review_paste__/${name}` : `assets/${name}`,
            ...(staged ? { stagedId: name } : {}),
          });
        }

        if (action === "save" && req.method === "POST") {
          const page = store.page(key);
          // Rendered sources must never be overwritten with serialized browser HTML.
          if (page.kind === "url" || isMarkdown(page.file)) {
            return json(res, 400, { error: page.kind === "url" ? "localhost edits must be applied to app source" : "markdown pages are feedback-only" });
          }
          const body = await readBody(req);
          if (typeof body.html !== "string" || !body.html.trim()) {
            return json(res, 400, { error: "empty html" });
          }
          // A save based on an older version of the file must lose, not win:
          // otherwise a debounced autosave that lands just after an agent
          // rewrite silently overwrites the agent's work.
          if (typeof body.baseHash === "string") {
            let current = "";
            try {
              current = fs.readFileSync(page.file, "utf8");
            } catch {
              return json(res, 404, { error: "file is gone" });
            }
            if (hash(stripSdk(current)) !== body.baseHash) {
              return json(res, 409, { error: "the file changed on disk since this edit began" });
            }
          }
          try {
            const clean = writePage(key, body.html);
            return json(res, 200, { savedAt: Date.now(), hash: hash(clean) });
          } catch (err) {
            return json(res, 500, { error: String(err.message || err) });
          }
        }

        if (action === "revert" && req.method === "POST") {
          const page = store.page(key);
          if (page.kind === "url") return json(res, 400, { error: "localhost pages have no directly writable file to revert" });
          if (!page.pristine) return json(res, 400, { error: "nothing to revert to" });
          writePage(key, page.pristine);
          store.clearEdits(key);
          for (const session of sessionsForKey(key)) emit(session, "reload", { key });
          return json(res, 200, { page: pageState(key) });
        }

        if (action === "send" && req.method === "POST") {
          const body = await readBody(req);
          const result = sendBatch(body.sessionId, body.note);
          if (result.error) return json(res, 400, result);
          return json(res, 200, { ok: true, page: pageState(key) });
        }
      }

      // --- the user is done: stop the review, release the agent
      const endMatch = route.match(/^\/api\/session\/(\w+)\/end$/);
      if (endMatch && req.method === "POST") {
        const session = sessions.get(endMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        endSession(session, "ended");
        return json(res, 200, { ok: true });
      }

      // --- the tab is unloading: a reload comes right back, a close never does
      const awayMatch = route.match(/^\/api\/session\/(\w+)\/away$/);
      if (awayMatch && req.method === "POST") {
        const session = sessions.get(awayMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        scheduleAway(session);
        return json(res, 200, { ok: true });
      }

      // --- which page a window is currently showing
      const bootMatch = route.match(/^\/api\/session\/(\w+)\/page$/);
      if (bootMatch && req.method === "GET") {
        const session = sessions.get(bootMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        seen(session);
        return json(res, 200, {
          key: session.activeKey,
          page: pageState(session.activeKey, session),
          others: otherPages(session),
          artifactToken: viewToken,
          leftover: session.leftover || { comments: 0, edits: 0 },
        });
      }

      // --- jump straight to a page already in this window
      const gotoMatch = route.match(/^\/api\/session\/(\w+)\/goto$/);
      if (gotoMatch && req.method === "POST") {
        const session = sessions.get(gotoMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        seen(session);
        const body = await readBody(req);
        if (!store.page(body.key)) return json(res, 404, { error: "unknown page" });
        session.activeKey = body.key;
        session.visited.add(body.key);
        return json(res, 200, { key: body.key });
      }

      // --- navigation between local files or localhost routes in one window
      const navMatch = route.match(/^\/api\/session\/(\w+)\/navigate$/);
      if (navMatch && req.method === "POST") {
        const session = sessions.get(navMatch[1]);
        if (!session) return json(res, 404, { error: "unknown session" });
        seen(session);
        const body = await readBody(req);
        const from = store.page(session.activeKey);
        if (!from) return json(res, 404, { error: "unknown page" });
        if (from.kind === "url") {
          const nextUrl = new URL(String(body.href || ""), from.url).href;
          const target = canonicalTarget(nextUrl);
          if (target.kind !== "url") return json(res, 400, { error: "not a localhost route" });
          await fetchLocalPage(target.value);
          const page = store.openUrl(target.value);
          session.activeKey = page.key;
          session.visited.add(page.key);
          return json(res, 200, { key: page.key, page: pageState(page.key) });
        }
        const targetFile = resolveAsset(from.file, String(body.href || "").split(/[?#]/)[0]);
        if (!targetFile || !fs.existsSync(targetFile) || !/\.(x?html?|md|markdown)$/i.test(targetFile)) {
          return json(res, 400, { error: "not a local html or markdown page" });
        }
        const page = openFile(targetFile);
        watchPage(page.key);
        session.activeKey = page.key;
        session.visited.add(page.key);
        return json(res, 200, { key: page.key, page: pageState(page.key) });
      }

      // --- server-sent events for one window
      if (route.startsWith("/events/")) {
        const session = sessions.get(route.slice("/events/".length));
        if (!session) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": open\n\n");
        // The tab that said it was leaving came back (a reload).
        clearTimeout(session.awayTimer);
        session.awayTimer = null;
        session.everConnected = true;
        session.clients.add(res);
        seen(session);
        emit(session, "agent", { state: agentState(session.entryKey) });
        const beat = setInterval(() => res.write(": beat\n\n"), POLL_HEARTBEAT_MS);
        req.on("close", () => {
          clearInterval(beat);
          session.clients.delete(res);
          seen(session);
        });
        return undefined;
      }

      // --- the agent long-poll
      if (route === "/api/poll") {
        const target = url.searchParams.get("target") || url.searchParams.get("file") || "";
        const entryKey = targetKey(target);
        if (url.searchParams.get("ack") === "1") ack(entryKey);

        // Feedback first, always: a Send must reach the agent even if the tab
        // closed right after it, and even if another server wrote it.
        const pending = batches.get(entryKey) || store.batchFromDisk(entryKey);
        if (pending) {
          batches.set(entryKey, pending);
          pending.delivered = true;
          store.markDelivered(entryKey);
          broadcastAgent(entryKey);
          return json(res, 200, pending.batch);
        }

        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.write(" ");
        // One waiter per target: an older poll left behind by an earlier turn
        // would otherwise take the next batch too, and apply it twice.
        releasePollers(entryKey, SUPERSEDED);
        const set = pollers.get(entryKey) || new Set();
        pollers.set(entryKey, set);
        const poller = {
          res,
          timer: setInterval(() => res.write(" "), POLL_HEARTBEAT_MS),
          graceTimer: null,
        };
        // No review open for this target: give the browser a moment to open
        // one (an `open` that is still launching, a tab re-registering after a
        // server restart), then release the agent rather than wait forever.
        if (sessionsForEntry(entryKey).length === 0) {
          poller.graceTimer = setTimeout(() => {
            if (!set.has(poller) || sessionsForEntry(entryKey).length > 0) return;
            clearInterval(poller.timer);
            set.delete(poller);
            poller.res.end(JSON.stringify(closedPayload(entryKey, "no_review_open")));
          }, NO_REVIEW_GRACE_MS);
        }
        set.add(poller);
        broadcastAgent(entryKey);
        req.on("close", () => {
          clearInterval(poller.timer);
          clearTimeout(poller.graceTimer);
          set.delete(poller);
          broadcastAgent(entryKey);
        });
        return undefined;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    } catch (err) {
      return json(res, 500, { error: String(err.message || err) });
    }
  });

  const sweep = setInterval(() => {
    const now = Date.now();

    // A window with no SSE client for a while is gone for good — a crash, a
    // laptop that never woke — so the review ends and any waiting agent is freed.
    for (const session of [...sessions.values()]) {
      if (session.clients.size === 0 && now - session.lastSeen > SESSION_TTL_MS) endSession(session, "window_closed");
      // Opened by the CLI but no browser ever showed up: nothing to wait for.
      else if (!session.everConnected && session.clients.size === 0 && now - (session.createdAt || 0) > NEVER_OPENED_MS) endSession(session, "window_closed");
    }

    // Stop watching files no remaining session can see.
    for (const [key, entry] of watched) {
      const referenced = [...sessions.values()].some((s) => s.visited.has(key));
      if (!referenced) {
        fs.unwatchFile(entry.file);
        watched.delete(key);
        lastWritten.delete(key);
      }
    }

    // Busy means a connected browser or a listening agent — a session record
    // alone must not keep the process alive forever.
    const busy = [...sessions.values()].some((s) => s.clients.size > 0) || [...pollers.values()].some((s) => s.size > 0);
    if (!busy && now - lastActivity > IDLE_SHUTDOWN_MS) process.exit(0);
  }, 60000);
  sweep.unref();

  const dispose = () => {
    clearInterval(sweep);
    for (const entry of watched.values()) fs.unwatchFile(entry.file);
    watched.clear();
    server.close();
  };

  return { server, store, token, dispose };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1200 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
  });
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

const lockPath = () => path.join(stateDir(), "server.lock");
let holdsLock = false;

/**
 * Exactly one review server per state directory. Two CLIs racing to start
 * one would otherwise each spawn a server, and the browser tab would post
 * to one while the agent polls the other, with feedback stranded between.
 * A live server on the current protocol wins; an older one is asked to leave.
 */
async function claimServerSlot() {
  ensureStateDir();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
      holdsLock = true;
      break;
    } catch {
      let holder = 0;
      try {
        holder = Number(fs.readFileSync(lockPath(), "utf8"));
      } catch {}
      if (holder === process.pid) {
        holdsLock = true;
        break;
      }
      if (holder && pidAlive(holder)) {
        // Another process is starting or running; let it, unless it is
        // stale and never got as far as announcing itself.
        await sleep(300);
        const saved = readServerRecord();
        if (saved && saved.pid === holder) return { proceed: false };
        if (attempt < 2) continue;
        return { proceed: false };
      }
      try {
        fs.unlinkSync(lockPath());
      } catch {}
    }
  }
  if (!holdsLock) return { proceed: false };

  const saved = readServerRecord();
  if (saved && saved.pid && saved.pid !== process.pid) {
    const health = await probeHealth(saved.port);
    if (health && health.pid === saved.pid) {
      if (saved.protocol === SERVER_PROTOCOL) return { proceed: false };
      // An older server: it answered /health with its own pid, so this is
      // ours to replace. Waiting polls reconnect to the new one on their own.
      try {
        process.kill(saved.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 30 && (await probeHealth(saved.port)); i += 1) await sleep(100);
    }
  }
  return { proceed: true };
}

function releaseServerSlot() {
  if (!holdsLock) return;
  holdsLock = false;
  try {
    if (Number(fs.readFileSync(lockPath(), "utf8")) === process.pid) fs.unlinkSync(lockPath());
  } catch {}
}

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

process.on("exit", releaseServerSlot);

export async function start(port = 0) {
  const claim = await claimServerSlot();
  if (!claim.proceed) {
    const err = new Error("a human-review server is already running for this state directory");
    err.code = "EALREADY";
    throw err;
  }
  const { server, store, token, dispose } = createServer();
  return new Promise((resolve, reject) => {
    // Without this, a busy HUMAN_REVIEW_PORT dies as an uncaught exception.
    server.once("error", (err) => {
      console.error(`human-review server could not listen on port ${port}: ${err.message}`);
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      ensureStateDir();
      fs.writeFileSync(serverPath(), JSON.stringify({ port: actual, pid: process.pid, token, protocol: SERVER_PROTOCOL }));
      try {
        fs.chmodSync(serverPath(), 0o600);
      } catch {
        // Windows has no meaningful chmod; the state dir mode covers it.
      }
      resolve({ server, store, port: actual, token, dispose });
    });
  });
}
