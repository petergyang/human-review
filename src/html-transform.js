// Match only the tag itself: injection adds no whitespace, so stripping must
// not eat any either, or open→save would not round-trip byte-identically.
const SDK_TAG_RE = /<script[^>]*\bdata-eh-sdk\b[^>]*><\/script>/gi;
const SDK_BASE_RE = /<base[^>]*\bdata-eh-sdk\b[^>]*>/gi;

/**
 * Add the one script tag human-review injects. Everything else about the artifact
 * is left byte-identical, so the saved file renders the same standalone.
 */
export function injectSdk(html, key, { src = `/sdk.js?key=${encodeURIComponent(key)}`, baseHref = "" } = {}) {
  const clean = stripSdk(html);
  const escapedSrc = String(src).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const tag = `<script data-eh-sdk type="module" src="${escapedSrc}"></script>`;
  let prepared = clean;
  if (baseHref) {
    const escapedBase = String(baseHref).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const base = `<base data-eh-sdk href="${escapedBase}">`;
    prepared = /<head(?:\s[^>]*)?>/i.test(prepared)
      ? prepared.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${base}`)
      : `${base}${prepared}`;
  }
  // No added whitespace: the SDK compares the live DOM against the on-disk file
  // to detect self-rendering pages, and a stray newline would read as an edit.
  if (/<\/body\s*>/i.test(prepared)) {
    return prepared.replace(/<\/body\s*>/i, `${tag}</body>`);
  }
  if (/<\/html\s*>/i.test(prepared)) {
    return prepared.replace(/<\/html\s*>/i, `${tag}</html>`);
  }
  return `${prepared}${tag}`;
}

/** Remove any injected tag, so a file saved with one never keeps it. */
export function stripSdk(html) {
  return String(html).replace(SDK_TAG_RE, "").replace(SDK_BASE_RE, "");
}

export function hasSdk(html) {
  SDK_TAG_RE.lastIndex = 0;
  return SDK_TAG_RE.test(String(html));
}
