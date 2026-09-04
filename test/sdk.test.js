import test from "node:test";
import assert from "node:assert/strict";

// jsdom (a dev dependency) needs Node 22+; the library itself supports Node 20.
let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}
const skip = JSDOM ? false : "jsdom unavailable on this Node version";

const CHROME_ORIGIN = "http://localhost:4000";
let seq = 0;
/** The most recent boot, so its pending timers can be flushed before the next one takes the globals. */
let current = null;

/**
 * Boot the editor SDK against a jsdom document standing in for the review
 * iframe. The SDK talks to the chrome only through parent.postMessage, and
 * jsdom's parent is the window itself, so patching postMessage captures
 * every row it reports. Each boot re-imports the module with a cache-busting
 * query so module-level state starts fresh.
 */
async function bootSdk(body) {
  // Every instance posts through the global `parent`. An edit still sitting in
  // a previous instance's flush timer would land in this test's capture, so
  // drain it while the old window is still the global one.
  if (current) {
    current.fromChrome({ type: "eh:flush" });
    current = null;
  }
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, {
    url: "http://127.0.0.1:4000/artifact/t/k/index.html",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const posts = [];
  window.postMessage = (message) => posts.push(JSON.parse(JSON.stringify(message)));
  // jsdom has no layout: give Range the geometry the link popup asks for.
  if (!window.Range.prototype.getBoundingClientRect) {
    const zero = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
    window.Range.prototype.getBoundingClientRect = zero;
    window.Range.prototype.getClientRects = () => [];
  }
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (value) => String(value).replace(/[^\w-]/g, (c) => `\\${c}`);
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name === "undefined" || name in globalThis) continue;
    try {
      globalThis[name] = window[name];
    } catch {}
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    parent: window,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    CSS: window.CSS,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
  });
  seq += 1;
  await import(`../src/sdk.js?boot=${seq}`);
  const fromChrome = (data) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: CHROME_ORIGIN, source: window }));
  const shadow = window.document.querySelector("[data-eh-ui]").shadowRoot;
  current = { fromChrome };
  return { window, document: window.document, posts, fromChrome, shadow };
}

const rows = (posts) => posts.filter((m) => m.type === "eh:edit").map(({ label, kind, before, after }) => ({ label, kind, before, after }));

test("deleting a block reports it, offers undo, and undo restores it", { skip }, async () => {
  const { document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>Keep me.</p><p>Delete me.</p><p>Closing.</p>");
  const target = document.querySelectorAll("p")[1];
  target.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();

  assert.equal(document.querySelectorAll("p").length, 2);
  assert.deepEqual(rows(posts), [{ label: "Plan · p 2", kind: "deleted", before: "Delete me.", after: "" }]);
  assert.ok(posts.some((m) => m.type === "eh:undoable" && m.kind === "deleted" && m.label === "Plan · p 2"));
  assert.ok(posts.some((m) => m.type === "eh:html"), "the file is rewritten without the block");

  fromChrome({ type: "eh:undo", label: "Plan · p 2", kind: "deleted" });
  const texts = [...document.querySelectorAll("p")].map((p) => p.textContent);
  assert.deepEqual(texts, ["Keep me.", "Delete me.", "Closing."], "the block is back where it was");
  assert.ok(posts.some((m) => m.type === "eh:undone" && m.label === "Plan · p 2"), "the chrome is told so it can drop the row");

  // Nothing left to restore under that label: the chrome hears that too.
  fromChrome({ type: "eh:undo", label: "Plan · p 2", kind: "deleted" });
  assert.ok(posts.some((m) => m.type === "eh:undoFailed"));
});

test("older deletes stay restorable, and ⌘Z undoes the latest one unless typing came after", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p><p>Three.</p>");
  const [one, two, three] = document.querySelectorAll("p");
  for (const p of [one, two]) {
    p.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    shadow.getElementById("chipDelete").click();
  }
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["Three."]);

  // The first deletion, not the most recent, restores from the edit list.
  fromChrome({ type: "eh:undo", label: "Plan · p 1", kind: "deleted" });
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Three."]);

  // ⌘Z right after the remaining deletion brings the second one back.
  document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two.", "Three."]);

  // After typing, ⌘Z is the browser's own undo again: nothing of ours moves.
  three.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  one.dispatchEvent(new window.Event("input", { bubbles: true }));
  const zed = new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(zed);
  assert.equal(zed.defaultPrevented, false);
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two."]);
  assert.equal(posts.filter((m) => m.type === "eh:undone").length, 2);
});

test("typing over a selection that spans blocks reports every block it touched", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Goals</h2><p>First goal paragraph.</p><p>Second goal paragraph.</p>");
  const [first, second] = document.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(first.firstChild, 6);
  range.setEnd(second.firstChild, 7);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  first.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  // What the browser does for a keystroke over that selection: the first
  // block absorbs the remainder of the second, which disappears.
  first.textContent = "First Xgoal paragraph.";
  second.remove();
  first.dispatchEvent(new window.Event("input", { bubbles: true }));
  fromChrome({ type: "eh:flush" });

  assert.deepEqual(rows(posts), [
    { label: "Goals · p 1", kind: "edited", before: "First goal paragraph.", after: "First Xgoal paragraph." },
    { label: "Goals · p 2", kind: "deleted", before: "Second goal paragraph.", after: "" },
  ]);
});

