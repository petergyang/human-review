export function navigationHref(target) {
  const link = target?.closest?.("a[href]");
  if (link) return link.getAttribute("href") || "";
  const control = target?.closest?.("[data-href]");
  return control ? control.getAttribute("data-href") || "" : "";
}

/**
 * Decide what a modified click on a "#…" link should do. Setting the real
 * hash is what makes CSS :target routing (single-file "pages") show the
 * section — a bare scrollIntoView can't reach a display:none target and
 * never fires :target. Only when the hash is already current does scrolling
 * become the right move, since re-setting an identical hash is a no-op.
 */
export function hashClickAction(href, currentHash) {
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const id = decode(href.slice(1));
  if (decode((currentHash || "").slice(1)) === id) return { kind: "scroll", id };
  return { kind: "navigate", hash: href };
}
