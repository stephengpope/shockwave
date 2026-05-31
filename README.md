<div align="center">

<h1><img src="build/icon.png" width="40" align="top" alt="" />&nbsp;Shockwave</h1>

**An Obsidian-style markdown editor with a built-in AI agent — and free sync.**

A local, file-based notes app where your work stays as plain `.md` files in a folder you own.
It ships with a real coding agent baked right in (no separate Claude Code), and syncs through
your own GitHub repo for free.

[**Download ↓**](#install) · macOS · Windows · Linux

</div>

---

Want to learn to build apps like this? Join the <a href="https://skool.com/ai-architects">AI Architects</a>.

---

## Why Shockwave

### 🤖 Integrated AI Agent

A full coding agent lives in the right-hand sidebar — it reads and edits your notes directly, so you don't need a separate tool open.

- **Bring your own key** — Anthropic or OpenAI; pick the model and customize the system prompt.
- **Skills** — drop in reusable `SKILL.md` skill folders and enable them globally or per-workspace.
- **Secrets** — store named API tokens (encrypted at rest) the agent can use.
- **Voice input** — dictate to the agent with the mic, transcribed in real time.
- **Send context** — attach images and code/text files, or "Message Agent" to hand it the current file and your selection.

### 🔄 Free GitHub Sync

Sync any workspace to **your own GitHub repo** — no subscription, no third-party server, your history stays yours.

- **One token, set once** — a GitHub PAT, encrypted at rest, used across all workspaces.
- **Flexible setup** — clone an existing repo, create a brand-new one, or adopt a folder that's already a git repo.
- **Hands-off** — auto-syncs on an interval, with a status icon showing idle / syncing / paused.
- **Conflicts handled in-app** — when two machines edit the same file, a red badge shows what clashed. Resolve each file (keep yours, take theirs, or merge by hand) or reset the whole workspace either way — no terminal, no git knowledge needed.

---

## Install

Grab the latest build for your platform — these links always point at the newest release:

| Platform | Download |
|---|---|
| **macOS** (Apple Silicon) | [Shockwave-mac.dmg](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-mac.dmg) |
| **Windows** | [Shockwave-windows.exe](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-windows.exe) |
| **Linux** | [Shockwave-linux.AppImage](https://github.com/stephengpope/shockwave/releases/latest/download/Shockwave-linux.AppImage) |

> [!NOTE]
> The builds aren't code-signed yet, so each OS shows a one-time warning. Here's how to get past it:
>
> - **macOS** — "Shockwave is damaged and can't be opened" is the unsigned-app message, not real damage. Right-click the app → **Open**, or run `xattr -cr /Applications/Shockwave.app` once.
> - **Windows** — on "Windows protected your PC", click **More info → Run anyway**.
> - **Linux** — make it executable first: `chmod +x Shockwave-linux.AppImage`, then run it.

---

## Development

```bash
npm install
npm run dev     # electron + vite, hot reload
npm run dist    # build installers into dist/
npm test        # run the test suite
```

See [`CLAUDE.md`](CLAUDE.md) for architecture notes.
