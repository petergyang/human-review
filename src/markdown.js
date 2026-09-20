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
  blockquote { margin: 1em 0; padding: .1em 1em; border-inline-start: 3px solid #d8d5cb; color: #6b6862; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #e4e2db; padding: 7px 11px; text-align: start; }
  th { background: #f7f5f0; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #eceae3; margin: 2.2em 0; }
  .diagram { margin: 1em 0; }
  .diagram pre.mermaid { background: none; padding: 0; text-align: center; }
  .diagram pre.mermaid svg { max-width: 100%; height: auto; }
`;

/**
 * Scripts that read right to left. A page is mirrored when these outnumber the
 * Latin, Greek, and Cyrillic letters around them, so an Arabic or Hebrew file
 * lays out correctly with nothing to configure.
 */
const ARABIC_LETTERS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const HEBREW_LETTERS = /[\u0590-\u05FF\uFB1D-\uFB4F]/g;
const OTHER_RTL_LETTERS = /[\u0700-\u074F\u0780-\u07BF\u07C0-\u07FF\u0860-\u086F]/g;
const LTR_LETTERS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;

const countOf = (text, pattern) => (text.match(pattern) || []).length;

/**
 * Pick the page direction from the prose itself. Fenced and inline code are
 * dropped first: an Arabic document full of JavaScript samples is still an
 * Arabic document, and its identifiers should not outvote its sentences.
 */
export function detectDirection(mdText) {
  const prose = String(mdText || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  const arabic = countOf(prose, ARABIC_LETTERS);
  const hebrew = countOf(prose, HEBREW_LETTERS);
  const rtl = arabic + hebrew + countOf(prose, OTHER_RTL_LETTERS);
  if (!rtl || rtl <= countOf(prose, LTR_LETTERS)) return { dir: "ltr", lang: "en" };
  return { dir: "rtl", lang: hebrew > arabic ? "he" : "ar" };
}

/**
 * Layered on top of STYLE for right-to-left pages. `unicode-bidi: plaintext`
 * is the CSS form of `dir="auto"`: every block resolves its own direction from
 * its first strong character, so a Latin metadata line inside an Arabic
 * document still reads the right way round. Code is pinned left-to-right,
 * because a shell command is not prose. Arabic needs more leading than Latin
 * at the same size, hence the taller line box.
 */
const DEFAULT_RTL_FONT =
  '"SF Arabic", "Geeza Pro", "Segoe UI", "IBM Plex Sans Arabic", "Noto Sans Arabic", "Dubai", "Tajawal"';

/**
 * A reviewer who prefers a particular Arabic or Hebrew face sets it here. The
 * family is spliced into a stylesheet, so it is limited to the characters a
 * CSS font name can legally contain; anything else falls back to the default
 * rather than escaping its declaration. A companion stylesheet URL must be
 * https, which is what a webfont host serves anyway.
 */
function rtlFontFamily() {
  const raw = String(process.env.HUMAN_REVIEW_RTL_FONT || "").trim();
  if (!raw || !/^[\w \u00C0-\uFFFF"',.-]+$/.test(raw)) return DEFAULT_RTL_FONT;
  return raw;
}

function rtlFontLink() {
  const raw = String(process.env.HUMAN_REVIEW_RTL_FONT_URL || "").trim();
  if (!/^https:\/\/[\w.-]+\/[^\s"'<>]*$/.test(raw)) return "";
  return `<link rel="stylesheet" href="${raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
}

const RTL_STYLE = () => `
  body {
    font-family: ${rtlFontFamily()}, -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 17px;
    line-height: 1.95;
  }
  p, li, blockquote, h1, h2, h3, h4, th, td {
    unicode-bidi: plaintext;
    text-align: start;
  }
  blockquote {
    border-left: none;
    border-inline-start: 3px solid #d8d5cb;
  }
  code, pre, pre code {
    direction: ltr;
    unicode-bidi: normal;
    text-align: left;
  }
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
  const { dir, lang } = detectDirection(mdText);
  const style = dir === "rtl" ? STYLE + RTL_STYLE() : STYLE;
  const fontLink = dir === "rtl" ? rtlFontLink() : "";
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>
${fontLink}
<style>${style}</style>
</head>
<body><main>${body}</main>${loader}</body>
</html>
`;
}
