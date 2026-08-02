/**
 * human-review artifact SDK.
 *
 * Runs inside the sandboxed iframe alongside the artifact. It owns the
 * document: editing, highlights, target resolution and serialization. It never
 * talks to the server — everything crosses to the chrome page by postMessage.
 */
import { buildContext, findQuote } from "./anchor-text.js";
import { keepBodyEditable, serializeDocument, UI_ATTR, MARK_ATTR } from "./serialize.js";

const SAVE_DEBOUNCE_MS = 700;
const EDIT_FLUSH_MS = 500;
const MEDIA = /^(img|svg|canvas|video|picture|iframe|hr|figure)$/i;

const post = (type, payload) => parent.postMessage({ ...payload, type }, "*");

let pending = null; // { id, marks } for an uncommitted highlight
let hoverTarget = null;
let saveTimer = null;
let composeOpen = false;
/** True when the page's own scripts rewrote the DOM before any user edit. */
let dynamic = false;

// ------------------------------------------------------------------ overlay

const host = document.createElement("div");
host.setAttribute(UI_ATTR, "");
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = `
  <style>
    :host { all: initial; }
    .box { position: fixed; pointer-events: none; z-index: 2147483646; border-radius: 3px; display: none; }
    .outline { border: 1px solid #c2beb4; }
    .active { border: 1px solid #1b1a16; }
    .chips {
      position: fixed; z-index: 2147483647; display: none; gap: 4px;
      pointer-events: auto;
    }
    .chip {
      width: 23px; height: 23px; display: flex;
      align-items: center; justify-content: center; padding: 0;
      border: 1px solid #e4e2db; border-radius: 50%; background: #fff; color: #6b6862;
      font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer; box-shadow: 0 2px 8px rgba(27,26,22,.14);
    }
    .chip:hover { background: #1b1a16; color: #fff; border-color: #1b1a16; }
    .chip.danger { color: #b23b2e; }
    .chip.danger:hover { background: #b23b2e; color: #fff; border-color: #b23b2e; }
    .hint {
      position: fixed; z-index: 2147483647; display: none; padding: 3px 7px;
      border-radius: 5px; background: #1b1a16; color: #fbfaf7; white-space: nowrap;
      font: 11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
  </style>
  <div class="box outline" id="outline"></div>
  <div class="box active" id="activeBox"></div>
  <div class="chips" id="chips">
    <button class="chip danger" id="chipDelete" title="Delete this block" aria-label="Delete this block">&#10005;</button>
  </div>
  <div class="hint" id="hint"></div>
`;

const els = {};
const mountOverlay = () => {
  if (!host.isConnected) document.documentElement.appendChild(host);
  els.outline = shadow.getElementById("outline");
  els.activeBox = shadow.getElementById("activeBox");
  els.chips = shadow.getElementById("chips");
  els.chipDelete = shadow.getElementById("chipDelete");
  els.hint = shadow.getElementById("hint");
};

