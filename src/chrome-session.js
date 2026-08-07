export function pageUrl(key, sessionId) {
  return `/api/page/${key}?session=${encodeURIComponent(sessionId)}`;
}

export function replacePage(state, page) {
  state.page = page;
  state.others = page.others || [];
}
