import test from "node:test";
import assert from "node:assert/strict";
import { hasSdk, injectSdk, stripSdk } from "../src/html-transform.js";

const PAGE = `<!DOCTYPE html>
<html><head><title>Spec</title></head>
<body>
<h1>Hello</h1>
</body></html>`;

const LOCALHOST_PAGE = `<!DOCTYPE html>
<html><head><title>Spec</title><link rel="stylesheet" href="/_next/app.css"></head>
<body><a href="/wiki/lesson">Lesson</a><img src="./hero.png"><script src="/_next/app.js"></script></body></html>`;

test("injectSdk adds exactly one script before </body>", () => {
  const out = injectSdk(PAGE, "abc123");
  const tags = out.match(/<script[^>]*data-eh-sdk/g) || [];
  assert.equal(tags.length, 1);
  assert.ok(out.indexOf("data-eh-sdk") < out.indexOf("</body>"));
  assert.ok(out.includes('src="/sdk.js?key=abc123"'));
});

test("injectSdk gives only its trusted script the supplied nonce", () => {
  const page = '<!DOCTYPE html><html><body><script>parent.postMessage({type:"eh:html"}, "*")</script></body></html>';
  const out = injectSdk(page, "abc123", { nonce: "one-time-permission" });
  assert.match(out, /<script data-eh-sdk type="module" nonce="one-time-permission" src="\/sdk\.js\?key=abc123"><\/script>/);
  assert.equal((out.match(/nonce="one-time-permission"/g) || []).length, 1);
  assert.match(out, /<script>parent\.postMessage/, "the authored script remains in the source representation");
  assert.equal(stripSdk(out), page, "saving restores the original script bytes");
});

test("injecting twice never stacks tags", () => {
  const once = injectSdk(PAGE, "abc123");
  const twice = injectSdk(once, "abc123");
  assert.equal((twice.match(/data-eh-sdk/g) || []).length, 1);
});

test("stripSdk restores the original bytes", () => {
  assert.equal(stripSdk(injectSdk(PAGE, "k")), PAGE);
});

test("a saved file never keeps the injected tag", () => {
  const saved = stripSdk(injectSdk(PAGE, "k"));
  assert.equal(hasSdk(saved), false);
  assert.ok(!saved.includes("sdk.js"));
});

test("fragments without a body still get the script", () => {
  const out = injectSdk("<h1>bare</h1>", "k");
  assert.ok(hasSdk(out));
  assert.equal(stripSdk(out).trim(), "<h1>bare</h1>");
});

test("a page with only </html> gets the script before it", () => {
  const out = injectSdk("<html><h1>x</h1></html>", "k");
  assert.ok(out.indexOf("data-eh-sdk") < out.indexOf("</html>"));
});

test("localhost pages get absolute assets, their real route, and one sdk", () => {
  const options = {
    src: "http://127.0.0.1:4444/sdk.js?key=k",
    baseHref: "http://localhost:3000/wiki?view=course#lesson",
  };
  const once = injectSdk(LOCALHOST_PAGE, "k", options);
  const twice = injectSdk(once, "k", options);
  assert.equal((twice.match(/<base[^>]*data-eh-sdk/g) || []).length, 0);
  assert.equal((twice.match(/<script[^>]*data-eh-sdk/g) || []).length, 1);
  assert.equal((twice.match(/<script[^>]*data-eh-route/g) || []).length, 1);
  assert.ok(twice.includes('history.replaceState(null,"",location.origin+"/wiki?view=course#lesson")'));
  assert.ok(twice.indexOf("data-eh-route") < twice.indexOf("<title>"));
  assert.ok(twice.includes('href="http://localhost:3000/_next/app.css"'));
  assert.ok(twice.includes('src="http://localhost:3000/_next/app.js"'));
  assert.ok(twice.includes('src="http://localhost:3000/hero.png"'));
  assert.ok(twice.includes('<a href="/wiki/lesson">'));
  assert.ok(twice.includes('src="http://127.0.0.1:4444/sdk.js?key=k"'));
  assert.ok(!stripSdk(twice).includes("data-eh-route"));
});

test("a script containing the literal '</body>' does not fool injection", () => {
  const page = '<!DOCTYPE html><html><body><script>const tpl = "</body>";</script><p>x</p></body></html>';
  const out = injectSdk(page, "k");
  assert.ok(out.indexOf("data-eh-sdk") > out.indexOf('"</body>"'), "the tag lands after the script string");
  assert.ok(out.indexOf("data-eh-sdk") < out.lastIndexOf("</body>"), "and before the real close");
  assert.equal(stripSdk(out), page);
});
