import test from "node:test";
import assert from "node:assert/strict";
import { hashClickAction, navigationHref } from "../src/click-target.js";

function target({ link = null, control = null } = {}) {
  return {
    closest(selector) {
      if (selector === "a[href]") return link && { getAttribute: () => link };
      if (selector === "[data-href]") return control && { getAttribute: () => control };
      return null;
    },
  };
}

test("navigationHref prefers a real link", () => {
  assert.equal(navigationHref(target({ link: "/os/lesson", control: "/ignored" })), "/os/lesson");
});

test("navigationHref supports framework buttons with data-href", () => {
  assert.equal(navigationHref(target({ control: "/os/quickstart" })), "/os/quickstart");
});

test("navigationHref ignores ordinary controls", () => {
  assert.equal(navigationHref(target()), "");
});

test("hashClickAction sets the hash when it differs, so :target routing fires", () => {
  assert.deepEqual(hashClickAction("#interview", ""), { kind: "navigate", hash: "#interview" });
  assert.deepEqual(hashClickAction("#interview", "#overview"), { kind: "navigate", hash: "#interview" });
});

test("hashClickAction scrolls instead when the hash is already current", () => {
  assert.deepEqual(hashClickAction("#interview", "#interview"), { kind: "scroll", id: "interview" });
});

test("hashClickAction matches encoded and decoded forms of the same hash", () => {
  assert.deepEqual(hashClickAction("#caf%C3%A9", "#café"), { kind: "scroll", id: "café" });
});

test("hashClickAction survives malformed percent escapes", () => {
  assert.deepEqual(hashClickAction("#%", ""), { kind: "navigate", hash: "#%" });
  assert.deepEqual(hashClickAction("#%", "#%"), { kind: "scroll", id: "%" });
});