function place(box, el, pad = 2) {
  if (!el || !el.isConnected) {
    box.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.left = `${r.left - pad}px`;
  box.style.top = `${r.top - pad}px`;
  box.style.width = `${r.width + pad * 2}px`;
  box.style.height = `${r.height + pad * 2}px`;
}

function showChip(el) {
  if (!el || !el.isConnected) {
    els.chips.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  // A target in a collapsed tab has no box; don't strand the chips in a corner.
  if (!r.width && !r.height) {
    els.chips.style.display = "none";
    return;
  }
  els.chips.style.display = "flex";
  els.chips.style.left = `${Math.max(4, r.right - 11)}px`;
  els.chips.style.top = `${Math.max(4, r.top - 11)}px`;
}

function showHint(text, x, y) {
  if (!text) {
    els.hint.style.display = "none";
    return;
  }
  els.hint.textContent = text;
  els.hint.style.display = "block";
  els.hint.style.left = `${x + 12}px`;
  els.hint.style.top = `${y + 16}px`;
}

// ------------------------------------------------------------ text plumbing

const isOurs = (node) => {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  return !!(el && el.closest && el.closest(`[${UI_ATTR}]`));
};

/** Flatten the body's text nodes into one string plus an offset map. */
function flatten() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isOurs(parent)) return NodeFilter.FILTER_REJECT;
      if (/^(script|style|noscript|template)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const map = [];
  let node = walker.nextNode();
  while (node) {
    const start = text.length;
    text += node.nodeValue;
    map.push({ node, start, end: text.length });
    node = walker.nextNode();
  }
  return { text, map };
}

function offsetsFromRange(map, range) {
  let start = null;
  let end = null;
  for (const entry of map) {
    if (entry.node === range.startContainer) start = entry.start + range.startOffset;
    if (entry.node === range.endContainer) end = entry.start + range.endOffset;
  }
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/** Wrap a global offset span in <mark> elements, one per text node touched. */
function wrapOffsets(map, start, end, id) {
  const marks = [];
  for (const entry of map) {
    if (entry.end <= start || entry.start >= end) continue;
    const from = Math.max(0, start - entry.start);
    const to = Math.min(entry.node.nodeValue.length, end - entry.start);
    if (to <= from) continue;
    const range = document.createRange();
    try {
      range.setStart(entry.node, from);
      range.setEnd(entry.node, to);
      const mark = document.createElement("mark");
      mark.setAttribute(MARK_ATTR, id);
      range.surroundContents(mark);
      marks.push(mark);
    } catch {
      // A node that shifted under us is skipped rather than corrupting the DOM.
    }
  }
  return marks;
}

function marksFor(id) {
  return [...document.querySelectorAll(`mark[${MARK_ATTR}="${CSS.escape(id)}"]`)];
}

function unwrap(id) {
  for (const mark of marksFor(id)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

// ------------------------------------------------------- target resolution

function isBlock(el) {
  if (!el || el.nodeType !== 1) return false;
  const display = getComputedStyle(el).display;
  return /^(block|flex|grid|list-item|table|flow-root)$/.test(display);
}

function hasOwnText(el) {
  return [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
}

/** A body-anchored, fully indexed path, so it resolves to one element only. */
function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 8) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(" > ");
    }
    const tag = node.tagName.toLowerCase();
    const twins = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
    parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
    node = node.parentElement;
  }
  return ["body", ...parts].join(" > ");
}

/** The heading a block sits under, used to name edits in arbitrary HTML. */
function precedingHeading(el) {
  let node = el;
  while (node && node !== document.body) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (/^h[1-6]$/i.test(sib.tagName) && sib.textContent.trim()) return sib.textContent.trim();
      const nested = sib.querySelectorAll ? sib.querySelectorAll("h1,h2,h3,h4,h5,h6") : [];
      for (let i = nested.length - 1; i >= 0; i -= 1) {
        if (nested[i].textContent.trim()) return nested[i].textContent.trim();
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return "";
}

const clip = (text, limit = 40) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

/** The block a hover/edit belongs to, plus a human label for the edit list. */
function targetFor(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el || isOurs(el)) return null;

  const authored = el.closest("[data-container],[data-block]");
  if (authored) {
    const label = authored.getAttribute("data-container") || authored.getAttribute("data-block");
    return { el: authored, label: clip(label), authored: true };
  }

  let block = el;
  while (block && block !== document.body && !isBlock(block)) block = block.parentElement;
  if (!block || block === document.body || !block.textContent.trim()) {
    if (el !== document.body && MEDIA.test(el.tagName)) block = el;
    else return null;
  }

  const heading = precedingHeading(block);
  const tag = block.tagName.toLowerCase();
  // Siblings of the same tag would otherwise share a label and collapse into
  // one edit row, so number them.
  const twins = block.parentElement ? [...block.parentElement.children].filter((c) => c.tagName === block.tagName) : [];
  const ordinal = twins.length > 1 ? ` ${twins.indexOf(block) + 1}` : "";
  const label = heading ? `${clip(heading, 26)} · ${tag}${ordinal}` : clip(block.textContent, 40) || tag;
  return { el: block, label, authored: false };
}

// ------------------------------------------------------------ serialization

const serialize = () => serializeDocument(document);

/**
 * Serialization is lossy about formatting, so a save that would not change the
 * document is skipped outright. Opening a file must never rewrite it.
 */
let baseline = null;
/** What the document looked like at boot, before any user edit. */
let bootSnapshot = null;

/**
 * Compare the live document against the file on disk (parsed the same way,
 * without running its scripts). A mismatch means the page renders itself —
 * writing the live DOM back would bake that output into the file, so saves
 * are disabled and edits travel to the agent as feedback only.
 */
function checkDynamic(diskHtml) {
  try {
    const parsed = new DOMParser().parseFromString(diskHtml, "text/html");
    if (serializeDocument(parsed) !== bootSnapshot) {
      dynamic = true;
      post("eh:dynamic", {});
    }
  } catch {
    // If the comparison itself fails, keep saving as normal.
  }
}

function emitSave() {
  if (dynamic) {
    post("eh:dynamic", {});
    return;
  }
  const html = serialize();
  if (html === baseline) {
    post("eh:clean", {});
    return;
  }
  baseline = html;
  post("eh:html", { html });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  if (!dynamic) post("eh:saving", {});
  saveTimer = setTimeout(emitSave, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  clearTimeout(saveTimer);
  flushEdits();
  emitSave();
}

// ------------------------------------------------------------- edit tracking

/**
 * One POST per keystroke would hammer the server (each save rewrites the whole
 * state file), so edits queue up and flush together. The store dedupes on
 * label+kind and only the latest `after` matters, so coalescing loses nothing.
 */
const editQueue = new Map();
let editTimer = null;

function flushEdits() {
  clearTimeout(editTimer);
  editTimer = null;
  for (const payload of editQueue.values()) post("eh:edit", payload);
  editQueue.clear();
}

function queueEdit(payload) {
  editQueue.set(`${payload.label}\u0000${payload.kind}`, payload);
  clearTimeout(editTimer);
  editTimer = setTimeout(flushEdits, EDIT_FLUSH_MS);
}

// ------------------------------------------------------------- interactions

function clearPending() {
  pending = null;
  place(els.activeBox, null);
}

/**
 * A settled selection opens the compose card but is otherwise left completely
 * alone: still selected, still editable. Nothing is written into the document
 * until the comment is actually committed, so typing or Backspace behaves
 * exactly as it would in any editable page.
 */
function settleSelection() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer)) return false;
  if (isOurs(range.commonAncestorContainer)) return false;
  const quote = sel.toString();
  if (!quote.trim()) return false;

  const { text, map } = flatten();
  const offsets = offsetsFromRange(map, range);
  if (!offsets) return false;

  const context = buildContext(text, offsets.start, offsets.end);
  pending = { kind: "selection", context };

  post("eh:compose", {
    kind: "selection",
    quote,
    anchor: { ...context, selector: cssPath(range.commonAncestorContainer.parentElement || document.body) },
  });
  return true;
}

