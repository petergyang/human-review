# human-review

Review your AI agent's drafts the way you'd review a Google Doc — not by typing paragraphs into chat.

Your agent writes a spec, a plan, a newsletter draft, a landing page. Instead of describing every change in chat ("in the third paragraph, change X to Y…"), you open the file in your browser, fix the small stuff by typing directly into the page, select anything bigger and leave a comment, then hit Send. Your agent gets all of it at once, makes the changes, and the page refreshes so you can see them. Repeat until it's right.

```
agent provides a target  →  human-review <target>  →  you edit + comment  →  Send to agent
        ↑                                                                  │
        └────────────  page refreshes  ←  agent applies your feedback  ←───┘
```

Works with HTML files, Markdown files, and pages served from localhost.

## What you can do

| You do | What happens |
|--------|--------------|
| Type over any text | Static HTML saves directly; generated pages send the exact edit to the agent |
| Select a phrase | A comment box opens, anchored to that exact text |
| Click an image, chart, or section | Your comment covers that whole block |
| Hover and click `✕` | Deletes the block and tells the agent you did |
| `⌘`-click a link | Review a multi-page site; every page keeps its own feedback |
| Click `Revert all` | Puts the file back exactly how the agent left it |
| Hit Send | Everything — edits and comments from every page — goes to the agent in one batch |

For a localhost page, typing and deleting work the same way in the review UI.
The agent applies those exact changes to the app's MDX, TSX, templates, or
components; human-review never writes the rendered response over source code.

It also handles the tricky cases for you: Markdown files and pages that draw themselves with JavaScript can't be corrupted by your edits (your changes go to the agent as feedback instead of touching the file), and feedback you've sent is never lost, even if the agent or your computer restarts.

## Install

You can skip installing entirely — `npx` fetches and runs it on demand, which is also how your agent will call it:

```sh
npx -y human-review path/to/file.html
npx -y human-review http://localhost:3000/wiki
```

Or install it once so the shorter command works everywhere:

```sh
npm install -g human-review
```

Either way, run setup once to teach your agent when to reach for it:

```sh
npx -y human-review setup --global
```

That installs the skill in the standard global locations for Claude Code, Codex,
and agents that use `~/.agents/skills`. Drop `--global` to set up only the
current project; that also adds instructions to `AGENTS.md` for Codex and other
compatible agents.

## How the agent side works

Any agent that can run a shell command can use this — no SDK, no API keys. The agent opens the file or localhost route for you, then waits for your feedback:

```sh
human-review <file-or-localhost-url>     # open it in the human's browser
human-review poll <target> --timeout 600 # wait for feedback (up to 10 min)
human-review status <target>             # check for feedback without waiting
```

When you hit Send, the waiting `poll` command prints your feedback as JSON and the agent takes it from there:

```json
{
  "status": "feedback",
  "pages": [
    {
      "file": "/path/to/page.html",
      "comments": [
        { "quote": "the text you selected",
          "feedback": "what you want changed" }
      ],
      "edits": [
        { "label": "Lede", "before": "the original wording",
          "after": "your exact new wording" }
      ]
    }
  ],
  "overall_note": "anything you typed in the note box"
}
```

Two rules the agent is told to follow:

1. **Your direct edits are final.** The agent carries your exact wording across and never rewrites it — and if the file was generated from another source (like Markdown or MDX), it applies your edit there too.
2. **No replies in chat.** The agent answers by fixing the file; you see the result when the page refreshes.

### Review a running localhost page

Pass the real development route instead of recreating it as a separate HTML file:

```sh
human-review http://localhost:3000/wiki
human-review poll http://localhost:3000/wiki --timeout 600
```

You can rewrite copy and delete elements directly in the review UI. Those edits
are sent to the agent, which finds and updates the underlying project source.
Acknowledging the finished batch reloads the route with the rebuilt page.

URL review is limited to `localhost`, `127.0.0.1`, and `[::1]`. It loads the
rendered page and its assets, but it does not carry over an authenticated browser
session or guarantee every client-side interaction.

Authoring tip: add `data-block="Section name"` to parts of your HTML and the feedback list uses your names instead of guessing from the page structure.

## Private by design

Everything runs on your machine. No account, no cloud, no database — your comments live in one local file (`~/.human-review/state.json`) that you can delete any time. The only network traffic is npm downloading the package.

The local server only answers its own browser page and CLI — every request needs a secret token created fresh each run, so no other website or program can read or change your files through it. And saved files come out clean: nothing human-review adds to the page ever ends up on disk.

## Files

1. `src/cli.js`: The `human-review`, `poll`, `status`, and `setup` commands.
2. `src/server.js`: The localhost server — sessions, batches, file watching, auth.
3. `src/sdk.js`: Runs inside the reviewed page — editing, highlights, serialization.
4. `src/chrome-client.js`: The review UI around the page — comments, edits, Send.
5. `src/markdown.js`: Renders `.md` files for review.
6. `src/skill.md`: The skill `setup` installs for Claude Code and Codex.

## Requirements

Node 20+. macOS, Linux, Windows.

## Who made this

This is one tool from my personal AI operating system. The full library, including my courses and workflows, lives at [Behind the Craft](https://behindthecraft.com).

## License

MIT
