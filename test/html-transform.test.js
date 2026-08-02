import test from "node:test";
import assert from "node:assert/strict";
import { hasSdk, injectSdk, stripSdk } from "../src/html-transform.js";

const PAGE = `<!DOCTYPE html>
<html><head><title>Spec</title></head>
<body>
<h1>Hello</h1>
</body></html>`;

test("injectSdk adds exactly one script before </body>", () => {
  const out = injectSdk(PAGE, "abc123");
  const tags = out.match(/<script[^>]*data-eh-sdk/g) || [];
  assert.equal(tags.length, 1);
  assert.ok(out.indexOf("data-eh-sdk") < out.indexOf("</body>"));
  assert.ok(out.includes('src="/sdk.js?key=abc123"'));
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

test("localhost pages get an absolute base and sdk URL without stacking either", () => {
  const options = { src: "http://127.0.0.1:4444/sdk.js?key=k", baseHref: "http://localhost:3000/wiki" };
  const once = injectSdk(PAGE, "k", options);
  const twice = injectSdk(once, "k", options);
  assert.equal((twice.match(/<base[^>]*data-eh-sdk/g) || []).length, 1);
  assert.equal((twice.match(/<script[^>]*data-eh-sdk/g) || []).length, 1);
  assert.ok(twice.includes('href="http://localhost:3000/wiki"'));
  assert.ok(twice.includes('src="http://127.0.0.1:4444/sdk.js?key=k"'));
  assert.equal(stripSdk(twice), PAGE);
});
