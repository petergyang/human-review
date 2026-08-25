import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-markdown-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { isMarkdown, renderMarkdownPage } = await import("../src/markdown.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-human-review-token": token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("isMarkdown matches only markdown extensions", () => {
  assert.equal(isMarkdown("/a/plan.md"), true);
  assert.equal(isMarkdown("/a/plan.markdown"), true);
  assert.equal(isMarkdown("/a/PLAN.MD"), true);
  assert.equal(isMarkdown("/a/plan.html"), false);
  assert.equal(isMarkdown("/a/plan.md.html"), false);
});

test("renderMarkdownPage produces a full document from gfm source", () => {
  const html = renderMarkdownPage("# Plan\n\nShip **soon**.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", "/x/plan.md");
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<h1[^>]*>Plan<\/h1>/);
  assert.match(html, /<strong>soon<\/strong>/);
  assert.match(html, /<table>/, "gfm tables render");
  assert.match(html, /<title>plan\.md<\/title>/);
});

test("raw HTML in markdown is visible but never active", () => {
  const html = renderMarkdownPage(
    "# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src=\"https://evil.example\"></iframe>\n\n<svg onload=alert(3)><circle /></svg>\n\n<div>Kept text</div>\n\n[Bad link](javascript:alert(4))\n\n![Bad image](data:text/html,bad)\n",
    "/x/notes.md"
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("script, iframe, svg").length, 0, "active elements are rendered only as text");
  assert.equal(
    [...document.querySelectorAll("*")].some((element) => [...element.attributes].some((attr) => /^on/i.test(attr.name))),
    false,
    "event-handler attributes never become active"
  );
  assert.equal(document.querySelectorAll('[href^="javascript:"], [src^="javascript:"], [src^="data:text/html"]').length, 0);
  assert.match(document.body.textContent, /Kept text/, "the source remains readable");
  assert.match(document.body.textContent, /Bad link/, "unsafe links retain their readable label");
});

test("normal Markdown links and images remain available", () => {
  const html = renderMarkdownPage(
    "[Relative](./spec.md) [Web](https://example.com) [Email](mailto:hi@example.com) ![Image](./image.png)",
    "/x/notes.md"
  );
  const document = new JSDOM(html).window.document;
  assert.deepEqual(
    [...document.querySelectorAll("a")].map((element) => element.getAttribute("href")),
    ["./spec.md", "https://example.com", "mailto:hi@example.com"]
  );
  assert.equal(document.querySelector("img").getAttribute("src"), "./image.png");
});

