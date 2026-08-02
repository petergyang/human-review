/**
 * human-review chrome. Owns the rail UI and every call to the local server.
 * It never touches the artifact DOM directly — the SDK does that, over
 * postMessage, because the artifact iframe is sandboxed to a null origin.
 */
import { tidy } from "./anchor-text.js";

const $ = (id) => document.getElementById(id);
const frame = $("frame");

const state = {
  sessionId: document.body.dataset.session,
  token: document.body.dataset.token,
  key: null,
  page: null,
  compose: null,
  active: null,
  agent: "idle",
  save: "idle",
  savedAt: "",
  sent: false,
  orphans: new Set(),
  pollCommand: "",
  editsExpanded: false,
  others: [],
  scroll: { x: 0, y: 0 },
  reloading: false,
  dynamic: false,
};

// ------------------------------------------------------------------- server

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-human-review-token": state.token, ...(options && options.headers) },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const toFrame = (message) => frame.contentWindow && frame.contentWindow.postMessage(message, "*");

async function loadPage(key, { reload = true } = {}) {
  state.key = key;
  state.page = await api(`/api/page/${key}?session=${state.sessionId}`);
  state.others = state.page.others || [];
  state.orphans = new Set();
  state.compose = null;
  state.active = null;
  state.sent = false;
  state.dynamic = false;
  if (reload) {
    state.reloading = true;
    frame.src = `/artifact/${key}/index.html`;
  }
  render();
}

// -------------------------------------------------------------------- clock

function ago(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// -------------------------------------------------------------------- render

function render() {
  const page = state.page;
  if (!page) return;

  const comments = page.comments || [];
  const edits = page.edits || [];

  $("count").textContent = String(comments.length);
  $("empty").hidden = comments.length > 0 || !!state.compose;

  // --- compose
  const composeWrap = $("compose");
  if (state.compose) {
    composeWrap.hidden = false;
    $("composeKind").textContent = state.compose.kind === "element" ? "Element" : "Selection";
    $("composeQuote").textContent = tidy(state.compose.quote, 260);
  } else {
    composeWrap.hidden = true;
    $("composeText").value = "";
  }

  // --- comment cards
  const list = $("cards");
  list.textContent = "";
  for (const comment of comments) {
    const card = document.createElement("div");
    card.className = `comment${state.active === comment.id ? " active" : ""}`;
    card.dataset.id = comment.id;

    const head = document.createElement("div");
    head.className = "comment-head";

    const who = document.createElement("span");
    who.className = "who";
    who.append("You");
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "·";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = ago(comment.createdAt);
    who.append(sep, when);

    if (state.orphans.has(comment.id)) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "orphaned";
      who.append(badge);
    }

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "jump";
    jump.textContent = "Jump to";
    jump.addEventListener("click", (event) => {
      event.stopPropagation();
      setActive(comment.id, true);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.title = "Delete comment";
    remove.setAttribute("aria-label", "Delete comment");
    remove.textContent = "✕";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      toFrame({ type: "eh:remove", id: comment.id });
      state.page = (await api(`/api/page/${state.key}/comment/${comment.id}`, { method: "DELETE" })).page;
      render();
    });

    head.append(who, jump, remove);

    const quote = document.createElement("p");
    quote.className = "quote";
    quote.textContent = tidy(comment.quote, 140);

    const body = document.createElement("p");
    body.className = "body";
    body.textContent = comment.feedback;

    card.append(head, quote, body);
    card.addEventListener("click", () => setActive(comment.id, false));
    list.append(card);
  }

  // --- your edits
  const box = $("editsBox");
  box.hidden = edits.length === 0;
  if (edits.length) {
    $("editCount").textContent = String(edits.length);
    const rows = $("editList");
    rows.textContent = "";
    const LIMIT = 5;
    const shown = state.editsExpanded ? edits : edits.slice(0, LIMIT);
    for (const edit of shown) {
      const row = document.createElement("div");
      row.className = `edit-row${edit.kind === "deleted" ? " deleted" : ""}`;
      const pip = document.createElement("span");
      pip.className = "pip";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = edit.label;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = edit.kind;
      row.append(pip, label, kind);
      rows.append(row);
    }
    if (edits.length > LIMIT) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "edit-more";
      more.textContent = state.editsExpanded ? "Show fewer" : `${edits.length - LIMIT} more…`;
      more.addEventListener("click", () => {
        state.editsExpanded = !state.editsExpanded;
        render();
      });
      rows.append(more);
    }
    renderSave();
  }

  // --- pages you left feedback on but are not looking at
  const others = state.others || [];
  const othersBox = $("othersBox");
  othersBox.hidden = others.length === 0;
  if (others.length) {
    $("othersCount").textContent = String(others.length);
    const list = $("othersList");
    list.textContent = "";
    for (const other of others) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "edit-row other-row";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = other.filename;
      const count = document.createElement("span");
      count.className = "kind";
      count.textContent = String(other.count);
      row.append(label, count);
      row.addEventListener("click", async () => {
        await api(`/api/session/${state.sessionId}/goto`, {
          method: "POST",
          body: JSON.stringify({ key: other.key }),
        });
        state.scroll = { x: 0, y: 0 };
        await loadPage(other.key);
      });
      list.append(row);
    }
  }

  // --- send
  const otherTotal = others.reduce((sum, o) => sum + o.count, 0);
  const total = comments.length + edits.length + otherTotal;
  const send = $("send");
  const delivered = state.agent === "working";
  const stranded = state.agent === "stranded";
  const busy = delivered || stranded || state.sent;
  send.disabled = total === 0 || busy;
  send.textContent = delivered
    ? "Feedback delivered"
    : stranded
      ? "Sent — agent is not listening"
      : state.sent
        ? "Sent — waiting for agent"
        : total
          ? `Send ${total} to agent`
          : "Nothing to send yet";
  if (!send.disabled) {
    const key = document.createElement("span");
    key.className = "key";
    key.textContent = "⌘⏎";
    send.append(" ", key);
  }

  // After sending, say what happens next. If nothing is polling, the loop would
  // otherwise dead-end silently, so hand over the exact command to run.
  $("agentLine").hidden = !delivered;
  $("agentText").textContent = "Feedback delivered — page reloads when fixes land";

  // Server-authoritative, so it survives a browser refresh.
  $("handoff").hidden = !stranded;
  if (stranded) $("handoffCmd").textContent = state.pollCommand || page.pollCommand || "";
}

