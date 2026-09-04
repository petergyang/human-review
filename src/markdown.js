import path from "node:path";
import { marked, Renderer } from "marked";

export const isMarkdown = (file) => /\.(md|markdown)$/i.test(file);

/**
 * Readable defaults for rendered Markdown. This HTML is a viewing surface
 * only — it is never written back to disk, so the styling can be opinionated.
 */
const STYLE = `
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #fdfcfa; color: #1b1a16;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 72ch; margin: 0 auto; padding: 48px 28px 96px; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 .5em; }
  h1 { font-size: 2em; margin-top: .4em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #eceae3; padding-bottom: .25em; }
  h3 { font-size: 1.15em; }
  p, ul, ol { margin: .75em 0; }
  li { margin: .3em 0; }
  a { color: #295fcc; }
  code {
    background: #f2f0ea; border-radius: 4px; padding: .12em .35em;
    font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  pre { background: #f2f0ea; border-radius: 8px; padding: 14px 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1em 0; padding: .1em 1em; border-left: 3px solid #d8d5cb; color: #6b6862; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #e4e2db; padding: 7px 11px; text-align: left; }
  th { background: #f7f5f0; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #eceae3; margin: 2.2em 0; }
  .diagram { margin: 1em 0; }
  .diagram pre.mermaid { background: none; padding: 0; text-align: center; }
  .diagram pre.mermaid svg { max-width: 100%; height: auto; }
`;

/**
 * Mermaid renders in the browser from a pinned CDN build, loaded only when a
 * page has a diagram. It is not bundled: the library and its dependencies
 * are 80 MB installed, which every `npx` user would pay for on first run.
 * Offline, or if the load fails, the fence stays a readable code block.
 */
export const MERMAID_VERSION = "11.17.2";
const MERMAID_SRC = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;
const MERMAID_LOADER = `<script type="module" data-eh-diagram>
import(${JSON.stringify(MERMAID_SRC)}).then(({ default: mermaid }) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
  return mermaid.run({ nodes: document.querySelectorAll("pre.mermaid") });
}).catch(() => {});
</script>`;

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function safeUrl(value, { image = false } = {}) {
  const url = String(value || "").trim();
  const probe = url.replace(/[\u0000-\u0020\u007f]+/g, "");
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!match) return url;
  const scheme = match[1].toLowerCase();
  if (scheme === "http" || scheme === "https") return url;
  if (!image && scheme === "mailto") return url;
  if (image && /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(probe)) return url;
  return null;
}

// Markdown can contain arbitrary HTML. Show that source as text so event
// handlers, embeds, SVG, and future browser features can never become active.
const INERT_RENDERER = new Renderer();
INERT_RENDERER.html = ({ text }) => escapeHtml(text);
INERT_RENDERER.link = function (token) {
  const href = safeUrl(token.href);
  if (!href) return this.parser.parseInline(token.tokens);
  return Renderer.prototype.link.call(this, { ...token, href });
};
INERT_RENDERER.image = function (token) {
  const href = safeUrl(token.href, { image: true });
  if (!href) return escapeHtml(token.text || "");
  return Renderer.prototype.image.call(this, { ...token, href });
};
// A ```mermaid fence becomes a diagram. The source stays in the element as
// text, which is what Mermaid reads and what the review falls back to.
INERT_RENDERER.code = function (token) {
  if (String(token.lang || "").trim().toLowerCase() !== "mermaid") return Renderer.prototype.code.call(this, token);
  return `<div class="diagram" data-block="Diagram"><pre class="mermaid">${escapeHtml(token.text)}</pre></div>\n`;
};

/** Render a Markdown file into a standalone review page. */
export function renderMarkdownPage(mdText, file) {
  const body = marked.parse(mdText, { gfm: true, async: false, renderer: INERT_RENDERER });
  const loader = body.includes('<pre class="mermaid">') ? MERMAID_LOADER : "";
  const title = path.basename(file);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main>${loader}</body>
</html>
`;
}