test("a markdown review is rendered, flagged, and never writable", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const file = path.join(tmp, "notes.md");
  fs.writeFileSync(file, "# Notes\n\nFirst draft.\n\nSee [the spec](./spec.md).\n");
  fs.writeFileSync(path.join(tmp, "spec.md"), "# Spec\n\nDetails.\n");

  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { file } });
  assert.equal(opened.status, 200);
  const { key, sessionId } = JSON.parse(opened.raw);

  await t.test("the artifact route serves rendered html with the sdk injected", async () => {
    const res = await request(port, token, { route: `/artifact/${key}/index.html` });
    assert.equal(res.status, 200);
    assert.match(res.raw, /<h1[^>]*>Notes<\/h1>/);
    assert.match(res.raw, /data-eh-sdk/);
    assert.doesNotMatch(res.raw, /# Notes/, "raw markdown syntax does not leak through");
  });

  await t.test("page state marks the page as markdown", async () => {
    const res = await request(port, token, { route: `/api/page/${key}` });
    assert.equal(JSON.parse(res.raw).markdown, true);
  });

  await t.test("saves are refused so the source file survives", async () => {
    const res = await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/save`,
      body: { html: "<!DOCTYPE html><html><body>overwritten</body></html>" },
    });
    assert.equal(res.status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), "# Notes\n\nFirst draft.\n\nSee [the spec](./spec.md).\n");
  });

  await t.test("navigation can follow a link to a sibling markdown page", async () => {
    const res = await request(port, token, {
      method: "POST",
      route: `/api/session/${sessionId}/navigate`,
      body: { href: "./spec.md" },
    });
    assert.equal(res.status, 200);
    const nav = JSON.parse(res.raw);
    assert.equal(nav.page.markdown, true);
    assert.equal(nav.page.filename, "spec.md");
  });

  await t.test("comments on a markdown page ship in the batch with the md path", async () => {
    await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/comment`,
      body: { kind: "selection", quote: "First draft.", feedback: "Add a timeline." },
    });
    const sent = await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/send`,
      body: { sessionId, note: "" },
    });
    assert.equal(sent.status, 200);
    const polled = await request(port, token, { route: `/api/poll?file=${encodeURIComponent(file)}` });
    const batch = JSON.parse(polled.raw);
    assert.equal(batch.status, "feedback");
    // The server canonicalizes paths (symlinked tmpdirs on macOS), so match on realpath.
    const page = batch.pages.find((p) => p.file === fs.realpathSync(file));
    assert.equal(page.comments[0].feedback, "Add a timeline.");
    assert.match(batch.next_step, /Markdown source/);
  });
});

// --------------------------------------------------------------- diagram tests

const { getPlantumlSource } = await import('../src/markdown.js');

test('mermaid code block gets diagram wrapper and mermaid div', () => {
  const html = renderMarkdownPage(
    '# Diagrams\n\n```mermaid\ngraph TD\n  A-->B\n```\n',
    '/x/doc.md',
    'abc123'
  );
  const doc = new JSDOM(html).window.document;
  const blocks = doc.querySelectorAll('.diagram-block');
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].querySelector('pre code.language-mermaid'), 'source pre is preserved');
  const mermaidDiv = blocks[0].querySelector('div.mermaid');
  assert.ok(mermaidDiv, 'mermaid render target exists');
  assert.match(mermaidDiv.textContent, /graph TD/);
});

test('mermaid script is injected when mermaid blocks present', () => {
  const html = renderMarkdownPage(
    '```mermaid\ngraph TD; A-->B;\n```\n',
    '/x/doc.md'
  );
  assert.match(html, /<script src="\/assets\/mermaid\.min\.js"><\/script>/);
  assert.match(html, /mermaid\.initialize/);
});

test('mermaid script is NOT injected without mermaid blocks', () => {
  const html = renderMarkdownPage(
    '# Just text\n\n```js\nconsole.log("hi")\n```\n',
    '/x/doc.md'
  );
  assert.doesNotMatch(html, /mermaid\.min\.js/);
  assert.doesNotMatch(html, /mermaid\.initialize/);
});

test('plantuml code block gets img tag when configured', () => {
  process.env.HUMAN_REVIEW_PLANTUML_JAR = '/fake/plantuml.jar';
  try {
    const html = renderMarkdownPage(
      '# Diagrams\n\n```plantuml\n@startuml\nA-->B\n@enduml\n```\n',
      '/x/doc.md',
      'abc123'
    );
    const doc = new JSDOM(html).window.document;
    const blocks = doc.querySelectorAll('.diagram-block');
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].querySelector('pre code.language-plantuml'), 'source pre is preserved');
    const img = blocks[0].querySelector('img');
    assert.ok(img, 'img tag exists for plantuml');
    assert.match(img.getAttribute('src'), /\/plantuml-img\?key=abc123&index=0/);
  } finally {
    delete process.env.HUMAN_REVIEW_PLANTUML_JAR;
  }
});

test('plantuml code block falls back to plain code when not configured', () => {
  delete process.env.HUMAN_REVIEW_PLANTUML_JAR;
  delete process.env.HUMAN_REVIEW_PLANTUML_URL;
  const html = renderMarkdownPage(
    '```plantuml\n@startuml\nA-->B\n@enduml\n```\n',
    '/x/doc.md'
  );
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.diagram-block').length, 0, 'no diagram wrapper when unconfigured');
  assert.ok(doc.querySelector('pre code.language-plantuml'), 'source code block still present');
});

test('empty diagram code blocks do not get render targets', () => {
  const html = renderMarkdownPage(
    '```mermaid\n\n```\n\n```plantuml\n\n```\n',
    '/x/doc.md'
  );
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.diagram-block').length, 0, 'empty blocks get no wrapper');
  assert.equal(doc.querySelectorAll('div.mermaid').length, 0, 'no mermaid div for empty source');
});

test('regular code blocks are unaffected by diagram processing', () => {
  const html = renderMarkdownPage(
    '```js\nconst x = 1;\n```\n\n```mermaid\ngraph TD\n```\n\n```python\nprint("hi")\n```\n',
    '/x/doc.md'
  );
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.diagram-block').length, 1, 'only mermaid gets wrapped');
  assert.ok(doc.querySelector('pre code.language-js'), 'js block unaffected');
  assert.ok(doc.querySelector('pre code.language-python'), 'python block unaffected');
});

test('mixed mermaid and plantuml on same page both render', () => {
  process.env.HUMAN_REVIEW_PLANTUML_JAR = '/fake/plantuml.jar';
  try {
    const html = renderMarkdownPage(
      '```mermaid\ngraph TD\n```\n\n```plantuml\n@startuml\nA-->B\n@enduml\n```\n',
      '/x/doc.md',
      'key1'
    );
    const doc = new JSDOM(html).window.document;
    const blocks = doc.querySelectorAll('.diagram-block');
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].querySelector('div.mermaid'), 'first block is mermaid');
    assert.ok(blocks[1].querySelector('img'), 'second block is plantuml');
    assert.match(html, /mermaid\.min\.js/, 'mermaid script injected');
    assert.match(html, /mermaid\.initialize/, 'mermaid init injected');
  } finally {
    delete process.env.HUMAN_REVIEW_PLANTUML_JAR;
  }
});

test('getPlantumlSource returns source stored by renderMarkdownPage', () => {
  process.env.HUMAN_REVIEW_PLANTUML_JAR = '/fake/plantuml.jar';
  try {
    renderMarkdownPage(
      '```plantuml\n@startuml\nX-->Y\n@enduml\n```\n\n```plantuml\n@startuml\nY-->Z\n@enduml\n```\n',
      '/x/doc.md',
      'key1'
    );
    assert.equal(getPlantumlSource('key1', 0), '@startuml\nX-->Y\n@enduml');
    assert.equal(getPlantumlSource('key1', 1), '@startuml\nY-->Z\n@enduml');
    assert.equal(getPlantumlSource('key1', 2), undefined);
    assert.equal(getPlantumlSource('nonexistent', 0), undefined);
  } finally {
    delete process.env.HUMAN_REVIEW_PLANTUML_JAR;
  }
});

test('plantuml code block with URL config also works', () => {
  process.env.HUMAN_REVIEW_PLANTUML_URL = 'https://plantuml.example.com/render';
  try {
    const html = renderMarkdownPage(
      '```plantuml\n@startuml\nA-->B\n@enduml\n```\n',
      '/x/doc.md',
      'urlkey'
    );
    const doc = new JSDOM(html).window.document;
    const img = doc.querySelector('.diagram-block img');
    assert.ok(img, 'img tag exists');
    assert.match(img.getAttribute('src'), /\/plantuml-img\?key=urlkey&index=0/);
  } finally {
    delete process.env.HUMAN_REVIEW_PLANTUML_URL;
  }
});

// ---------------------------------------------------------- server route tests

test('GET /assets/mermaid.min.js serves the vendored file', async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const res = await request(port, token, { route: '/assets/mermaid.min.js' });
  assert.equal(res.status, 200);
  assert.ok(res.raw.length > 1000, 'response is substantial (not an error page)');
});

test('GET /plantuml-img returns 400 when not configured', async (t) => {
  // Populate the source store first (render with PlantUML configured, then unset).
  process.env.HUMAN_REVIEW_PLANTUML_JAR = '/fake/plantuml.jar';
  try {
    renderMarkdownPage(
      '```plantuml\n@startuml\nA-->B\n@enduml\n```\n',
      '/x/doc.md',
      'noconfig'
    );
  } finally {
    delete process.env.HUMAN_REVIEW_PLANTUML_JAR;
  }

  // Now the source exists but neither env var is set.
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const res = await request(port, token, { route: '/plantuml-img?key=noconfig&index=0' });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.raw).error, /not configured/i);
});

test('GET /plantuml-img returns 400 for missing params', async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const noKey = await request(port, token, { route: '/plantuml-img?index=0' });
  assert.equal(noKey.status, 400);
  const noIndex = await request(port, token, { route: '/plantuml-img?key=abc' });
  assert.equal(noIndex.status, 400);
});

test('GET /plantuml-img returns 400 for invalid index', async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const res = await request(port, token, { route: '/plantuml-img?key=abc&index=bad' });
  assert.equal(res.status, 400);
});

test('GET /plantuml-img works without token (route is outside /api/ gate)', async (t) => {
  const { port, dispose } = await start();
  t.after(() => dispose());
  // Should get 400 (unknown source) not 401 (auth) — img tags can't send headers.
  const res = await request(port, '', { route: '/plantuml-img?key=abc&index=0' });
  assert.equal(res.status, 400);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
