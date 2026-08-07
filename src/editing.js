/**
 * Pure editing helpers, shared by the in-page SDK and Node tests.
 *
 * Everything here is deliberately DOM-free: the SDK feeds in strings and
 * computed-style snapshots, and gets back decisions it can apply.
 */

/**
 * The list command for a marker typed at the start of a line, or null.
 * `lead` is everything between the start of the block and the caret, so a
 * marker typed mid-sentence never converts.
 */
export function listCommandFor(lead) {
  const marker = String(lead || "").replace(/\u00a0/g, " ").trim();
  if (/^[-*]$/.test(marker)) return "insertUnorderedList";
  if (/^\d{1,3}[.)]$/.test(marker)) return "insertOrderedList";
  return null;
}

/**
 * Style properties a fresh list needs when the page's CSS reset hides it.
 * Tailwind preflight and similar resets set `list-style: none` and zero the
 * indent, so a just-created list looks like nothing happened. Returns only
 * the properties that are actually broken, so styled pages stay untouched.
 */
export function listStyleFixup(tagName, computed) {
  const patch = {};
  if (computed.listStyleType === "none") {
    patch.listStyleType = /^ol$/i.test(tagName) ? "decimal" : "disc";
  }
  const inset = (parseFloat(computed.paddingLeft) || 0) + (parseFloat(computed.marginLeft) || 0);
  if (inset < 16) patch.paddingLeft = "1.5em";
  return patch;
}

/**
 * A typed link, made openable and safe. Bare domains get https://, in-page
 * and relative references pass through, and anything with an executable or
 * unknown scheme (javascript:, data:, …) is rejected outright.
 */
export function normalizeHref(raw) {
  const href = String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!href) return "";
  let candidate = href;
  if (!/^(https?:|mailto:|tel:|#|\/|\.)/i.test(href)) {
    const head = href.split(/[/?#]/)[0];
    if (/^([\w-]+\.)+[\w-]+(:\d+)?$/.test(head) || /^localhost(:\d+)?$/i.test(head)) {
      // A bare domain — "example.com", "localhost:3000/wiki" — gets a scheme.
      candidate = `https://${href}`;
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return "";
    }
  }
  try {
    const parsed = new URL(candidate, "https://relative.invalid");
    if (!/^(https?:|mailto:|tel:)$/i.test(parsed.protocol)) return "";
  } catch {
    return "";
  }
  return candidate;
}