function renderSave() {
  const line = $("saveLine");
  if (state.page && state.page.kind === "url") {
    line.className = "save-line dynamic";
    $("saveText").textContent = "Localhost page — your direct edits go to the agent for source updates";
    return;
  }
  if (state.page && state.page.markdown) {
    line.className = "save-line dynamic";
    $("saveText").textContent = "Markdown source — edits go to the agent as feedback";
    return;
  }
  if (state.dynamic) {
    // The page's own scripts render it, so writing the live DOM back would
    // corrupt the file. Edits still reach the agent as feedback.
    line.className = "save-line dynamic";
    $("saveText").textContent = "Live page — edits go to the agent, the file is left alone";
    return;
  }
  line.className = `save-line ${state.save === "saving" ? "saving" : state.save === "failed" ? "failed" : ""}`;
  const name = state.page ? state.page.filename : "";
  if (state.save === "saving") $("saveText").textContent = `Saving to ${name}…`;
  else if (state.save === "failed") $("saveText").textContent = "Couldn't save — retrying…";
  else $("saveText").textContent = state.savedAt ? `Saved to ${name} · ${state.savedAt}` : `Saved to ${name}`;
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

function setActive(id, scroll) {
  state.active = id;
  toFrame({ type: "eh:activate", id, scroll: !!scroll });
  render();
}

// ------------------------------------------------------------------ compose

/**
 * The card deliberately does not steal focus. The selection stays live in the
 * document so you can type over it or delete it; click the card when you want
 * to comment on it instead.
 */
async function openCompose(detail) {
  if (state.compose && $("composeText").value.trim()) await commitCompose();
  state.compose = detail;
  render();
  toFrame({ type: "eh:composeOpen" });
  $("composeText").value = "";
}

function cancelCompose() {
  if (!state.compose) return;
  state.compose = null;
  toFrame({ type: "eh:cancel" });
  render();
}

async function commitCompose() {
  const compose = state.compose;
  const feedback = $("composeText").value.trim();
  if (!compose || !feedback) return;
  const result = await api(`/api/page/${state.key}/comment`, {
    method: "POST",
    body: JSON.stringify({ kind: compose.kind, quote: compose.quote, anchor: compose.anchor, feedback }),
  });
  toFrame({ type: "eh:commit", id: result.comment.id });
  state.compose = null;
  state.page = result.page;
  state.active = result.comment.id;
  state.sent = false;
  render();
}

// -------------------------------------------------------------------- saving

let retryTimer = null;
let lastHtml = null;

async function saveHtml(html) {
  lastHtml = html;
  try {
    await api(`/api/page/${state.key}/save`, { method: "POST", body: JSON.stringify({ html }) });
    state.save = "saved";
    state.savedAt = clock();
    clearTimeout(retryTimer);
  } catch {
    state.save = "failed";
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => saveHtml(lastHtml), 2000);
  }
  renderSave();
}

