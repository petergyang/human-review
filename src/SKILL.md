---
name: human-review
description: Open an HTML file, Markdown file, or localhost page in the browser so the user can edit text directly and leave comments on specific parts, then send all edits and comments back to you. Use after writing or updating something the user will read — specs, plans, reports, newsletter drafts, landing pages, slide decks, and locally running web pages.
---

# human-review

The user reviews your HTML, Markdown, or localhost page in a real browser: they fix small things
by typing, select anything to comment on it, and send you the whole batch at once.

Markdown files open rendered. Their quotes and edits reference the rendered text,
and the file itself is never touched — apply every change to the Markdown source,
keeping its formatting syntax.

## The loop

1. Write or update the HTML or Markdown file, or start the local page being reviewed.
2. Open it for the user:

   ```sh
   npx -y human-review path/to/file.html
   ```

   For a page served by a local development server, open the real route instead
   of recreating it as a separate HTML file:

   ```sh
   npx -y human-review http://localhost:3000/wiki
   ```

3. Wait for feedback. This command blocks until the user hits Send in the
   browser, then prints their batch and exits:

   ```sh
   npx -y human-review poll path/to/file.html
   ```

   Start it **in the background** and end your turn (in Claude Code, run it
   with `run_in_background: true`). The command exits only when the user
   clicks Send or closes the review, and your harness wakes you when it does —
   so there is nothing to re-run, no interval to poll on, and no `--timeout`
   to add. One background poll per review is the whole wait. It survives the
   local server restarting, and feedback is saved even if the poll dies, so
   nothing is ever lost.

   Only if your harness cannot wake you when a background command exits, run
   the same command in the foreground instead and keep waiting on it (or on
   the process handle it returns) until it exits.

   If it prints `{"status":"closed"}`, the user ended the review from the
   browser — stop and do not start another poll. Unsent feedback is kept and
   ships the next time this target is reviewed.

4. Apply what comes back, then start the next background poll. `--ack` clears
   the batch you just handled:

   ```sh
   npx -y human-review poll path/to/file.html --ack
   ```

Repeat 3–4 until the user says they are done.

Not sure whether feedback is already waiting — say, at the start of a new turn
with no poll running? This answers instantly without blocking:

```sh
npx -y human-review status path/to/file.html
```

It prints `{"status": "feedback-waiting"}` when a batch is ready for a poll,
plus counts of unsent comments and edits still in the browser.

## What you get

One batch covers every page the user visited, grouped by file or localhost URL.

```json
{
  "status": "feedback",
  "pages": [
    {
      "file": "/abs/path/to/page.html",
      "comments": [
        { "id": "c_1", "kind": "selection", "quote": "the exact text they selected",
          "anchor": { "prefix": "...", "quote": "...", "suffix": "..." },
          "feedback": "what they want changed" }
      ],
      "edits": [
        { "label": "Problem body", "kind": "edited",
          "before": "the original wording",
          "after": "their exact new wording",
          "after_html": "their exact new wording with <strong>formatting</strong>" }
      ]
    }
  ],
  "overall_note": "feedback not tied to any one page"
}
```

## Rules

- **`edits` are changes the user already made.** `after` is their exact wording —
  carry it across verbatim and never revert it. If the HTML was generated from
  something else (MDX, Markdown, a template), apply `after` to the **source** too,
  or their fix disappears on the next build.
- When `before_html`/`after_html` are present, the user changed formatting, not
  just words — bold, italic, underline, links. Use the HTML version to carry the
  formatting into the source, translated to its syntax (e.g. `<strong>` → `**`
  in Markdown/MDX).
- A page with `kind: "url"` was edited directly in the review UI. Its `file`
  and `url` fields name the localhost route, not a writable file. Find the
  matching project source (such as MDX, TSX, or a template), apply every edit
  and deletion there, then acknowledge so the route reloads. Never write the
  rendered HTTP response back into the app.
- When an edit's `after_html` contains `<img src="assets/...">`, the user pasted
  an image: the file already exists in an `assets/` folder next to the reviewed
  file. Keep that relative path — in Markdown, reference it as
  `![](assets/...)`. Never regenerate or inline the image.
- On a localhost page, a pasted image arrives under `staged_assets`. Copy its
  local `path` into the app's appropriate asset folder, replace the temporary
  preview URL in `after_html`, and preserve the image at the user's insertion
  point. Never leave the temporary preview URL in source.
- An edit with `kind: "moved"` means the user relocated that whole block.
  Reposition it in the source without rewriting its content: it now sits right
  after the block whose text starts with `moved_after`, and right before the
  block whose text starts with `moved_before`. An empty `moved_after` means it
  is now the first block in its container.
- Find each comment by its `quote`; that exact string is in the file.
- `kind: "element"` points at a whole block, so `quote` is its label, not body text.
- Fix every page in `pages`, not just the first.
- **Do not write a reply.** There is no chat. The user sees your work when the page
  reloads, which happens on its own the moment you save the file.

## Better edit labels (optional)

Name the sections you author and the user's edit list uses your names instead of
guessing from the DOM:

```html
<p data-block="Problem body">…</p>
<div data-container="Metrics callout">…</div>
```

`data-block` names a region for the edit list. `data-container` also makes the block
clickable as a comment target.
