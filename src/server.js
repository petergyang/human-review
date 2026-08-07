import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicWrite, Store, resolveAsset } from "./state.js";
import { injectSdk, stripSdk } from "./html-transform.js";
import { isMarkdown, renderMarkdownPage } from "./markdown.js";
import { canonicalTarget, ensureStateDir, localUrl, SERVER_PROTOCOL, serverPath, targetKey } from "./paths.js";
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

export function createServer() {
  const store = new Store();

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
    Object.entries(store.allBatches()).map(([key, record]) => [key, { batch: record.batch, cleanup: record.cleanup, delivered: false }])
  );
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
    const set = pollers.get(entryKey);
    if (set && set.size) return "listening";
    return pending ? "stranded" : "idle";
  }

  function broadcastAgent(entryKey) {
    const state = agentState(entryKey);
    for (const session of sessionsForEntry(entryKey)) emit(session, "agent", { state });
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
      store.setPristine(key, html);
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
    return clean;
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

  /** Every page you left feedback on ships in one batch, grouped by target. */
  function collectPages(session) {
    const out = [];
    for (const key of session.visited) {
      const page = store.page(key);
      if (!page) continue;
      if (!page.comments.length && !page.edits.length) continue;
      out.push({
        key,
        kind: page.kind === "url" ? "url" : "file",
        file: page.kind === "url" ? page.url : page.file,
        url: page.kind === "url" ? page.url : undefined,
        comments: page.comments.map((c) => ({
          id: c.id,
          kind: c.kind,
          quote: c.quote,
          anchor: c.anchor,
          feedback: c.feedback,
        })),
        edits: page.edits.map((e) => ({
          label: e.label,
          kind: e.kind,
          before: e.before,
          after: e.after,
          ...(e.before_html !== undefined && e.before_html !== e.before ? { before_html: e.before_html } : {}),
          ...(e.after_html !== undefined && e.after_html !== e.after ? { after_html: e.after_html } : {}),
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

    const pages = collectPages(session);
    if (!pages.length && !note) return { error: "nothing to send" };

    const hasMarkdown = pages.some((p) => p.kind === "file" && isMarkdown(p.file));
    const hasUrl = pages.some((p) => p.kind === "url");
    const batch = {
      status: "feedback",
      pages: pages.map(({ kind, file, url, comments, edits }) => ({ kind, file, ...(url ? { url } : {}), comments, edits })),
      overall_note: note || "",
      sent_at: new Date().toISOString(),
      next_step:
        "Apply this feedback. Each entry in `pages` names the reviewed file or localhost URL. Items under `edits` are " +
        "changes the human already made: `after` is their exact new wording, so carry it across verbatim, and " +
        "never revert it. When an edit carries `after_html`, the human changed formatting (bold, italic, links) — " +
        "use the HTML version, translated into the source's own syntax. " +
        (hasMarkdown
          ? "Markdown pages were reviewed rendered, so quotes and `after` wording use the rendered text — apply " +
            "the change to the Markdown source, keeping its formatting syntax. "
          : "") +
        (hasUrl
          ? "Localhost pages were edited directly in the review UI. Find the matching project source (such as MDX or TSX) " +
            "and apply every exact edit or deletion there; never try to write the rendered HTML response back to the app. "
          : "") +
        "When every page is updated, run the same poll command again with --ack to clear this " +
        "batch and wait for more.",
    };

    const record = {
      batch,
      delivered: false,
      cleanup: pages.map((p) => ({ key: p.key, ids: p.comments.map((c) => c.id), sentAt: Date.now() })),
    };
    batches.set(session.entryKey, record);
    store.setBatch(session.entryKey, record);
    record.delivered = deliver(session.entryKey, batch);
    broadcastAgent(session.entryKey);
    return { ok: true };
  }

  function ack(entryKey) {
    const pending = batches.get(entryKey);
    // Only a delivered batch can be acknowledged. An agent whose previous poll
    // timed out re-runs `poll --ack`; if feedback arrived in between, that ack
    // refers to an older batch and must not destroy the one it never saw.
    if (!pending || !pending.delivered) return false;
    batches.delete(entryKey);
    store.clearBatch(entryKey);
    for (const { key, ids, sentAt } of pending.cleanup) store.clearSent(key, ids, sentAt);
    for (const session of sessionsForEntry(entryKey)) emit(session, "refresh", {});
    // File targets reload through fs.watch. URL targets have no source file to
    // watch, so acknowledgement is the signal to fetch the rebuilt route.
    for (const { key } of pending.cleanup) {
      if (store.page(key)?.kind === "url") {
        for (const session of sessionsForKey(key)) emit(session, "reload", { key });
      }
    }
    broadcastAgent(entryKey);
    return true;
  }

  /**
   * A deliberate stop, not a tab close: the browser forgets the session and
   * any waiting agent is released with a clear "stop polling" answer instead
   * of being left to burn its timeout. Unsent feedback stays in the store.
   */
  function endSession(session) {
    sessions.delete(session.id);
    for (const res of session.clients) {
      res.write(`event: ended\ndata: {}\n\n`);
      res.end();
    }
    session.clients.clear();
    // Another window on the same target keeps its agent connection alive.
    if (sessionsForEntry(session.entryKey).length > 0) return;
    const set = pollers.get(session.entryKey);
    if (!set) return;
    for (const poller of [...set]) {
      clearInterval(poller.timer);
      set.delete(poller);
      poller.res.end(
        JSON.stringify({
          status: "closed",
          next_step:
            "The user ended this review session. Stop polling — do not run the poll command again. " +
            "Any unsent feedback is kept and will ship the next time this target is reviewed.",
        })
      );
    }
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
      pollCommand: `${invocation()} poll ${shellQuote(pollTarget)}`,
    };
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
      if (route === "/chrome.css") return serveFile(res, path.join(here, "chrome.css"));
      if (route === "/chrome.js") return serveFile(res, path.join(here, "chrome-client.js"), CORS);
      if (route === "/chrome-session.js") return serveFile(res, path.join(here, "chrome-session.js"), CORS);
      if (route === "/sdk.js") return serveFile(res, path.join(here, "sdk.js"), CORS);
      if (route === "/editing.js") return serveFile(res, path.join(here, "editing.js"), CORS);
      if (route === "/anchor-text.js") return serveFile(res, path.join(here, "anchor-text.js"), CORS);
      if (route === "/frame-policy.js") return serveFile(res, path.join(here, "frame-policy.js"), CORS);
      if (route === "/click-target.js") return serveFile(res, path.join(here, "click-target.js"), CORS);
      if (route === "/serialize.js") return serveFile(res, path.join(here, "serialize.js"), CORS);

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
          const html = fs.readFileSync(target.value, "utf8");
          page = store.openPage(target.value, stripSdk(html));
          lastWritten.set(page.key, hash(stripSdk(html)));
        }
        watchPage(page.key);
        const id = uid("s");
        sessions.set(id, { id, entryKey: page.key, activeKey: page.key, visited: new Set([page.key]), clients: new Set(), lastSeen: Date.now() });
        return json(res, 200, { sessionId: id, key: page.key, path: `/s/${id}` });
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

      // --- the reviewed page itself, plus sibling assets for file targets
      if (route.startsWith("/artifact/")) {
        const rest = route.slice("/artifact/".length);
        const slash = rest.indexOf("/");
        const key = slash === -1 ? rest : rest.slice(0, slash);
        const asset = slash === -1 ? "" : rest.slice(slash + 1);
        const page = store.page(key);
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
          res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
          return res.end(injectSdk(html, key, sdkOptions));
        }
        if (page.kind === "url") {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("Localhost assets load from the reviewed development server.");
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
        const pending = batches.get(entryKey);
        const listening = (pollers.get(entryKey) || new Set()).size > 0;
        // Unsent feedback lives on every page reachable from this entry.
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
        return json(res, 200, {
          status: pending ? "feedback-waiting" : "idle",
          feedback_waiting: !!pending,
          agent_listening: listening,
          server_running: true,
          unsent: { comments, edits },
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
          if (!store.updateComment(key, tail, feedback)) return json(res, 404, { error: "unknown comment" });
          return json(res, 200, { page: pageState(key) });
        }

        if (action === "edit" && req.method === "POST") {
          const body = await readBody(req);
          const label = String(body.label || "Document");
          const kind = body.kind === "deleted" ? "deleted" : "edited";
          const cap = (s) => (typeof s === "string" ? s.slice(0, 4000) : undefined);
          store.addEdit(key, label, kind, cap(body.before), cap(body.after), cap(body.before_html), cap(body.after_html));
          return json(res, 200, { page: pageState(key) });
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
        endSession(session);
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
        const html = fs.readFileSync(targetFile, "utf8");
        const page = store.openPage(targetFile, stripSdk(html));
        lastWritten.set(page.key, hash(stripSdk(html)));
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

        const pending = batches.get(entryKey);
        if (pending) {
          pending.delivered = true;
          broadcastAgent(entryKey);
          return json(res, 200, pending.batch);
        }

        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.write(" ");
        const set = pollers.get(entryKey) || new Set();
        pollers.set(entryKey, set);
        const poller = {
          res,
          timer: setInterval(() => res.write(" "), POLL_HEARTBEAT_MS),
        };
        set.add(poller);
        broadcastAgent(entryKey);
        req.on("close", () => {
          clearInterval(poller.timer);
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

    // A window with no SSE client for a while is closed; forget its session.
    for (const [id, session] of sessions) {
      if (session.clients.size === 0 && now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
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

export function start(port = 0) {
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