// ------------------------------------------------------------ frame messages

window.addEventListener("message", async (event) => {
  if (!frame.contentWindow || event.source !== frame.contentWindow) return;
  const msg = event.data || {};

  switch (msg.type) {
    case "eh:ready": {
      toFrame({ type: "eh:anchors", comments: state.page ? state.page.comments : [] });
      if (state.reloading) {
        toFrame({ type: "eh:restoreScroll", x: state.scroll.x, y: state.scroll.y });
        state.reloading = false;
      }
      if (state.page && (state.page.markdown || state.page.feedbackOnly)) {
        // Rendered sources are editable here but never serialized over their source.
        toFrame({ type: "eh:feedbackOnly" });
      } else {
        // Hand the SDK the on-disk HTML so it can spot self-rendering pages.
        api(`/api/page/${state.key}/raw`)
          .then((raw) => toFrame({ type: "eh:raw", html: raw.html }))
          .catch(() => {});
      }
      break;
    }
    case "eh:compose":
      await openCompose({ kind: msg.kind, quote: msg.quote, anchor: msg.anchor });
      break;
    case "eh:dismiss":
      if (!$("composeText").value.trim()) cancelCompose();
      break;
    case "eh:activate":
      setActive(msg.id, false);
      break;
    case "eh:anchorStatus":
      state.orphans = new Set(msg.orphaned || []);
      render();
      break;
    case "eh:notInView":
      toast("That comment is not visible in this view");
      break;
    case "eh:edit":
      state.page = (await api(`/api/page/${state.key}/edit`, {
        method: "POST",
        body: JSON.stringify({ label: msg.label, kind: msg.kind, before: msg.before, after: msg.after }),
      })).page;
      state.sent = false;
      render();
      break;
    case "eh:saving":
      state.save = "saving";
      renderSave();
      break;
    case "eh:html":
      await saveHtml(msg.html);
      break;
    case "eh:clean":
      // Serialization matched what is already on disk; nothing to write.
      state.save = state.savedAt ? "saved" : "idle";
      renderSave();
      break;
    case "eh:dynamic":
      state.dynamic = true;
      renderSave();
      break;
    case "eh:scroll":
      state.scroll = { x: msg.x, y: msg.y };
      break;
    case "eh:external":
      window.open(msg.href, "_blank", "noopener");
      break;
    case "eh:navigate":
      try {
        const result = await api(`/api/session/${state.sessionId}/navigate`, {
          method: "POST",
          body: JSON.stringify({ href: msg.href }),
        });
        state.scroll = { x: 0, y: 0 };
        await loadPage(result.key);
      } catch (err) {
        toast(err.message);
      }
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------- rail wiring

$("composeAdd").addEventListener("click", commitCompose);
$("composeCancel").addEventListener("click", cancelCompose);

// Clicking anywhere on the card is the "I meant to comment" gesture.
$("compose").addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) return;
  event.preventDefault();
  $("composeText").focus();
});