test("a keyboard selection opens the compose card when the key is released", { skip }, async () => {
  const { window, document, posts } = await bootSdk("<h1>Plan</h1><p>Select these words with the keyboard.</p>");
  const p = document.querySelector("p");
  const range = document.createRange();
  range.setStart(p.firstChild, 7);
  range.setEnd(p.firstChild, 12);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
  p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const compose = posts.filter((m) => m.type === "eh:compose");
  assert.equal(compose.length, 1, "one card for the settled selection, not one per keystroke");
  assert.equal(compose[0].kind, "selection");
  assert.equal(compose[0].quote, "these");
});

test("labels number siblings by their order at load, so a deletion does not renumber the rest", { skip }, async () => {
  const { document, posts, shadow } = await bootSdk("<h2>Goals</h2><p>One.</p><p>Two.</p><p>Three.</p>");
  const paragraphs = document.querySelectorAll("p");
  paragraphs[1].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  paragraphs[2].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  assert.deepEqual(
    rows(posts).map((r) => r.label),
    ["Goals · p 2", "Goals · p 3"],
    "the third paragraph keeps its number after the second is gone"
  );
});

/**
 * jsdom has no execCommand. This stand-in does what Chrome does for the two
 * commands the list paths use: delete the selection, and turn the block the
 * caret is in into a list item. It fires the input event Chrome fires too.
 */
function installExecCommand(window) {
  window.document.execCommand = (command) => {
    const document = window.document;
    const sel = window.getSelection();
    if (command === "delete") {
      if (sel.rangeCount) sel.getRangeAt(0).deleteContents();
      document.body.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    }
    if (command === "insertUnorderedList" || command === "insertOrderedList") {
      let node = sel.anchorNode;
      let block = node && (node.nodeType === 1 ? node : node.parentElement);
      while (block && block !== document.body && !/^(p|div|h[1-6])$/i.test(block.tagName)) block = block.parentElement;
      if (!block || block === document.body) return false;
      const list = document.createElement(command === "insertOrderedList" ? "ol" : "ul");
      const item = document.createElement("li");
      while (block.firstChild) item.appendChild(block.firstChild);
      list.appendChild(item);
      block.replaceWith(list);
      const range = document.createRange();
      range.selectNodeContents(item);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      item.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    }
    return false;
  };
}

test("typing a list marker turns the paragraph into a list under the paragraph's own label", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Goals</h2><p>-Ship it.</p>");
  installExecCommand(window);
  const p = document.querySelector("p");
  const range = document.createRange();
  range.setStart(p.firstChild, 1);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const space = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  p.dispatchEvent(space);
  assert.equal(space.defaultPrevented, true, "the marker keystroke is consumed");
  assert.equal(document.querySelector("ul li").textContent, "Ship it.");
  fromChrome({ type: "eh:flush" });
  assert.deepEqual(rows(posts), [{ label: "Goals · p", kind: "edited", before: "-Ship it.", after: "Ship it." }]);
  const row = posts.find((m) => m.type === "eh:edit");
  assert.match(row.after_html, /^<li>Ship it\.<\/li>$/);
});

test("⌘K on an existing link retargets it, and Remove unwraps it, each as one edit row", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk('<h2>Links</h2><p>Read <a href="https://old.example">the spec</a> first.</p>');
  const anchor = document.querySelector("a");
  const caret = document.createRange();
  caret.setStart(anchor.firstChild, 2);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);

  const k = new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
  anchor.dispatchEvent(k);
  assert.equal(k.defaultPrevented, true);
  const input = shadow.getElementById("linkInput");
  assert.equal(input.value, "https://old.example", "the popup opens on the link's current target");
  input.value = "new.example/spec";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(anchor.getAttribute("href"), "https://new.example/spec", "a bare domain gets a scheme");
  fromChrome({ type: "eh:flush" });
  assert.deepEqual(rows(posts), [{ label: "Links · p", kind: "edited", before: "Read the spec first.", after: "Read the spec first." }]);
  assert.match(posts.find((m) => m.type === "eh:edit").after_html, /href="https:\/\/new\.example\/spec"/);

  posts.length = 0;
  sel.removeAllRanges();
  sel.addRange(caret);
  anchor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
  shadow.getElementById("linkRemove").click();
  assert.equal(document.querySelector("a"), null, "the link is gone, its text stays");
  assert.equal(document.querySelector("p").textContent, "Read the spec first.");
  fromChrome({ type: "eh:flush" });
  const removed = posts.find((m) => m.type === "eh:edit");
  assert.equal(removed.after_html, "<p>Read the spec first.</p>");
});

test("a pasted image lands at the caret once the chrome confirms where it was saved", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Design</h2><p>Before the image.</p>");
  const p = document.querySelector("p");
  const caret = document.createRange();
  caret.setStart(p.firstChild, p.firstChild.length);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);

  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => ({ type: "image/png", arrayBuffer: async () => new ArrayBuffer(4) }) }] },
  });
  p.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true, "the SDK owns image pastes");
  for (let i = 0; i < 50 && !posts.some((m) => m.type === "eh:asset"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const asset = posts.find((m) => m.type === "eh:asset");
  assert.ok(asset, "the bytes go to the chrome to be saved");
  assert.equal(asset.assetType, "image/png");

  fromChrome({ type: "eh:assetSaved", id: asset.id, src: "assets/design-paste-1.png" });
  const img = document.querySelector("p img");
  assert.ok(img, "the image is inserted at the caret");
  assert.equal(img.getAttribute("src"), "assets/design-paste-1.png");
  const row = posts.find((m) => m.type === "eh:edit");
  assert.equal(row.label, "Design · p");
  assert.equal(row.before, "Before the image.");
  assert.match(row.after_html, /<img src="assets\/design-paste-1\.png"/);
});
