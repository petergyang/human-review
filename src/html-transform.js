// Match only the tag itself: injection adds no whitespace, so stripping must
// not eat any either, or open→save would not round-trip byte-identically.
const SDK_TAG_RE = /<script[^>]*\bdata-eh-sdk\b[^>]*><\/script>/gi;
const SDK_BASE_RE = /<base[^>]*\bdata-eh-sdk\b[^>]*>/gi;
const SDK_ROUTE_RE = /<script[^>]*\bdata-eh-route\b[^>]*>[\s\S]*?<\/script>/gi;
const ASSET_TAG_RE = /<(script|link|img|source|video|audio|iframe|embed|object)\b[^>]*>/gi;
const ASSET_ATTR_RE = /(\s)(src|href|poster|data)=(['"])(.*?)\3/gi;

function absolutizeAssets(html, baseHref) {
  return String(html).replace(ASSET_TAG_RE, (tag) =>
    tag.replace(ASSET_ATTR_RE, (attribute, space, name, quote, value) => {
      if (!value || /^(?:data|blob|javascript):/i.test(value) || value.startsWith("#")) return attribute;
      const absolute = new URL(value, baseHref).href;
      return `${space}${name}=${quote}${absolute}${quote}`;
    })
  );
}

/**
 * Add the review bootstrap tags. Everything else about the artifact is left
 * byte-identical, so the saved file renders the same standalone.
 */
export function injectSdk(html, key, { src = `/sdk.js?key=${encodeURIComponent(key)}`, baseHref = "", nonce = "" } = {}) {
  const clean = stripSdk(html);
  const escapedSrc = String(src).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const escapedNonce = String(nonce).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const nonceAttr = escapedNonce ? ` nonce="${escapedNonce}"` : "";
  const tag = `<script data-eh-sdk type="module"${nonceAttr} src="${escapedSrc}"></script>`;
  let prepared = clean;
  if (baseHref) {
    const url = new URL(baseHref);
    const route = JSON.stringify(`${url.pathname}${url.search}${url.hash}`).replace(/</g, "\\u003c");
    const restoreRoute = `<script data-eh-route>history.replaceState(null,"",location.origin+${route})</script>`;
    prepared = absolutizeAssets(prepared, baseHref);
    prepared = /<head(?:\s[^>]*)?>/i.test(prepared)
      ? prepared.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${restoreRoute}`)
      : `${restoreRoute}${prepared}`;
  }
  // No added whitespace: the SDK compares the live DOM against the on-disk file
  // to detect self-rendering pages, and a stray newline would read as an edit.
  // Inject before the LAST closing tag — an inline script may legally contain
  // the literal string "</body>", and only the final one closes the document.
  const injected = injectBeforeLast(prepared, /<\/body\s*>/gi, tag) ?? injectBeforeLast(prepared, /<\/html\s*>/gi, tag);
  return injected ?? `${prepared}${tag}`;
}

function injectBeforeLast(html, closeRe, tag) {
  let last = -1;
  let match;
  while ((match = closeRe.exec(html))) last = match.index;
  if (last === -1) return null;
  return `${html.slice(0, last)}${tag}${html.slice(last)}`;
}

/** Remove any injected tag, so a file saved with one never keeps it. */
export function stripSdk(html) {
  return String(html).replace(SDK_TAG_RE, "").replace(SDK_BASE_RE, "").replace(SDK_ROUTE_RE, "");
}

export function hasSdk(html) {
  SDK_TAG_RE.lastIndex = 0;
  return SDK_TAG_RE.test(String(html));
}
