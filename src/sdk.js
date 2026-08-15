/**
 * human-review artifact SDK.
 *
 * Runs inside the sandboxed iframe alongside the artifact. It owns the
 * document: editing, highlights, target resolution and serialization. It never
 * talks to the server — everything crosses to the chrome page by postMessage.
 */
import { buildContext, findQuote } from "./anchor-text.js";
import { hashClickAction, navigationHref } from "./click-target.js";
import { linkStyleFixup, listCommandFor, listStyleFixup, normalizeHref } from "./editing.js";
import { keepBodyEditable, serializeDocument, UI_ATTR, MARK_ATTR } from "./serialize.js";

const SAVE_DEBOUNCE_MS = 700;
const EDIT_FLUSH_MS = 500;
const MEDIA = /^(img|svg|canvas|video|picture|iframe|hr|figure)$/i;

// The chrome page lives on the other loopback hostname (a separate origin, so
// the reviewed document can never touch it directly). Address it explicitly so
// nothing we post can be read by any other embedder.
const CHROME_ORIGIN = `${location.protocol}//${location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"}:${location.port}`;

const post = (type, payload) => parent.postMessage({ ...payload, type }, CHROME_ORIGIN);

let pending = null; // { id, marks } for an uncommitted highlight
let hoverTarget = null;
let hoverMove = null; // the innermost block under the cursor, movable via the handle
let hoverMedia = null; // the img/video under the cursor, resizable via the grip
let resizing = null; // live drag state while the grip is held
let suppressUntil = 0; // ignore the mouseup/click that ends a resize drag
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
    .chips .chip, .mover { opacity: .6; transition: opacity 100ms ease; }
    .chips .chip:hover, .chips .chip:focus-visible, .mover:hover, .mover:focus-visible { opacity: 1; }
    .grip {
      position: fixed; z-index: 2147483647; width: 13px; height: 13px;
      display: none; border: 1px solid #1b1a16; border-radius: 3px;
      background: #fff; cursor: nwse-resize; pointer-events: auto;
      box-shadow: 0 1px 4px rgba(27,26,22,.2);
    }
    .hint {
      position: fixed; z-index: 2147483647; display: none; padding: 3px 7px;
      border-radius: 5px; background: #1b1a16; color: #fbfaf7; white-space: nowrap;
      font: 11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
    .linkbox {
      position: fixed; z-index: 2147483647; display: none; gap: 4px; align-items: center;
      padding: 5px; border: 1px solid #e4e2db; border-radius: 9px; background: #fff;
      box-shadow: 0 4px 16px rgba(27,26,22,.16); pointer-events: auto;
    }
    .linkbox input {
      width: 224px; padding: 4px 7px; border: none; outline: none; background: none;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1b1a16;
    }
    .linkbox input::placeholder { color: #a29f95; }
    .mover {
      position: fixed; z-index: 2147483647; width: 18px; height: 24px;
      display: none; align-items: center; justify-content: center;
      border: 1px solid #e4e2db; border-radius: 6px; background: #fff; color: #a29f95;
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: grab; pointer-events: auto; user-select: none;
      box-shadow: 0 2px 8px rgba(27,26,22,.14);
    }
    .mover:hover { color: #1b1a16; border-color: #c2beb4; }
    .mover:active { cursor: grabbing; }
    .dropline {
      position: fixed; z-index: 2147483646; height: 0; display: none;
      border-top: 2px solid #1b1a16; border-radius: 1px; pointer-events: none;
    }
  </style>
  <div class="box outline" id="outline"></div>
  <div class="box active" id="activeBox"></div>
  <div class="chips" id="chips">
    <button class="chip danger" id="chipDelete" title="Delete this block" aria-label="Delete this block">&#10005;</button>
  </div>
  <div class="grip" id="grip" title="Drag to resize"></div>
  <div class="hint" id="hint"></div>
  <div class="linkbox" id="linkbox">
    <input id="linkInput" type="text" placeholder="Link to&hellip;" spellcheck="false">
    <button class="chip" id="linkApply" title="Apply link (&#9166;)" aria-label="Apply link">&#8629;</button>
    <button class="chip danger" id="linkRemove" title="Remove link" aria-label="Remove link">&#10005;</button>
  </div>
  <div class="mover" id="mover" title="Drag to move this block">&#10303;</div>
  <div class="dropline" id="dropline"></div>
`;

const els = {};
const mountOverlay = () => {
  if (!host.isConnected) document.documentElement.appendChild(host);
  els.outline = shadow.getElementById("outline");
  els.activeBox = shadow.getElementById("activeBox");
  els.chips = shadow.getElementById("chips");
  els.chipDelete = shadow.getElementById("chipDelete");
  els.grip = shadow.getElementById("grip");
  els.hint = shadow.getElementById("hint");
  els.linkbox = shadow.getElementById("linkbox");
  els.linkInput = shadow.getElementById("linkInput");
  els.linkApply = shadow.getElementById("linkApply");
  els.linkRemove = shadow.getElementById("linkRemove");
  els.mover = shadow.getElementById("mover");
  els.dropline = shadow.getElementById("dropline");
};

function showMover(el) {
  if (!el || !el.isConnected) {
    els.mover.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    els.mover.style.display = "none";
    return;
  }
  els.mover.style.display = "flex";
  // Half-overlap the block's edge: the pointer can travel from text to handle
  // without ever leaving the block, so the hover state never drops.
  els.mover.style.left = `${Math.max(4, r.left - 9)}px`;
  els.mover.style.top = `${Math.max(4, r.top + 1)}px`;
}

function showDropline(drop) {
  if (!drop || !drop.ref.isConnected) {
    els.dropline.style.display = "none";
    return;
  }
  const r = drop.ref.getBoundingClientRect();
  els.dropline.style.display = "block";
  els.dropline.style.left = `${r.left}px`;
  els.dropline.style.width = `${r.width}px`;
  els.dropline.style.top = `${(drop.before ? r.top : r.bottom) - 1}px`;
}

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

function showGrip(el) {
  if (!el || !el.isConnected) {
    els.grip.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    els.grip.style.display = "none";
    return;
  }
  els.grip.style.display = "block";
  els.grip.style.left = `${r.right - 7}px`;
  els.grip.style.top = `${r.bottom - 7}px`;
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

/**
 * A block's label is pinned the first time it is computed. Labels derived
 * from the block's own text or position would drift as the user types or
 * deletes siblings, splitting one block's edit into several contradictory
 * rows keyed on each intermediate wording.
 */
const pinnedLabels = new WeakMap();

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

  if (!pinnedLabels.has(block)) {
    const heading = precedingHeading(block);
    const tag = block.tagName.toLowerCase();
    // Siblings of the same tag would otherwise share a label and collapse into
    // one edit row, so number them.
    const twins = block.parentElement ? [...block.parentElement.children].filter((c) => c.tagName === block.tagName) : [];
    const ordinal = twins.length > 1 ? ` ${twins.indexOf(block) + 1}` : "";
    pinnedLabels.set(block, heading ? `${clip(heading, 26)} · ${tag}${ordinal}` : clip(block.textContent, 40) || tag);
  }
  return { el: block, label: pinnedLabels.get(block), authored: false };
}

/**
 * The nearest rendered block around a node, ignoring authored data-block
 * containers. List conversion and drop targeting need the line the caret is
 * actually on, not the labeled region it reports edits under.
 */
function innermostBlock(node) {
  let el = node && node.nodeType === 1 ? node : node && node.parentElement;
  while (el && el !== document.body && !isBlock(el)) el = el.parentElement;
  return el && el !== document.body ? el : null;
}

/**
 * After a list command: hoist the fresh list out of the paragraph Chrome
 * sometimes nests it in (invalid HTML that a reparse would restructure), and
 * make sure the page's CSS reset can't hide it.
 */
function polishNewList(sel) {
  const node = sel && sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const item = el && el.closest ? el.closest("li") : null;
  const list = item ? item.closest("ul, ol") : null;
  if (!list) return;
  const wrap = list.parentElement;
  if (wrap && /^(p|h[1-6])$/i.test(wrap.tagName) && wrap.childNodes.length === 1) {
    wrap.replaceWith(list);
  }
  const patch = listStyleFixup(list.tagName, getComputedStyle(list));
  if (patch.listStyleType) list.style.listStyleType = patch.listStyleType;
  if (patch.paddingLeft) list.style.paddingLeft = patch.paddingLeft;
}

/** The caret position a drag at (x, y) would drop into. */
function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    return range;
  }
  return null;
}

// ------------------------------------------------------------ serialization

const serialize = () => serializeDocument(document);

/**
 * A single block's HTML with every review artifact removed. outerHTML, not
 * innerHTML: changes to the block's own attributes (an image's new width, for
 * one) live on the element itself, and a void element has no inner markup.
 */
function blockHtml(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(`[${UI_ATTR}]`).forEach((n) => n.remove());
  clone.querySelectorAll(`mark[${MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  clone.querySelectorAll("[data-eh-el]").forEach((n) => n.removeAttribute("data-eh-el"));
  clone.removeAttribute("data-eh-el");
  clone.normalize();
  return clone.outerHTML;
}

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
    if (serializeDocument(parsed) !== bootSnapshot) markDynamic();
  } catch {
    // If the comparison itself fails, keep saving as normal.
  }
}

function markDynamic() {
  if (dynamic) return;
  dynamic = true;
  clearTimeout(saveTimer);
  post("eh:dynamic", {});
}

/** True once the user has actually edited, as opposed to the page's own scripts. */
let userEdited = false;

/**
 * The boot comparison only catches scripts that rewrote the DOM before this
 * module ran. Pages that render on load or after a fetch (charts, mermaid,
 * client-rendered apps) mutate later — watch for any serialization drift that
 * happens before the first real user edit and treat it the same way.
 */
function watchSelfRendering() {
  const observer = new MutationObserver(() => {
    if (dynamic || userEdited) {
      observer.disconnect();
      return;
    }
    if (serialize() !== bootSnapshot) {
      observer.disconnect();
      markDynamic();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
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
  const key = `${payload.label}\u0000${payload.kind}`;
  const queued = editQueue.get(key);
  if (queued && (queued.staged_assets || payload.staged_assets)) {
    const assets = [...(queued.staged_assets || []), ...(payload.staged_assets || [])];
    payload.staged_assets = [...new Map(assets.map((asset) => [asset.path || asset.id, asset])).values()];
  }
  editQueue.set(key, payload);
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
      // Re-stamp the marker, or "Jump to" has nothing to find after a reload.
      if (el) el.setAttribute("data-eh-el", comment.id);
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
    // scrollIntoView walks every scrollable ancestor, so targets inside an
    // app's inner scroll container are reached too, not just window-scrolled ones.
    target.scrollIntoView({ block: "center", behavior: "smooth" });
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
  watchSelfRendering();

  document.addEventListener("mouseup", (event) => {
    if (isOurs(event.target) || resizing || Date.now() < suppressUntil) return;
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
      const href = navigationHref(event.target);

      if (modified) {
        if (href) {
          event.preventDefault();
          event.stopPropagation();
          if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) post("eh:external", { href: new URL(href, document.baseURI).href });
          else if (href.startsWith("#")) {
            const action = hashClickAction(href, location.hash);
            if (action.kind === "scroll") {
              const el = document.getElementById(action.id) || document.getElementsByName(action.id)[0] || document.body;
              el.scrollIntoView({ behavior: "smooth" });
            } else {
              location.hash = action.hash;
            }
          }
          else {
            // This document is about to be torn down: anything still sitting in
            // the debounce windows must ship first or it is lost. Message order
            // is guaranteed, so the edits land before the navigation does.
            flushSave();
            post("eh:navigate", { href });
          }
        }
        return; // let the artifact's own handlers run
      }

      // Plain clicks belong to editing: never navigate, never fire artifact JS.
      if (href || (event.target.closest && event.target.closest("button, [role='button'], summary"))) {
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
    if (isOurs(event.target) || resizing || moving) return;
    const target = targetFor(event.target);
    hoverTarget = target ? target.el : null;
    // The move handle works per element, not per labeled container, so each
    // paragraph inside a card can travel on its own.
    hoverMove = hoverTarget ? innermostBlock(event.target) || hoverTarget : null;
    hoverMedia = event.target.closest ? event.target.closest("img, video") : null;
    place(els.outline, hoverTarget);
    if (controlsAreSuppressed()) hideActionControls();
    else {
      showChip(hoverTarget);
      showMover(hoverMove);
    }
    showGrip(hoverMedia);
    const interactive = event.target.closest && event.target.closest("a[href], [data-href], button, [role='button']");
    const draggable = hoverMedia && hoverMedia.tagName === "IMG";
    showHint(interactive ? "⌘-click to open" : draggable ? "Drag to move" : "", event.clientX, event.clientY);
  });

  document.addEventListener("mouseleave", () => {
    if (resizing || moving) return;
    hoverTarget = null;
    hoverMove = null;
    hoverMedia = null;
    place(els.outline, null);
    showChip(null);
    showMover(null);
    showGrip(null);
    showHint("");
  });

  // ------------------------------------------------------------ image resize

  els.grip.addEventListener("pointerdown", (event) => {
    if (!hoverMedia || !hoverMedia.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    // From here on, DOM changes are the human resizing, not the page rendering.
    userEdited = true;
    const target = targetFor(hoverMedia);
    const blockEl = target ? target.el : hoverMedia;
    resizing = {
      el: hoverMedia,
      startX: event.clientX,
      startWidth: hoverMedia.getBoundingClientRect().width,
      label: target ? target.label : "Image",
      blockEl,
      beforeText: blockEl.textContent,
      beforeHtml: blockHtml(blockEl),
    };
    if (els.grip.setPointerCapture) els.grip.setPointerCapture(event.pointerId);
  });

  window.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    event.preventDefault();
    const width = Math.max(24, Math.round(resizing.startWidth + (event.clientX - resizing.startX)));
    resizing.el.style.width = `${width}px`;
    resizing.el.style.height = "auto";
    place(els.outline, hoverTarget);
    showGrip(resizing.el);
  });

  window.addEventListener("pointerup", () => {
    if (!resizing) return;
    const { blockEl, label, beforeText, beforeHtml } = resizing;
    resizing = null;
    suppressUntil = Date.now() + 250;
    queueEdit({
      label,
      kind: "edited",
      before: beforeText,
      after: blockEl.textContent,
      before_html: beforeHtml,
      after_html: blockHtml(blockEl),
    });
    scheduleSave();
  });

  els.chipDelete.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!hoverTarget) return;
    userEdited = true;
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
  const originalHtml = new WeakMap();
  const captureOriginal = (el) => {
    if (!originalText.has(el)) {
      originalText.set(el, el.textContent);
      originalHtml.set(el, blockHtml(el));
    }
  };

  /** An edit row for a block changed outside the input-event flow (attribute
   * set, link removal, drag move) — the same shape the input listener emits. */
  const emitBlockEdit = (blockEl, fallbackLabel, extra = {}) => {
    const connected = blockEl.isConnected;
    const target = connected ? targetFor(blockEl) : null;
    queueEdit({
      label: (target && target.label) || fallbackLabel || "Document body",
      kind: "edited",
      before: originalText.get(blockEl),
      after: connected ? blockEl.textContent : "",
      before_html: originalHtml.get(blockEl),
      after_html: connected ? blockHtml(blockEl) : "",
      ...extra,
    });
  };

  let typingUntil = 0;
  let controlRestoreTimer = null;

  const selectionIsActive = () => {
    const sel = document.getSelection();
    return !!(sel && !sel.isCollapsed && sel.rangeCount && document.body.contains(sel.getRangeAt(0).commonAncestorContainer));
  };

  const controlsAreSuppressed = () => Date.now() < typingUntil || selectionIsActive();

  const hideActionControls = () => {
    showChip(null);
    showMover(null);
  };

  const restoreActionControls = () => {
    if (controlsAreSuppressed()) return;
    showChip(hoverTarget);
    showMover(hoverMove);
  };

  const suppressActionControlsWhileTyping = () => {
    typingUntil = Date.now() + 800;
    hideActionControls();
    clearTimeout(controlRestoreTimer);
    controlRestoreTimer = setTimeout(restoreActionControls, 810);
  };
  document.addEventListener(
    "beforeinput",
    (event) => {
      if (isOurs(event.target)) return;
      suppressActionControlsWhileTyping();
      // From here on, DOM drift is the human typing, not the page rendering.
      userEdited = true;
      const sel = document.getSelection();
      const target = targetFor(sel && sel.anchorNode ? sel.anchorNode : event.target);
      if (target) captureOriginal(target.el);
    },
    true
  );

  document.addEventListener("selectionchange", () => {
    if (selectionIsActive()) hideActionControls();
    else restoreActionControls();
  });

  // ------------------------------------------------------------------ links

  let linkState = null; // { range, anchor, blockEl, label } while the ⌘K popup is open

  function closeLinkbox(restoreSelection) {
    if (!linkState) return;
    const { range } = linkState;
    linkState = null;
    els.linkbox.style.display = "none";
    if (restoreSelection && range) {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.body.focus({ preventScroll: true });
    }
  }

  function openLinkbox() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return false;
    let range = sel.getRangeAt(0).cloneRange();
    const container = range.commonAncestorContainer;
    if (!document.body.contains(container) || isOurs(container)) return false;

    const caretEl = container.nodeType === 1 ? container : container.parentElement;
    const anchor = caretEl && caretEl.closest ? caretEl.closest("a") : null;
    if (sel.isCollapsed) {
      // A bare caret can only mean "edit the link I'm inside".
      if (!anchor) return false;
      range = document.createRange();
      range.selectNodeContents(anchor);
    }
    const target = targetFor(anchor || container);
    linkState = {
      range,
      anchor,
      blockEl: target ? target.el : null,
      label: target ? target.label : "Document body",
    };
    if (linkState.blockEl) captureOriginal(linkState.blockEl);

    // The compose card and the link popup fight over the same selection.
    clearPending();
    post("eh:dismiss", {});

    const r = range.getBoundingClientRect();
    const below = r.bottom + 44 < window.innerHeight;
    els.linkbox.style.display = "flex";
    els.linkbox.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 320))}px`;
    els.linkbox.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - 44)}px`;
    els.linkRemove.style.display = anchor ? "" : "none";
    els.linkInput.value = anchor ? anchor.getAttribute("href") || "" : "";
    els.linkInput.focus();
    els.linkInput.select();
    return true;
  }

  function applyLink() {
    if (!linkState) return;
    const href = normalizeHref(els.linkInput.value);
    const { range, anchor, blockEl, label } = linkState;
    if (!href) {
      // Nothing typed → dismiss. Something unusable typed → stay open so the
      // input isn't silently thrown away.
      if (!els.linkInput.value.trim()) closeLinkbox(true);
      else els.linkInput.select();
      return;
    }
    userEdited = true;
    linkState = null;
    els.linkbox.style.display = "none";
    if (anchor && anchor.isConnected) {
      // Editing an existing link never rewraps — just retarget it.
      anchor.setAttribute("href", href);
      if (blockEl) emitBlockEdit(blockEl, label);
    } else {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.body.focus({ preventScroll: true });
      document.execCommand("createLink", false, href);
      // On pages that reset anchor styling the new link looks like plain
      // prose — underline it so the user sees that it took.
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const created = el && el.closest ? el.closest("a") : null;
      if (created) {
        const patch = linkStyleFixup(
          getComputedStyle(created),
          created.parentElement ? getComputedStyle(created.parentElement) : null
        );
        if (patch.textDecoration) created.style.textDecoration = patch.textDecoration;
      }
    }
    scheduleSave();
  }

  function removeLink() {
    if (!linkState) return;
    const { anchor, blockEl, label } = linkState;
    linkState = null;
    els.linkbox.style.display = "none";
    if (!anchor || !anchor.isConnected) return;
    userEdited = true;
    const parent = anchor.parentNode;
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    parent.removeChild(anchor);
    parent.normalize();
    if (blockEl) emitBlockEdit(blockEl, label);
    scheduleSave();
  }

  els.linkInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLinkbox(true);
    }
  });
  els.linkApply.addEventListener("click", applyLink);
  els.linkRemove.addEventListener("click", removeLink);

  // A click anywhere in the page means the popup lost the argument.
  document.addEventListener("pointerdown", (event) => {
    if (linkState && !isOurs(event.target)) closeLinkbox(false);
  });

  // ------------------------------------------------------------------ lists

  // execCommand mutations fire `input` (so edit rows and saves flow as usual)
  // but not `beforeinput`, so originals are captured here by hand.
  document.addEventListener(
    "keydown",
    (event) => {
      if (isOurs(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      const sel = document.getSelection();
      const anchor = sel ? sel.anchorNode : null;

      // ⌘K links the selection, like Docs, Word, and Notion.
      if (meta && !event.shiftKey && !event.altKey && (event.key === "k" || event.key === "K")) {
        if (openLinkbox()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && linkState) {
        closeLinkbox(true);
        return;
      }

      // ⌘⇧8 bulleted, ⌘⇧7 numbered — the shortcuts people know from Docs.
      if (meta && event.shiftKey && (event.code === "Digit7" || event.code === "Digit8")) {
        const target = targetFor(anchor || event.target);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        userEdited = true;
        captureOriginal(target.el);
        document.execCommand(event.code === "Digit7" ? "insertOrderedList" : "insertUnorderedList");
        polishNewList(document.getSelection());
        scheduleSave();
        return;
      }

      // Tab indents and Shift+Tab outdents inside a list, instead of leaving the page.
      if (event.key === "Tab" && anchor) {
        const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        const item = el && el.closest ? el.closest("li") : null;
        if (!item || isOurs(item)) return;
        event.preventDefault();
        event.stopPropagation();
        userEdited = true;
        const target = targetFor(item);
        if (target) captureOriginal(target.el);
        document.execCommand(event.shiftKey ? "outdent" : "indent");
        polishNewList(document.getSelection());
        scheduleSave();
        return;
      }

      // "- ", "* ", "1. ", or "1) " at the start of a line becomes a list.
      // Only the text between the block's start and the caret matters, so this
      // works inside authored data-block containers and in front of existing
      // text — not just in blocks that hold nothing but the marker.
      if (event.key === " " && sel && sel.isCollapsed && anchor) {
        const host = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        if (!host || host.closest("li, ul, ol")) return;
        const block = innermostBlock(anchor);
        // isBlock matches display:table but not table-cell, so a caret in a
        // table's first cell resolves the whole table — never convert that.
        if (block && /^(table|thead|tbody|tfoot|tr)$/i.test(block.tagName)) return;
        const lead = document.createRange();
        // Inline content directly under <body> (a bare text node beside an
        // image, say) has no block; the caret's own node is the line then.
        if (block) lead.selectNodeContents(block);
        else lead.setStart(anchor, 0);
        try {
          lead.setEnd(sel.anchorNode, sel.anchorOffset);
        } catch {
          return;
        }
        const command = listCommandFor(lead.toString());
        if (!command) return;
        const target = targetFor(anchor);
        event.preventDefault();
        event.stopPropagation();
        userEdited = true;
        if (target) captureOriginal(target.el);
        sel.removeAllRanges();
        sel.addRange(lead);
        document.execCommand("delete");
        document.execCommand(command);
        polishNewList(document.getSelection());
        scheduleSave();
      }
    },
    true
  );

  // ------------------------------------------------------------- image drag

  // Chromium moves an image dropped inside contenteditable on its own; this
  // code only aims the drop (indicator outline), blocks payloads that have
  // nowhere to go (files from the desktop), and writes the edit rows for the
  // block the image left and the block it landed in.
  let dragging = null; // { el, fromBlock, fromLabel, overBlock, dropped } during an image drag

  document.addEventListener("dragstart", (event) => {
    const img = event.target && event.target.nodeType === 1 && event.target.tagName === "IMG" ? event.target : null;
    if (!img || isOurs(img)) return;
    const target = targetFor(img);
    if (target) captureOriginal(target.el);
    dragging = {
      el: img,
      src: img.src,
      // The rendered size often comes from the container being left behind
      // (figure/card CSS); remember it so the move can't balloon the image.
      width: img.getBoundingClientRect().width,
      fromBlock: target ? target.el : null,
      fromLabel: target ? target.label : "Image",
      overBlock: null,
      dropped: false,
    };
  });

  document.addEventListener("dragover", (event) => {
    if (!dragging) {
      // External payloads would navigate the frame or paste file:// markup.
      if (event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      }
      return;
    }
    const range = caretRangeAt(event.clientX, event.clientY);
    const block = range ? innermostBlock(range.startContainer) : null;
    if (block && !isOurs(block)) {
      captureOriginal(block);
      dragging.overBlock = block;
    }
    place(els.outline, block && !isOurs(block) ? block : null);
  });

  const finalizeImageDrag = () => {
    const drag = dragging;
    if (!drag || !drag.dropped) return;
    dragging = null;
    place(els.outline, null);
    // Chrome re-inserts a copy on drop, so find the landed image by source,
    // then pin it to the size it had before the move — an image dragged out
    // of the container that was constraining it would otherwise render at
    // its natural size.
    let landed = drag.el.isConnected ? drag.el : null;
    if (!landed && drag.overBlock && drag.overBlock.isConnected) {
      landed = [...drag.overBlock.querySelectorAll("img")].find((i) => i.src === drag.src) || null;
    }
    if (landed && drag.width && Math.abs(landed.getBoundingClientRect().width - drag.width) > 1) {
      landed.style.width = `${Math.round(drag.width)}px`;
      landed.style.height = "auto";
      landed.style.maxWidth = "100%";
    }
    const rows = new Map();
    if (drag.fromBlock) rows.set(drag.fromBlock, drag.fromLabel);
    if (drag.overBlock && !rows.has(drag.overBlock)) rows.set(drag.overBlock, null);
    for (const [block, label] of rows) emitBlockEdit(block, label);
    scheduleSave();
  };

  document.addEventListener("drop", (event) => {
    if (dragging) {
      // The move itself is the drop's default action, so the edit rows can
      // only be read after it has run.
      userEdited = true;
      dragging.dropped = true;
      setTimeout(finalizeImageDrag, 0);
      return;
    }
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) event.preventDefault();
  });

  document.addEventListener("dragend", () => {
    // A cancelled drag (Esc, or dropped outside the page) still needs cleanup.
    if (dragging && !dragging.dropped) {
      dragging = null;
      place(els.outline, null);
    }
  });

  // ------------------------------------------------------------- block moves

  // The handle on a block's left edge moves the whole block. Pointer-based,
  // not HTML5 drag: the element is relocated on drop, never cloned, so
  // identity (labels, captured originals, comment anchors) survives the move.
  let moving = null; // { el, label, drop: { ref, before } | null } while the handle is held

  const dropPointFor = (x, y) => {
    const under = document.elementFromPoint(x, y);
    if (!under || isOurs(under)) return null;
    const block = innermostBlock(under);
    if (!block || block === moving.el || moving.el.contains(block)) return null;
    const r = block.getBoundingClientRect();
    return { ref: block, before: y < r.top + r.height / 2 };
  };

  els.mover.addEventListener("pointerdown", (event) => {
    const el = hoverMove && hoverMove.isConnected ? hoverMove : hoverTarget;
    if (!el || !el.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    const target = targetFor(el);
    moving = { el, label: target ? target.label : "Block", drop: null };
    captureOriginal(moving.el);
    moving.el.style.opacity = "0.4";
    place(els.outline, null);
    showChip(null);
    try {
      els.mover.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners track the move even without capture.
    }
  });

  window.addEventListener("pointermove", (event) => {
    if (!moving) return;
    event.preventDefault();
    moving.drop = dropPointFor(event.clientX, event.clientY);
    showDropline(moving.drop);
  });

  window.addEventListener("pointerup", () => {
    if (!moving) return;
    const { el, label, drop } = moving;
    moving = null;
    showDropline(null);
    showMover(null);
    el.style.opacity = "";
    suppressUntil = Date.now() + 250;
    if (!drop || !drop.ref.isConnected || !el.isConnected) return;
    // Dropping right back where it came from is a no-op, not an edit.
    const next = drop.before ? drop.ref : drop.ref.nextElementSibling;
    if (next === el || (drop.before ? drop.ref.previousElementSibling : drop.ref) === el) return;
    userEdited = true;
    drop.ref.parentNode.insertBefore(el, next);
    const prev = el.previousElementSibling;
    const following = el.nextElementSibling;
    queueEdit({
      label,
      kind: "moved",
      before: originalText.get(el),
      after: el.textContent,
      before_html: originalHtml.get(el),
      after_html: blockHtml(el),
      moved_after: prev ? clip(prev.textContent, 90) : "",
      moved_before: following ? clip(following.textContent, 90) : "",
    });
    flushSave();
  });

  // ------------------------------------------------------------- image paste

  // Pasted images cross to the chrome page as bytes; the server writes them
  // into assets/ next to the reviewed file and the confirmed relative path
  // comes back to be inserted where the caret was.
  let pasteSeq = 0;
  const pendingPastes = new Map(); // id → collapsed caret range to insert at

  document.addEventListener(
    "paste",
    (event) => {
      if (isOurs(event.target)) return;
      const items = event.clipboardData ? [...event.clipboardData.items] : [];
      const images = items.filter((item) => item.kind === "file" && /^image\//.test(item.type));
      if (!images.length) return;
      event.preventDefault();
      event.stopPropagation();
      const sel = document.getSelection();
      const caret = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      for (const item of images) {
        const file = item.getAsFile();
        if (!file) continue;
        pasteSeq += 1;
        const id = `paste_${pasteSeq}`;
        pendingPastes.set(id, caret);
        file.arrayBuffer().then((bytes) => post("eh:asset", { id, assetType: file.type, bytes }));
      }
    },
    true
  );

  const insertPastedImage = (id, src, stagedId) => {
    const caret = pendingPastes.get(id);
    pendingPastes.delete(id);
    userEdited = true;
    const img = document.createElement("img");
    img.setAttribute("src", src);
    img.style.maxWidth = "100%";
    const anchored = caret && caret.startContainer && document.body.contains(caret.startContainer) && !isOurs(caret.startContainer);
    if (anchored) {
      const target = targetFor(caret.startContainer);
      if (target) captureOriginal(target.el);
      caret.collapse(false);
      caret.insertNode(img);
    } else {
      document.body.appendChild(img);
    }
    const landed = targetFor(img);
    emitBlockEdit(landed ? landed.el : img, landed ? landed.label : "Pasted image", {
      ...(stagedId ? { staged_assets: [{ id: stagedId, preview_src: src }] } : {}),
    });
    flushSave();
  };

  document.addEventListener("input", (event) => {
    if (isOurs(event.target)) return;
    // A drop fires deleteByDrag/insertFromDrop input events whose selection
    // points anywhere; finalizeImageDrag writes the real rows instead.
    if (dragging) return;
    // Typing over a selection is an edit, not a comment: retire the card.
    if (pending) {
      clearPending();
      post("eh:dismiss", {});
    }
    const sel = document.getSelection();
    const node = sel && sel.anchorNode ? sel.anchorNode : event.target;
    const target = targetFor(node);
    // Text alone loses formatting-only edits (bold, italic, underline change
    // markup, not textContent), so the block's cleaned HTML travels too.
    queueEdit({
      label: target ? target.label : "Document body",
      kind: "edited",
      before: target ? originalText.get(target.el) : undefined,
      after: target ? target.el.textContent : undefined,
      before_html: target ? originalHtml.get(target.el) : undefined,
      after_html: target ? blockHtml(target.el) : undefined,
    });
    scheduleSave();
  });

  const reposition = () => {
    place(els.outline, hoverTarget);
    showChip(hoverTarget);
    showMover(moving ? null : hoverMove);
    showGrip(resizing ? resizing.el : hoverMedia);
    // The popup is viewport-fixed; scrolled away from its text it just lies.
    if (linkState) closeLinkbox(false);
  };
  // getBoundingClientRect on every scroll event forces layout mid-scroll;
  // one reposition per frame is plenty.
  let repositionQueued = false;
  const scheduleReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      reposition();
    });
  };
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);

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
    // Only the chrome page may drive the SDK — not popups the artifact opened,
    // and not the artifact's own scripts.
    if (event.source !== window.parent || event.origin !== CHROME_ORIGIN) return;
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
        // Posted after the flushed eh:edit/eh:html messages, so when the
        // chrome sees it, everything pending has already been handed over.
        post("eh:flushed", {});
        break;
      case "eh:abortSave":
        // A revert is in flight: anything queued would re-write the edits.
        clearTimeout(saveTimer);
        clearTimeout(editTimer);
        editQueue.clear();
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
      case "eh:assetSaved":
        insertPastedImage(msg.id, String(msg.src || ""), String(msg.stagedId || ""));
        break;
      case "eh:assetFailed":
        pendingPastes.delete(msg.id);
        break;
      default:
        break;
    }
  });

  post("eh:ready", { scrollHeight: document.body.scrollHeight });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
