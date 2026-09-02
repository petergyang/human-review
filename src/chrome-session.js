export function pageUrl(key, sessionId) {
  return `/api/page/${key}?session=${encodeURIComponent(sessionId)}`;
}

export function replacePage(state, page) {
  state.page = page;
  state.others = page.others || [];
}

/** New and newly revised feedback belongs where the reviewer can see it. */
export function newestComments(comments) {
  return [...(comments || [])].sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  );
}