$("composeText").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    commitCompose();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelCompose();
  }
});

$("send").addEventListener("click", async () => {
  try {
    await api(`/api/page/${state.key}/send`, {
      method: "POST",
      body: JSON.stringify({ sessionId: state.sessionId, note: $("note").value.trim() }),
    });
    $("note").value = "";
    state.sent = true;
    render();
  } catch (err) {
    toast(err.message);
  }
});

$("revert").addEventListener("click", async () => {
  const count = state.page.edits.length;
  if (!window.confirm(`Discard all ${count} of your edits?`)) return;
  try {
    state.page = (await api(`/api/page/${state.key}/revert`, { method: "POST" })).page;
    state.save = "idle";
    state.savedAt = "";
    render();
  } catch (err) {
    toast(err.message);
  }
});

$("handoffCopy").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText($("handoffCmd").textContent);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy command";
    }, 1600);
  } catch {
    toast("Couldn't copy — select the command and copy it manually");
  }
});

$("note").addEventListener("input", (event) => {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
});

$("handle").addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("collapsed");
  const handle = $("handle");
  handle.textContent = collapsed ? "‹" : "›";
  handle.title = collapsed ? "Show comments panel" : "Hide comments panel";
  handle.setAttribute("aria-label", handle.title);
  try {
    localStorage.setItem("human-review:collapsed", collapsed ? "1" : "0");
  } catch {}
});

$("theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  applyTheme(dark);
  try {
    localStorage.setItem("human-review:theme", dark ? "dark" : "light");
  } catch {}
});

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const button = $("theme");
  button.textContent = dark ? "☀" : "☾";
  button.title = dark ? "Switch chrome to light" : "Switch chrome to dark";
  button.setAttribute("aria-label", button.title);
}

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key === "Enter") {
    event.preventDefault();
    if (!$("send").disabled) $("send").click();
    return;
  }
  // ⌘S is reassurance only: flush pending keystrokes, never a state change.
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    toFrame({ type: "eh:flush" });
    renderSave();
    return;
  }
  if (event.key === "Escape" && state.compose) cancelCompose();
});

// ------------------------------------------------------------------ events

function connect() {
  const source = new EventSource(`/events/${state.sessionId}`);
  source.addEventListener("reload", () => {
    const hadEdits = state.page ? state.page.edits.length : 0;
    state.reloading = true;
    state.dynamic = false;
    frame.src = `/artifact/${state.key}/index.html?t=${Date.now()}`;
    api(`/api/page/${state.key}`).then((page) => {
      state.page = page;
      state.save = "idle";
      state.savedAt = "";
      render();
      // The agent's version wins, so say so rather than losing the rows silently.
      if (hadEdits && page.edits.length === 0) {
        toast(`Agent rewrote ${hadEdits} ${hadEdits === 1 ? "block" : "blocks"} you had edited`);
      }
    });
  });
  source.addEventListener("agent", (event) => {
    state.agent = JSON.parse(event.data).state;
    render();
  });
  source.addEventListener("refresh", async () => {
    state.page = await api(`/api/page/${state.key}`);
    state.sent = false;
    render();
  });
  source.onerror = () => {
    /* EventSource reconnects on its own. */
  };
}

// -------------------------------------------------------------------- start

(async function start() {
  try {
    applyTheme(localStorage.getItem("human-review:theme") === "dark");
    if (localStorage.getItem("human-review:collapsed") === "1") $("handle").click();
  } catch {}

  const bootstrap = await api(`/api/session/${state.sessionId}/page`).catch(() => null);
  if (bootstrap && bootstrap.page) state.pollCommand = bootstrap.page.pollCommand;
  const key = bootstrap ? bootstrap.key : new URLSearchParams(location.search).get("key");
  await loadPage(key);
  connect();
})();
