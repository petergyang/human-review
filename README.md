# Human Review

Edit HTML and Markdown files directly, leave comments like a Google Doc, and send all your feedback to your AI agent at once.

[Read the full launch post](https://creatoreconomy.so/p/use-my-human-review-skill-to-edit-html-markdown-visually)

https://github.com/user-attachments/assets/7cab09c9-eaa0-4e8b-984d-2925e810b5c2

## Problem

Giving AI feedback on files in chat is painful.

Sometimes you want to change one sentence yourself. Instead, you end up typing:

> In the third paragraph, change X to Y. Cut the third card because it repeats the first one. Also rewrite the CTA.

Then the agent changes the file and you have to check whether it understood every instruction. This gets even harder when you’re reviewing a long plan, Markdown document, landing page, or multi-page website.

## How to install /human-review

The easiest way to install the skill is to paste this into ChatGPT, Claude Code, Codex, or your favorite coding agent:

```text
Install the /human-review skill globally from https://github.com/petergyang/human-review
```

You can also install it with `npx`:

```sh
npx -y human-review setup --global
```

## How to use /human-review

![Human Review visual editor](assets/human-review.png)

Open an HTML or Markdown file:

```text
/human-review (your file)
```

Review a page running on localhost:

```text
/human-review (localhost URL)
```

Human Review opens the file in your browser. Make direct edits, leave comments, and click Send. Your agent receives all your feedback in one batch, updates the source, and refreshes the page for another review.

Note: For HTML files, direct edits and resizes save automatically. For Markdown and localhost pages, click Send so your agent can apply them to the source.

## Reviewing from another device (phone, LAN, Tailscale)

By default human-review binds to `127.0.0.1` and serves the reviewed app from the *other* loopback name (`localhost` ↔ `127.0.0.1`). The shell and the reviewed page are deliberately **two different origins** — that's what stops the reviewed app's scripts from reading the session token off the shell.

To review from a phone or another machine, configure both sides explicitly. **This is for private networks only (Tailscale / VPN / trusted LAN)** — see the exposure warning below.

| Env var | Effect | Default |
|---|---|---|
| `HUMAN_REVIEW_HOST` | Server bind address | `127.0.0.1` |
| `HUMAN_REVIEW_ALLOWED_HOSTS` | Comma-separated extra `Host`-header allowlist | loopback only |
| `HUMAN_REVIEW_PUBLIC_URL` | URL printed/used for the session (e.g. `http://100.x.y.z:8124`); when set, the CLI skips auto-opening the browser | — |
| `HUMAN_REVIEW_ARTIFACT_HOST` | Hostname the reviewed page's iframe loads from | the other loopback name |
| `HUMAN_REVIEW_CHROME_ORIGIN` | Origin the SDK posts messages to (the shell) | auto-derived |

⚠️ **You must use two distinct hostnames** for the shell and the artifact. If `HUMAN_REVIEW_ARTIFACT_HOST` resolves to the same origin as the shell, the reviewed app's scripts would gain same-origin access to the shell — including the session token. human-review refuses to serve the session in that case; the error page explains the requirement.

Example (Tailscale): shell on the tailnet IP, artifact on the MagicDNS name:

```sh
HUMAN_REVIEW_HOST=0.0.0.0
HUMAN_REVIEW_ALLOWED_HOSTS=100.101.102.103:8124,my-laptop.tailnet-name.ts.net:8124
HUMAN_REVIEW_PUBLIC_URL=http://100.101.102.103:8124
HUMAN_REVIEW_ARTIFACT_HOST=my-laptop.tailnet-name.ts.net
human-review my-page.html
```

Open `http://100.101.102.103:8124/s/<id>` on your phone.

> ⚠️ **Exposure model — private networks only.** With `HUMAN_REVIEW_HOST=0.0.0.0` the server is reachable by anyone who can reach the port *and* sends an allowed `Host` header. Token-free routes become network-readable: `/artifact/<key>/…` (keys are `sha256(realpath)` truncated to 16 hex chars, derivable from file paths) serves the reviewed page and sibling assets, and `/s/<id>` carries the session token over plain HTTP. On a private tailnet that's fine; on shared or public Wi-Fi it is **not** — anyone sniffing or on the network could read your reviewed files. Don't bind to `0.0.0.0` on untrusted networks.

> ℹ️ Env vars are read by the server when it **starts**. If you already have a server running, stop it first before changing these values, or the old settings stay in effect. The detached server exits on its own after being idle (default 45 min, `HUMAN_REVIEW_IDLE_MS`) — or kill the stale one via its PID in `server.json` / Task Manager.

## What this skill lets you do

- **Edit text directly and tweak basic formatting** (e.g., bold, italic).
- **Make bulleted and numbered lists** — type `- ` or `1. ` at the start of a line, or press ⌘⇧8 / ⌘⇧7. Tab and Shift+Tab indent and outdent.
- **Add links** — select text and press ⌘K. ⌘K inside an existing link edits or removes it.
- **Resize images** by dragging their corner, and **move images** by dragging them to a new spot.
- **Select a phrase and leave a comment** anchored to the exact text.
- **Comment on an image, chart, or section** by clicking the element.
- **Remove elements** without explaining the deletion in chat.
- **Command-click links** to review multiple pages without losing your feedback.
- **Send every edit and comment at once** instead of writing a long chat message.

I use Human Review to edit AI-generated plans, update landing pages, review localhost apps, and remove the extra copy AI likes to add to UX.

## What’s inside

- [`cli.js`](src/cli.js) contains the `human-review`, `poll`, `status`, and `setup` commands.
- [`server.js`](src/server.js) runs the local review session.
- [`sdk.js`](src/sdk.js) handles editing, comments, highlights, and feedback.
- [`chrome-client.js`](src/chrome-client.js) contains the visual review interface.
- [`markdown.js`](src/markdown.js) renders Markdown files for review.
- [`SKILL.md`](src/SKILL.md) teaches Claude Code, Codex, and other agents how to use Human Review.

Everything runs on your computer. Human Review doesn’t require an account, cloud service, database, or API key.

## Want more great AI skills?

Check out [Behind the Craft](https://behindthecraft.com), my personal AI system with over a dozen other quality skills and courses.

Subscribe to my [YouTube channel](https://www.youtube.com/@PeterYangYT?sub_confirmation=1) and [newsletter](https://creatoreconomy.so) for practical AI tutorials and interviews.

## License

MIT
