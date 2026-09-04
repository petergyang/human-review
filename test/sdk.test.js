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

/**
 * Boot the editor SDK against a jsdom document standing in for the review
 * iframe. The SDK talks to the chrome only through parent.postMessage, and
 * jsdom's parent is the window itself, so patching postMessage captures
 * every row it reports. Each boot re-imports the module with a cache-busting
 * query so module-level state starts fresh.
 */
async function bootSdk(body) {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, {
    url: "http://127.0.0.1:4000/artifact/t/k/index.html",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const posts = [];
  window.postMessage = (message) => posts.push(JSON.parse(JSON.stringify(message)));
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
