import assert from "node:assert/strict";
import test from "node:test";

import { linkStyleFixup, listCommandFor, listStyleFixup, normalizeHref } from "../src/editing.js";

test("list markers typed at the start of a line convert to the right list", () => {
  assert.equal(listCommandFor("-"), "insertUnorderedList");
  assert.equal(listCommandFor("*"), "insertUnorderedList");
  assert.equal(listCommandFor("1."), "insertOrderedList");
  assert.equal(listCommandFor("12)"), "insertOrderedList");
  // Leading whitespace and non-breaking spaces (contenteditable loves those) don't block it.
  assert.equal(listCommandFor("  - "), "insertUnorderedList");
  assert.equal(listCommandFor(" -"), "insertUnorderedList");
});

test("a marker mid-sentence, or half-typed, never converts", () => {
  assert.equal(listCommandFor("Hello -"), null);
  assert.equal(listCommandFor("1"), null);
  assert.equal(listCommandFor("-x"), null);
  assert.equal(listCommandFor("2.5"), null);
  assert.equal(listCommandFor(""), null);
  assert.equal(listCommandFor(null), null);
});

test("a reset-hidden list gets its bullet and indent back", () => {
  const reset = { listStyleType: "none", paddingLeft: "0px", marginLeft: "0px" };
  assert.deepEqual(listStyleFixup("UL", reset), { listStyleType: "disc", paddingLeft: "1.5em" });
  assert.deepEqual(listStyleFixup("OL", reset), { listStyleType: "decimal", paddingLeft: "1.5em" });
});

test("a list the page styles on purpose is left alone", () => {
  const styled = { listStyleType: "disc", paddingLeft: "40px", marginLeft: "0px" };
  assert.deepEqual(listStyleFixup("UL", styled), {});
  // Custom markers with a margin-based indent count as styled too.
  const custom = { listStyleType: "square", paddingLeft: "0px", marginLeft: "24px" };
  assert.deepEqual(listStyleFixup("UL", custom), {});
});

test("typed links normalize to something openable", () => {
  assert.equal(normalizeHref("example.com"), "https://example.com");
  assert.equal(normalizeHref("www.foo.com/bar?a=1"), "https://www.foo.com/bar?a=1");
  assert.equal(normalizeHref("localhost:3000/wiki"), "https://localhost:3000/wiki");
  assert.equal(normalizeHref("  https://x.com  "), "https://x.com");
  assert.equal(normalizeHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(normalizeHref("tel:+15551234"), "tel:+15551234");
});

test("in-page and relative references pass through untouched", () => {
  assert.equal(normalizeHref("#pricing"), "#pricing");
  assert.equal(normalizeHref("/docs/setup"), "/docs/setup");
  assert.equal(normalizeHref("./page.html"), "./page.html");
  assert.equal(normalizeHref("docs/page.html"), "docs/page.html");
});

test("a link the page renders as plain prose gets an underline", () => {
  const prose = { color: "rgb(34, 34, 34)" };
  const resetLink = { textDecorationLine: "none", color: "rgb(34, 34, 34)" };
  assert.deepEqual(linkStyleFixup(resetLink, prose), { textDecoration: "underline" });
});

test("a link the page already styles is left alone", () => {
  const prose = { color: "rgb(34, 34, 34)" };
  assert.deepEqual(linkStyleFixup({ textDecorationLine: "underline", color: "rgb(34, 34, 34)" }, prose), {});
  assert.deepEqual(linkStyleFixup({ textDecorationLine: "none", color: "rgb(41, 95, 204)" }, prose), {});
});

test("executable and unknown schemes are rejected outright", () => {
  assert.equal(normalizeHref("javascript:alert(1)"), "");
  assert.equal(normalizeHref("JavaScript:alert(1)"), "");
  // Control characters can't smuggle a scheme past the check.
  assert.equal(normalizeHref("java\tscript:alert(1)"), "");
  assert.equal(normalizeHref("data:text/html,<script>x</script>"), "");
  assert.equal(normalizeHref("vbscript:x"), "");
  assert.equal(normalizeHref(""), "");
});
