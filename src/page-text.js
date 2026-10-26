import fs from "node:fs";
import { isLatex, renderLatexPage } from "./latex.js";
import { isMarkdown, renderMarkdownPage } from "./markdown.js";

/**
 * The text a reviewer sees in the browser, without a browser. Thread anchors
 * quote rendered text, so an agent writing a thread from the command line has
 * to quote this, not the Markdown or LaTeX source.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = ENTITIES[name.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** Roughly `document.body.textContent`: tags dropped, entities decoded, scripts and styles gone. */
export function htmlToText(html) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return decode(
    (body ? body[1] : html)
      .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, "")
  );
}

export async function renderedText(file) {
  if (isLatex(file)) return htmlToText(await renderLatexPage(file));
  const source = fs.readFileSync(file, "utf8");
  if (isMarkdown(file)) return htmlToText(renderMarkdownPage(source, file));
  return htmlToText(source);
}
