import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE } from "./markdown.js";

export const isLatex = (file) => /\.tex$/i.test(file);

const here = path.dirname(fileURLToPath(import.meta.url));
const FILTER = path.join(here, "latex-filter.lua");
const TEMPLATE = path.join(here, "latex-template.html");

const MAX_DEPTH = 8;
const PANDOC_TIMEOUT_MS = 30000;
const PANDOC_MAX_BUFFER = 64 * 1024 * 1024;
/** `--sandbox`, which keeps pandoc from reading anything the document names, arrived in 2.15. */
export const PANDOC_MINIMUM = "2.15";

const INCLUDE = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
const BIBLIOGRAPHY = /\\bibliography\s*\{([^}]+)\}|\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

/** Index of the `%` that starts a LaTeX comment on this line, or -1. `\%` and `\\` are not comments. */
function commentStart(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1;
    else if (line[i] === "%") return i;
  }
  return -1;
}

/** The part of a line LaTeX actually reads. Used to decide what a document includes, never to rewrite it. */
const codeOf = (line) => {
  const cut = commentStart(line);
  return cut === -1 ? line : line.slice(0, cut);
};

/**
 * Resolve a name the document uses (an `\input` or `\bibliography` argument)
 * to a real file inside the document's own folder, or null. This is the one
 * boundary that keeps a document from pulling an arbitrary file on disk into
 * the review page: the path must stay inside the folder both as written and
 * after symlinks are resolved, and it must be a regular file.
 */
function resolveInside(dir, name, suffixes) {
  const inside = (root, target) => {
    const relative = path.relative(root, target);
    return !!relative && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
  };
  const lexicalRoot = path.resolve(dir);
  const base = path.resolve(lexicalRoot, name.trim());
  for (const suffix of suffixes) {
    const candidate = `${base}${suffix}`;
    try {
      if (!inside(lexicalRoot, candidate)) continue;
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      if (inside(fs.realpathSync(lexicalRoot), real)) return real;
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

/** Bibliography files the document declares, as real paths inside its folder. */
export function bibliographies(text, file) {
  const dir = path.dirname(file);
  const code = text.split(/\r?\n/).map(codeOf).join("\n");
  const found = [];
  for (const match of code.matchAll(BIBLIOGRAPHY)) {
    for (const raw of (match[1] || match[2]).split(",")) {
      const name = raw.trim();
      if (!name) continue;
      const real = resolveInside(dir, name, /\.bib$/i.test(name) ? [""] : [".bib"]);
      if (real) found.push(real);
    }
  }
  return [...new Set(found)];
}

/**
 * Read a document with its `\input` / `\include` files spliced in. Inlining
 * here, instead of letting pandoc follow the includes, lets pandoc run in its
 * sandbox: it never reads a path the document merely names. The text keeps the
 * author's LaTeX exactly, comments included; only active (uncommented)
 * include commands are expanded.
 *
 * A file included twice is spliced in twice, as LaTeX does. Only a file that
 * is already being read further up the chain is a cycle, and it expands to
 * nothing. `files` lists every source the page depends on, `.bib` files
 * included, and `fingerprint` changes whenever any of them does, so the
 * watcher can follow them all.
 */
export function loadLatex(file) {
  const files = [];
  const known = new Set();
  const active = new Set();
  const dir = path.dirname(file);

  const note = (real) => {
    if (known.has(real)) return;
    known.add(real);
    files.push(real);
  };

  function read(target, depth) {
    const real = fs.realpathSync(target);
    if (active.has(real)) return "";
    note(real);
    active.add(real);
    try {
      return fs
        .readFileSync(real, "utf8")
        .split(/\r?\n/)
        .map((line) => {
          if (depth >= MAX_DEPTH) return line;
          const cut = commentStart(line);
          const code = cut === -1 ? line : line.slice(0, cut);
          const expanded = code.replace(INCLUDE, (whole, name) => {
            const child = resolveInside(dir, name, ["", ".tex"]);
            return child ? read(child, depth + 1) : whole;
          });
          return cut === -1 ? expanded : expanded + line.slice(cut);
        })
        .join("\n");
    } finally {
      active.delete(real);
    }
  }

  const text = read(file, 0);
  const bibs = bibliographies(text, file);
  for (const bib of bibs) note(bib);
  const fingerprint = [text, ...bibs.map((bib) => fs.readFileSync(bib, "utf8"))].join("\u0000");
  return { text, files, bibliographies: bibs, fingerprint };
}

function runPandoc(args, input) {
  const bin = process.env.HUMAN_REVIEW_PANDOC || "pandoc";
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", timeout: PANDOC_TIMEOUT_MS, maxBuffer: PANDOC_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          return reject(new Error(`pandoc ${PANDOC_MINIMUM} or newer is required to review .tex files and was not found on PATH. Install it from https://pandoc.org/installing.html`));
        }
        if (error) {
          const detail = String(stderr || error.message).trim().split(/\r?\n/)[0];
          if (/--sandbox/.test(detail)) {
            return reject(new Error(`this pandoc is too old to review .tex files safely; pandoc ${PANDOC_MINIMUM} or newer is required. Update it from https://pandoc.org/installing.html`));
          }
          return reject(new Error(`pandoc could not render this document: ${detail}`));
        }
        resolve(stdout);
      }
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Render a LaTeX file into a standalone review page. Like Markdown, the page
 * is a viewing surface only: it is never written back, and feedback refers to
 * the rendered text, so the agent applies it to the `.tex` source.
 *
 * Math becomes MathML, so nothing loads from the network. Figures drawn in
 * TikZ and other raw LaTeX are not rendered; their captions are.
 */
export async function renderLatexPage(file) {
  const { text, bibliographies: bibs } = loadLatex(file);
  const args = [
    "--sandbox",
    "--from=latex",
    "--to=html5",
    "--standalone",
    `--template=${TEMPLATE}`,
    `--lua-filter=${FILTER}`,
    "--mathml",
    // The document title is the page's h1, so \section starts at h2.
    "--shift-heading-level-by=1",
    `--metadata=pagetitle:${path.basename(file)}`,
    ...(bibs.length ? ["--citeproc", ...bibs.map((bib) => `--bibliography=${bib}`)] : []),
  ];
  const html = await runPandoc(args, text);
  return html.replace("</head>", () => `<style>${STYLE}</style>\n</head>`);
}
