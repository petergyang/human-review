import test from "node:test";
import assert from "node:assert/strict";

import { pageUrl, replacePage } from "../src/chrome-session.js";

test("page refreshes keep session context and clear stale cross-page counts", () => {
  assert.equal(pageUrl("abc123", "session with spaces"), "/api/page/abc123?session=session%20with%20spaces");

  const state = {
    page: { edits: [{ label: "old" }] },
    others: [{ key: "other", count: 60 }],
  };

  const refreshed = { key: "abc123", comments: [], edits: [], others: [] };
  replacePage(state, refreshed);

  assert.equal(state.page, refreshed);
  assert.deepEqual(state.others, []);
});