function openElementCompose(container) {
  if (pending && pending.element === container.el) return;
  pending = { kind: "element", element: container.el };
  place(els.activeBox, container.el);
  post("eh:compose", {
    kind: "element",
    quote: container.label,
    anchor: { selector: cssPath(container.el), label: container.label },
  });
}

/** Commit turns the remembered range into real <mark> wrappers. */
function commitPending(id) {
  if (!pending) return;
  if (pending.kind === "element") {
    if (pending.element && pending.element.isConnected) pending.element.setAttribute("data-eh-el", id);
  } else {
    const { text, map } = flatten();
    const hit = findQuote(text, pending.context);
    if (hit) wrapOffsets(map, hit.start, hit.end, id);
  }
  const sel = document.getSelection();
  if (sel) sel.removeAllRanges();
  clearPending();
}

function reanchor(comments) {
  const resolved = [];
  const orphaned = [];
  for (const comment of comments) {
    if (marksFor(comment.id).length) {
      resolved.push(comment.id);
      continue;
    }
    if (comment.kind === "element") {
      const el = comment.anchor && comment.anchor.selector ? document.querySelector(comment.anchor.selector) : null;
      (el ? resolved : orphaned).push(comment.id);
      continue;
    }
    const { text, map } = flatten();
    const hit = comment.anchor ? findQuote(text, comment.anchor) : null;
    if (!hit) {
      orphaned.push(comment.id);
      continue;
    }
    const marks = wrapOffsets(map, hit.start, hit.end, comment.id);
    (marks.length ? resolved : orphaned).push(comment.id);
  }
  post("eh:anchorStatus", { resolved, orphaned });
}

function activate(id, scroll) {
  const marks = marksFor(id);
  let target = marks[0] || null;
  if (!target) {
    const el = document.querySelector(`[data-eh-el="${CSS.escape(id)}"]`);
    if (el) target = el;
  }
  for (const mark of document.querySelectorAll(`mark[${MARK_ATTR}]`)) mark.classList.remove("eh-active");
  for (const mark of marks) mark.classList.add("eh-active");
  place(els.activeBox, target);
  if (target && scroll) {
    // Reveal a target hidden inside a collapsed tab or accordion.
    let hidden = target.closest("[hidden]") || null;
    if (!hidden) {
      let probe = target.parentElement;
      while (probe && probe !== document.body) {
        if (getComputedStyle(probe).display === "none") {
          hidden = probe;
          break;
        }
        probe = probe.parentElement;
      }
    }
    if (hidden) {
      const control = hidden.id ? document.querySelector(`[aria-controls="${CSS.escape(hidden.id)}"]`) : null;
      if (control) control.click();
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      post("eh:notInView", { id });
      return;
    }
    window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: "smooth" });
  }
}

// -------------------------------------------------------------------- boot

function boot() {
  mountOverlay();

  const style = document.createElement("style");
  style.setAttribute("data-eh-sdk", "");
  style.textContent = `
    mark[${MARK_ATTR}] { background: rgba(245,196,0,.32); border-radius: 2px; color: inherit; cursor: pointer; }
    mark[${MARK_ATTR}]:hover { background: rgba(243,176,0,.5); }
    mark[${MARK_ATTR}].eh-active { background: rgba(255,180,0,.55); }
    body[contenteditable]:focus { outline: none; }
    ::selection { background: rgba(245,196,0,.42); }
  `;
  document.head.appendChild(style);

  // React/Next.js hydration may remove an attribute that was added after the
  // server rendered the page. Keep edit mode on after hydration settles so a
  // real app stays directly editable, not just its initial HTML response.
  keepBodyEditable(document.body);
  document.body.spellcheck = false;
  baseline = serialize();
  bootSnapshot = baseline;

  document.addEventListener("mouseup", (event) => {
    if (isOurs(event.target)) return;
    setTimeout(() => {
      if (settleSelection()) return;
      const target = targetFor(event.target);
      if (target) {
        openElementCompose(target);
        return;
      }
      post("eh:dismiss", {});
    }, 0);
  });

  document.addEventListener(
    "click",
    (event) => {
      if (isOurs(event.target)) return;
      const modified = event.metaKey || event.ctrlKey;
      const link = event.target.closest && event.target.closest("a[href]");

      if (modified) {
        if (link) {
          event.preventDefault();
          const href = link.getAttribute("href") || "";
          if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) post("eh:external", { href: link.href });
          else if (href.startsWith("#")) document.querySelector(href)?.scrollIntoView({ behavior: "smooth" });
          else post("eh:navigate", { href });
        }
        return; // let the artifact's own handlers run
      }

      // Plain clicks belong to editing: never navigate, never fire artifact JS.
      if (link || (event.target.closest && event.target.closest("button, [role='button'], summary"))) {
        event.preventDefault();
        event.stopPropagation();
      }
      const mark = event.target.closest && event.target.closest(`mark[${MARK_ATTR}]`);
      if (mark) post("eh:activate", { id: mark.getAttribute(MARK_ATTR) });
    },
    true
  );

  document.addEventListener("submit", (event) => {
    if (!event.metaKey && !event.ctrlKey) event.preventDefault();
  }, true);

  document.addEventListener("mouseover", (event) => {
    if (isOurs(event.target)) return;
    const target = targetFor(event.target);
    hoverTarget = target ? target.el : null;
    place(els.outline, hoverTarget);
    showChip(hoverTarget);
    const interactive = event.target.closest && event.target.closest("a[href], button, [role='button']");
    showHint(interactive ? "⌘-click to open" : "", event.clientX, event.clientY);
  });

  document.addEventListener("mouseleave", () => {
    hoverTarget = null;
    place(els.outline, null);
    showChip(null);
    showHint("");
  });

  els.chipDelete.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hoverTarget) return;
    const target = targetFor(hoverTarget);
    const label = target ? target.label : "Element";
    const before = hoverTarget.textContent;
    hoverTarget.remove();
    hoverTarget = null;
    place(els.outline, null);
    showChip(null);
    queueEdit({ label, kind: "deleted", before, after: "" });
    flushSave();
  });

  // beforeinput still sees the untouched wording, so capture it once per block.
  const originalText = new WeakMap();
  document.addEventListener(
    "beforeinput",
    (event) => {
      if (isOurs(event.target)) return;
      const sel = document.getSelection();
      const target = targetFor(sel && sel.anchorNode ? sel.anchorNode : event.target);
      if (target && !originalText.has(target.el)) originalText.set(target.el, target.el.textContent);
    },
    true
  );

  document.addEventListener("input", (event) => {
    if (isOurs(event.target)) return;
    // Typing over a selection is an edit, not a comment: retire the card.
    if (pending) {
      clearPending();
      post("eh:dismiss", {});
    }
    const sel = document.getSelection();
    const node = sel && sel.anchorNode ? sel.anchorNode : event.target;
    const target = targetFor(node);
    queueEdit({
      label: target ? target.label : "Document body",
      kind: "edited",
      before: target ? originalText.get(target.el) : undefined,
      after: target ? target.el.textContent : undefined,
    });
    scheduleSave();
  });

  const reposition = () => {
    place(els.outline, hoverTarget);
    showChip(hoverTarget);
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  let scrollQueued = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        post("eh:scroll", { x: window.scrollX, y: window.scrollY });
      });
    },
    { passive: true }
  );

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case "eh:anchors":
        reanchor(msg.comments || []);
        break;
      case "eh:commit":
        commitPending(msg.id);
        composeOpen = false;
        break;
      case "eh:cancel":
        clearPending();
        composeOpen = false;
        break;
      case "eh:composeOpen":
        composeOpen = true;
        break;
      case "eh:remove":
        unwrap(msg.id);
        document.querySelectorAll(`[data-eh-el="${CSS.escape(msg.id)}"]`).forEach((el) => el.removeAttribute("data-eh-el"));
        place(els.activeBox, null);
        break;
      case "eh:activate":
        activate(msg.id, !!msg.scroll);
        break;
      case "eh:flush":
        flushSave();
        break;
      case "eh:raw":
        checkDynamic(String(msg.html || ""));
        break;
      case "eh:feedbackOnly":
        // The chrome already knows saves must not happen (e.g. a Markdown
        // source rendered for review); no comparison needed.
        dynamic = true;
        break;
      case "eh:restoreScroll":
        window.scrollTo(msg.x || 0, msg.y || 0);
        break;
      default:
        break;
    }
  });

  post("eh:ready", { scrollHeight: document.body.scrollHeight });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
