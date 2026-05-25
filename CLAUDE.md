# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start electron-vite (`electron-vite dev --watch --remoteDebuggingPort=9222`). Builds main + preload, serves the renderer on :5173, launches Electron, and auto-reloads on any `electron/**` or `src/**` change. CDP for the renderer is exposed on :9222.
- `npm run build` — production build to `out/` (main, preload, renderer).
- `npm start` — `electron-vite preview` against the production build.
- `npm run dist` — build then `electron-builder` (produces dmg/nsis/AppImage per `build` block in `package.json`).
- `npm test` — run the test suite (node:test, no install needed).

No linter configured.

For day-to-day workflow (when to restart, how to read main vs renderer logs, how to attach to the renderer via CDP for headless debugging, IPC discipline), use the **electron-dev** skill at `.claude/skills/electron-dev/SKILL.md`.

## Architecture

Electron app with a Vite + React 19 renderer. The renderer is a markdown-workspace editor (CodeMirror 6) with wiki-links (`[[name]]`), backlinks, tabs, drafts, multiple workspaces, a force-graph view, a live-preview / raw view-mode toggle, an editor status bar, bookmarks, daily notes, quick search, image embeds, and a right-hand coding-agent chat sidebar (pi).

### Process boundary

- **Main** (`electron/main.js`): owns the filesystem, dialogs, context menus, settings persistence, `nativeTheme`, the file watcher + rename correlator, the `app://media/...` protocol for serving workspace images, window-bounds persistence, secret encryption (Electron `safeStorage`), the pi coding-agent session (`electron/codingAgent.js`), skill-library management (`electron/skillLibrary.js`), and two pi extensions that bridge into main (`agentTokensExtension.js`, `linkIndexExtension.js`). All IPC handlers are registered here. Settings persist to `app.getPath('userData')/settings.json` via an atomic tmp+rename, serialized through a single write queue so concurrent writers (renderer + main-side window-bounds) can't race.
- **Preload** (`electron/preload.cjs`): exposes a single `window.api` surface. The renderer never touches Node — every fs/dialog/agent call goes through `window.api.*`. Also exposes `webUtils.getPathForFile` so the renderer can resolve drag-dropped folder paths (skill import).
- **Renderer** (`src/`): React app rooted at `src/main.jsx` → `App.jsx`. Vite root is `src/` (configured in `electron.vite.config.js`'s `renderer` section); build output goes to `out/renderer/`. Built main/preload land at `out/main/index.js` and `out/preload/index.cjs`. `src/main.jsx` also installs a window-level dragover/drop preventer for `Files` drags so a stray drop outside an explicit handler doesn't navigate the renderer away to the file URL.

### Renderer state model

`App.jsx` is the orchestrator. Three custom hooks (in `src/hooks/`) own the heavy state:

- `useTabs` — tabs, `activeTabId`, per-path view state, per-tab back/forward history. Tabs may be drafts (`isDraft: true, path: null`); `promoteDraft` creates the file on disk and converts the tab. Draft promotion is guarded by an in-flight map so rapid edits don't race to create two files.
- `useLinkIndex` — wraps `createLinkIndex()` (in `src/linkIndex.js`) behind a ref + a `version` counter. The counter is `bump()`ed after every mutation so consumers can re-render. `pageIndex` (basename → path, lowercase keys) is rebuilt from the tree via `useMemo`.
- `useFileOps` — rename/duplicate/delete/link-click, and the `treeAndIndexChanged()` helper that re-reads the tree and bumps the link index after any structural change.

The **Editor** (`src/Editor.jsx`) is imperative: parent gets a ref with `setContent / getText / getViewState / clear / flashRanges / setReadOnly / focus`. `App.jsx` loads content into the editor via an effect that watches `activeFile` — this decouples load timing from React state-update ordering. The `dark` prop recreates the EditorView (theme can't be reconfigured live). `viewMode` toggles the live-preview decoration bundle via a Compartment — cursor, history, and scroll all survive a reconfigure.

### Save lifecycle

Edits are debounced (`SAVE_DEBOUNCE_MS = 500` in `App.jsx`) via `dirtyPathRef` + `saveTimerRef`. `writeNow()` flushes immediately and is awaited before any operation that would change `activeFile` (tab switch, workspace switch, rename, delete, graph toggle, `beforeunload`). When you add a new place that changes the active file, call `writeNow()` first or you'll lose unsaved edits.

### Link index

`src/linkIndex.js` is the single source of truth for parsing `[[target|alias#heading]]` wiki-links and maintaining bidirectional indices (`outgoingByFile`, `backlinks`, `mtimes`). On workspace load, the **main** process walks the workspace, pre-parses every `.md` file (`fs:readAllMarkdown` → `electron/linkParser.js`), and ships `{path, mtime, outgoingLinks}` rows to the renderer for `rebuild()`. Incremental edits/renames/deletes update the index in the renderer.

**`electron/linkParser.js` is an ESM mirror of the parser pieces in `src/linkIndex.js`.** If you change `LINK_RE`, `normalizeTarget`, `parseLinks`, `leadingWidth`, or `collectContext` in one, change both. The `tests/parserParity.test.js` suite asserts equality across both copies — run `npm test` after editing either.

### In-app rename

`src/renameOps.js` is the in-app rename flow. Order of operations (important):
1. `api.renameFile` — main auto-disambiguates the target name if it collides with any `.md` file basename anywhere in the workspace (case-insensitive). Returns the FINAL path used.
2. `linkIndex.renameFile(oldPath, finalNewPath)` — re-keys the index.
3. `rewriteReferences` — rewrites `[[OldName(#h|alias)?]]` to `[[NewName(#h|alias)?]]` (case-insensitive match, suffix preserved) in every file in `getBacklinks(oldBaseName)`. Self-references in the renamed file itself are also rewritten.
4. Re-read the renamed file and `updateFile` it so its own outgoing links reflect any self-reference rewrites.

The watcher will echo a `rename` event ~350ms later (see "External-edit rename detection" below); the renderer's handler runs the same `rewriteReferences` against the new state, which is idempotent (regex matches nothing because refs are already rewritten).

### External-edit rename detection (correlator)

External actors — Finder, `mv`, `git checkout`, a coding agent shelling out to `fs.rename` — bypass the in-app rename flow. Without intervention, the watcher would see a rename as unrelated `unlink(old) + add(new)` events, references in other files would break, and the link index would lose the connection between the old and new paths.

`electron/renameCorrelator.js` solves this. It buffers unlinks and pairs them with subsequent adds:

- **Primary key: inode.** `fs.stat(p, { bigint: true }).ino` is stable across `fs.rename` on every realistic filesystem (NTFS, APFS, ext4, btrfs, xfs). The correlator stores `{path → {ino, hash}}` for every known file; on `unlink`, it buffers the identity; on `add`, it stats the new file's ino and matches against buffered unlinks.
- **Fallback: content hash.** For filesystems where ino is unreliable (FAT, exFAT, some SMB shares), the correlator falls back to matching the SHA-1 of the file contents (computed eagerly on `onPathSeen` because the file is gone by the time `unlink` fires).
- **Grace window.** `RENAME_GRACE_MS = 800` in `main.js`. Buffered unlinks that aren't claimed within that window are emitted as real `unlink` events.
- **Atomic saves** (vim/VS Code write-temp-then-rename-over-existing) come through chokidar as `change` (not unlink+add), so they don't trip the correlator — see `tests/correlator.integration.test.js` for the proof.

The watcher emits `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` to the renderer. The renderer's handler in `App.jsx` does the equivalent of the in-app rename: re-key the index, refresh outgoing links if content changed, rewrite `[[OldName]]` references in other files, update any open tab paths, and schedule a tree refresh.

### Workspace-wide name uniqueness (auto-disambiguate)

The link index is keyed by basename, so two files sharing a name break it. The IPC handlers (`fs:renameFile`, `fs:moveItem`, `fs:createFile`) call `uniqueInWorkspace` (in `main.js`) to auto-disambiguate workspace-wide: if a target basename already exists anywhere, the operation succeeds with `" 1"`, `" 2"`, … appended. The renderer-side `findNameConflict` (in `App.jsx`) does the matching live-warning check while the user types in the title input (workspace-wide, case-insensitive). Folder renames stay same-folder-unique because folders aren't part of the link index.

This is a deliberate simplification — Obsidian allows duplicate basenames and uses path-prefixed links (`[[folder/Foo]]`) to disambiguate. See `docs/path-prefixed-links.md` for the design of that future direction.

### Terminology

The canonical names. Use these in UI strings, comments, docs, agent prompts — anywhere a human (user or contributor) might read them.

- **File** — a `.md` document in the workspace. The user-facing noun for the thing you create / open / edit / delete. **Never use "page" or "note"** — both were earlier conventions that have been retired.
- **Basename** — a file's name with no folder path and no `.md` extension. For `notes/projects/Foo.md`, the basename is `Foo`. This is what wiki-links use, and what the link index is keyed by.
- **Workspace** — the folder on disk the user has opened. Everything inside it (files, images, other assets) is part of the workspace. Code sometimes still says "vault" (Obsidian-inherited); new code uses "workspace".
- **Wiki-link** — the `[[Some File]]` syntax linking one file to another by basename. The term comes from MediaWiki/Obsidian/etc. Variants: `[[File#Heading]]`, `[[File|Display]]`. Resolution is workspace-wide, case-insensitive, basename-only — never include a folder path. The parser + index live in `src/linkIndex.js`.
- **External link** — the `[label](https://…)` markdown form. Always means an off-workspace URL. Opens in the system browser. Not to be confused with wiki-links.
- **Backlink** — a wiki-link that points *at* a given file from elsewhere. The link index maintains backlinks per file; the backlinks panel under the editor reads from that.

Avoid: "page", "note", "document" (for `.md` files), "vault" (in new code/copy), "internal link" (call it a wiki-link).

### Invariants when touching files/links

Any code that creates, modifies, renames, or deletes a `.md` file — whether through in-app actions or via the watcher path — must satisfy all of these. Skipping any one drifts the cache from disk:

1. **Link-index sync.** Create/change → `linkIndex.updateFile` or `applyParsedLinks`. Delete → `removeFile`. Rename → `renameFile`. Then `bump()` so consumers re-render.
2. **Tree refresh.** Any add/remove of a file or folder must result in `refreshTree()` (in-app: call `fileOps.treeAndIndexChanged()`; external: handled by the fs watcher).
3. **Folder rename re-keys nested files.** Renaming a folder changes every nested file's path. The handler (`onTreeRename` in `App.jsx`) walks `getOutgoingMap()` for paths under the old folder, calls `linkIndex.renameFile(oldP, newP)` and `renameTabsPath(oldP, newP)` for each, and shifts `selectedFolderPath` if it pointed inside. `onMoveItems` does the same for drag-and-drop moves. Without this, the index carries stale path keys until the watcher echoes per-file events, and open tabs inside the renamed folder break.
4. **Parser parity.** `LINK_RE` / `normalizeTarget` / `parseLinks` / `leadingWidth` / `collectContext` must stay identical between `src/linkIndex.js` and `electron/linkParser.js`. The watcher in main reuses `linkParser.js`, so this constraint is exercised on every external change. `tests/parserParity.test.js` enforces this.
5. **Save before mutating active file.** Per "Save lifecycle" above: `writeNow()` first, awaited.
6. **Real mtimes.** External-change handlers must use the file's `stat.mtimeMs`, not `Date.now()`. The renderer uses `Date.now()` for local in-memory updates — that's intentional, and is what makes the watcher's self-echo guard work (event mtime < stored mtime → skip).
7. **Workspace-scoped watcher.** One watcher per app. Switching or removing a workspace must `watchStop()` before doing anything else; `loadWorkspace` handles this. Don't start a watcher without stopping the previous one. Starting also seeds the rename correlator (stat + hash every `.md` under the root) so unlinks fired immediately after `watchStart` can still be correlated.
8. **Idempotent watcher handlers.** Every in-app write self-echoes ~350ms later. Handlers must be safe to re-run on the same data. The mtime guard is the primary mechanism. For `rename` events, the renderer's handler is also idempotent (linkIndex.renameFile of an already-renamed path is a no-op; the regex rewrite matches nothing because refs are already rewritten).
9. **Watcher reloads the active file on external change.** When `evt.path === activeFile` and the event is fresh (`evt.mtime > stored mtime`), the renderer reads the new content, calls `editor.setContent(text, viewState)` to preserve cursor/scroll, then flashes the added text green via `editor.flashRanges(ranges)`. The diff is word-level (`diff` npm, `diffWordsWithSpace`). Reload runs unconditionally — if a keystroke lands in the same instant the agent (or any external writer) modifies the file, the keystroke loses. The save-debounce window is 500ms so this is rare. The renderer's own writes don't trigger this path because the self-echo's mtime is <= the stored mtime (see invariant #6). See `src/diffFlash.js` for the flash extension.
10. **Self-references are rewritten on rename.** `renameOps.js` does NOT skip `src === oldPath`. If `Foo.md` contains `[[Foo]]` and is renamed to `Bar.md`, the on-disk file ends up containing `[[Bar]]`. Don't reintroduce the skip.

### File watcher

`chokidar` v4 in main process. One watcher per active workspace (lifecycle: started in `loadWorkspace`, stopped in `loadWorkspace`/`removeWorkspace`/`before-quit`). Per-path events are coalesced within a 150ms window; `.md` adds/changes are read + parsed in main (reusing `linkParser.js`).

Events shipped to the renderer (via `fs:changed`):

- `{type:'add'|'change', path, mtime, outgoingLinks}` — .md file appeared or modified
- `{type:'unlink', path}` — .md file removed (grace window already elapsed without a paired add)
- `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` — paired by the correlator (inode primary, hash fallback)
- `{type:'tree'}` — folder change or non-.md change (tree refresh only)

The watcher only sees inside the active workspace, and the `ignored` predicate skips any path with a dotfile segment (`.git`, `.obsidian`, `.shockwave`, etc.) — mirrors `buildTree`. The `.shockwave/` segment is how we store our own per-workspace data (bookmarks) without echoing back through the watcher.

**Renderer-side discipline (the bug this prevents):** the `fs:changed` listener in `App.jsx` subscribes once per `workspacePath` and accesses every dependency (`linkIndex`, `refreshTree`, `renameTabsPath`, `showError`, `activeFile`, `activeIsDraft`) via refs. Do NOT add `linkIndex` (or any per-render object) to the listener's `useEffect` deps. The handlers call `linkIndex.bump()` synchronously, which triggers a re-render; if the effect re-ran on that, its cleanup would clear the 80ms `refreshTimer` set inside the listener, and external `.md` adds would silently never refresh the sidebar. In-app file operations call `fileOps.treeAndIndexChanged()` directly AND get echoed by the watcher, so they paper over watcher bugs; external changes (terminal, pi coding agent, other apps) rely solely on this path. If external changes stop updating the sidebar, the listener-churn pattern is the first place to look.

### Cross-process constants to keep in sync

- `APP_NAME` lives in three places: `src/constants.js`, `electron/main.js` (`APP_NAME` const), and `package.json` (`build.productName`). Comments in each file flag this.
- `FILE_ACTIONS`, `FOLDER_ACTIONS`, and `EDITOR_ACTIONS` are duplicated in `src/constants.js` and `electron/main.js` (used by the native context menus). `EDITOR_ACTIONS.SEND_TO_AGENT` is enabled only when the active file has a path on disk (drafts opt out).
- `DEFAULT_SETTINGS` in `electron/main.js` is the schema for `settings.json`. Top-level keys include: `workspaces`, `activeWorkspaceId`, `appearance` (`themeMode`, `hideLineNumbers`), `dailyNote` (`format`, `folder`), `codingAgent` (`provider`, `model`, `apiKey`, `systemPrompt`, `skills.{global,workspaces}`), `agentSecrets[]`, `chatSidebarOpen`, `chatSidebarWidth`, `treeSortOrder`, `sidebarWidth`, `viewMode`, `windowBounds`. Adding a persisted field means updating `DEFAULT_SETTINGS`, the `readSettings` deep merge, and every `persistSettings()` call site in `App.jsx` (which passes the whole object on each write).

### Wiki-link UX inside the editor

- `src/wikiLinks.js` — CodeMirror `ViewPlugin` that replaces `[[…]]` ranges with a clickable `LinkWidget` (calls back into `onLinkClick`, which opens or creates the target via `useFileOps.onLinkClick`).
- `src/wikiCompletions.js` — autocomplete source triggered by `[[`; reads `pageIndex` and `workspacePath` through refs so completions see live data without re-creating the editor.
- `src/taskCheckboxes.js` — interactive `- [ ]` / `- [x]` rendering.
- `src/autoLinks.js` / `src/headingStyles.js` / `src/hideMarkdownMarkers.js` / `src/bulletPoints.js` — live-preview decorations that style markdown syntax in place.
- `src/markdownLinks.js` — renders `[text](url)` as a clickable link showing just `text`; reveals raw syntax when the cursor touches it. Also exports `findLinkAtPos` so the editor context menu can offer Edit / Remove for the link under the cursor (handles both plain text links and image-wrapping links like `[![alt](src)](url)`).
- `src/imageWidgets.js` — replaces `![alt](url)` ranges with an `<img>`. URLs resolve relative to the active file's folder (or absolute, or `http(s)://`) and are served via the `app://media/<rel>` protocol — see "Image pipeline" below.

### View mode + editor status bar

`src/EditorStatusBar.jsx` is a pure-presentation strip pinned to the bottom of the editor pane, visible only when a tab is active. It shows: backlink count, view-mode toggle (live ↔ raw), word count, character count, and save state. All state lives in `App.jsx`:

- `viewMode` (`VIEW_MODES.LIVE` | `VIEW_MODES.RAW` in `src/constants.js`) is persisted to settings and passed into `<Editor>`. The Editor toggles a CodeMirror Compartment carrying the live-preview decoration bundle without rebuilding the view — cursor, history, and scroll all survive a reconfigure. Only the `dark` prop forces an editor recreation. The `markdown()` extension always loads with `SetextHeading` removed (ATX headings only — `=== / ---` underline headings are intentionally unsupported).
- `editorStats` (`{ words, chars }`) is computed inside `Editor.jsx` (`computeStats`) and pushed up via the `onStats` callback (rAF-throttled).
- `saveState` (`SAVE_STATES.SAVED` | `SAVE_STATES.UNSAVED`) is set to UNSAVED on every editor change and flipped back to SAVED inside `writeNow()` — but only if `dirtyPathRef.current === null` after the write, so a write that races a subsequent edit doesn't flash SAVED prematurely.
- "Hide line numbers" (appearance setting) doesn't remove the gutter — it keeps the reserved width so the text column doesn't shift. The host element class drives CSS that hides the digits + active-line highlight.

### Image pipeline

Three pieces work together so images Just Work in markdown:

1. **`app://media/<rel-path>` protocol** (`main.js` → `protocol.handle('app', ...)`) — registered before `app.ready` via `registerSchemesAsPrivileged` so the renderer can fetch it with `webSecurity` intact. Requests resolve `<rel>` against `watcherRootDir` (the active workspace), reject path traversal outside the workspace with 403, and stream the file via `net.fetch(file://…)`. `<img src="app://media/…">` in the live-preview decoration loads with no extra wiring.
2. **`src/imageWidgets.js`** — `MatchDecorator` replaces `![alt](url)` with an `ImageWidget`. `resolveImageUrl` handles relative URLs (against active file's folder), absolute paths (workspace-root-relative), `http(s)://`, `data:`, `app:`, `file:`. Anything that resolves outside the workspace returns null and the source stays visible. The widget also detects a wrapping `[…](url)` link via the syntax tree and, if present, makes the image click-open the link.
3. **`src/imagePaste.js`** — handles both clipboard paste and drag-drop into the editor. Pasted screenshots arrive without a name → fall back to a timestamped `"Pasted image …"`; dropped files use their original basename. Multiple images get one `![](filename)` per line. The main-process `fs:writeImage` handler runs the chosen base through `uniquePath` (same-dir uniqueness) so collisions get `" 1"`, `" 2"`, … appended. Drafts are promoted on the spot via `ensureActiveFilePath` (same flow as the keystroke-promotion in App.jsx `onEditorChange`); `freshlyPromotedPathRef` in App.jsx tells the load effect to skip the disk read in the same tick so the buffer (which is about to receive the image insertion) isn't wiped.

There's also a **sidebar→editor image drag**: dragging an image from the file tree into the editor inserts a relative `![](…)` reference to that workspace file. Because `react-dnd-html5-backend` (used by react-arborist for the tree) registers a window-level dragover handler that forces `dropEffect='none'` for drags landing outside its targets, the dataTransfer is unreliable. We instead stash the source path in a module-level `pendingSidebarImagePath` on `dragstart` (in `FileTree.jsx`) and read it on `drop` (in `imagePaste.js`'s `dropPlugin`). The drop is attached via `view.contentDOM.addEventListener` (not CM6's `domEventHandlers`) so it can `stopImmediatePropagation` before react-dnd's window-level handler runs.

### Coding agent (pi)

Right-side chat sidebar (`src/ChatSidebar.jsx`) backed by `@earendil-works/pi-coding-agent`. The sidebar is collapsed to a 28px strip by default; clicking the strip expands it. State (`chatSidebarOpen`, `chatSidebarWidth`) is persisted to settings.

- **Main side** (`electron/codingAgent.js`): keeps **one** pi `AgentSession` at a time, keyed by `(workspacePath, provider, model, apiKey, effectiveSystemPrompt)`. The next `agent:send` whose key differs from the stored one tears down the previous session and creates a new one — there is no eager invalidation on settings change, only lazy reconciliation on the next send. `app.on('before-quit')` calls `agentReset()` to abort cleanly.
- **System prompt**: `electron/agentSystemPrompt.js` exports `DEFAULT_AGENT_SYSTEM_PROMPT`, which is pre-filled into `codingAgent.systemPrompt` on first install and writable from Settings → Agent Chat. An empty/whitespace value falls back to the default at session boot. Pi's default coding-agent prompt is overridden via a custom `DefaultResourceLoader` with `systemPromptOverride`. The renderer fetches the current default via `agent:getDefaultSystemPrompt` for the "Reset to default" button.
- **Skills** (`electron/skillLibrary.js`): on-disk library at `<userData>/pi-agent/skill-library/<skill-name>/SKILL.md` (one folder per skill). Pi never auto-discovers this directory. Each session boot we recompute the effective enabled list (`computeEffectivePaths`: workspace override wins over global; `inherit` falls back to global) and write it as `skills: []` to `<userData>/pi-agent/settings.json` via `writePiSettings`. Pi reads `skills` only at session boot — the user can hit Clear in the chat to apply a changed set.
- **Extensions** (also via `<agentDir>/settings.json` `extensions: []`): two are always loaded.
  - **`electron/agentTokensExtension.js`** — exposes `list_agent_secrets` + `get_agent_secret` tools so the agent can look up user-managed API tokens. The on-disk extension file is plain JS with no imports — it talks back to main through a process-global bridge (`global.__SHOCKWAVE_AGENT_TOKENS`) installed by `installAgentTokensBridge` at startup. The bridge re-reads settings on every call so user-side edits to secrets are picked up mid-conversation.
  - **`electron/linkIndexExtension.js`** — exposes `resolve_link` (basename → workspace-relative path + backlinks) so the agent can answer "where is `[[Foo]]`?" with one tool call instead of `find` + `grep`. Same bridge pattern (`global.__SHOCKWAVE_LINK_INDEX` installed by `installLinkIndexBridge`).

  Both extension source strings are materialized fresh on every session boot via `ensureAgentTokensExtension` / `ensureLinkIndexExtension`, so editing the source in this repo and restarting the app picks up the change without any user-side install step. The reason for the bridge pattern: the extension file lives under `<userData>/pi-agent/extensions/` (outside this project), and node's resolver can't find `electron` from there; writing decrypted secrets to disk would defeat the `safeStorage` encryption; pi runs in the same V8 isolate as main so a `global` function is the cleanest bridge.
- **IPC**: renderer → `agent:send({ text, images })`, `agent:abort()`, `agent:reset()`, `agent:getDefaultSystemPrompt()`. Main reads workspace + `codingAgent` settings, forwards every pi event to the renderer as `agent:event` and surfaces failures as `agent:error`. The agent runs with the **active workspace as `cwd`**, and uses an in-memory `AuthStorage` + `SessionManager` (sessions do not survive an app restart).
- **Failed-image guard**: pi pushes a user message into `state.messages` before the API call and a failure assistant message after, so a provider error (e.g. image too large) leaves both stuck in context to re-poison every subsequent turn. `codingAgent.js`'s `agentSend` wraps the emit callback to detect the failure on `agent_end`, splices the bad pair out of pi's in-memory state, and emits a synthetic `agent_send_failed` event so the renderer can drop the matching transcript entry from its UI.
- **Event protocol consumed by the sidebar**: `agent_start` / `agent_end` gate the running state. `turn_end` carries pi's normalized `usage` (we sum `totalTokens` across turns; each turn re-pays for context so the sum matches billed usage). `message_update` carries `assistantMessageEvent` which is either `text_start` (open a new assistant bubble) or `text_delta` (append to current bubble). `tool_execution_start` / `tool_execution_update` / `tool_execution_end` build collapsible tool entries keyed by `toolCallId`. Assistant text is rendered through `react-markdown` + `remark-gfm`. The sidebar also runs an elapsed-time ticker and a shimmer "Working" indicator while pi is running.
- **Workspace change**: the chat sidebar is mounted with `key={workspacePath ?? 'no-workspace'}` in `App.jsx`, so switching workspaces remounts it and clears the transcript. The pi session itself is reset lazily on the next send (because the session key changes).
- **Attachments** (`src/chatAttachments.js`): the composer accepts images (PNG/JPEG/GIF/WebP) and a long list of text/code file extensions, via the paperclip button, paste, or drag-drop onto the sidebar. Images are sent as pi's `ImageContent[]` shape; text files are inlined into the prompt as `<file name="…">…</file>` blocks before the user's typed message. Rejected files (unsupported format or read error) surface a dismissible inline error.

### Send to Agent

The editor context menu offers "Message Agent" when the active file has a path on disk (`EDITOR_ACTIONS.SEND_TO_AGENT`). It builds a framing snippet (`buildSendToAgentSnippet` in `App.jsx`) with a `[cwd]/...` workspace-relative path plus selection or cursor coordinates, fences any selected text in `~~~`, and injects it into the chat composer:

- Sidebar closed → expand it, queue the injection in `pendingComposerInjection`, drain via an effect once the sidebar's imperative ref attaches (`chatSidebarReady` flag flips on a callback ref).
- Sidebar open with empty composer → inject directly.
- Sidebar open with existing text → open a Dialog asking Replace / Append / Cancel.

The chat sidebar exposes `setComposerText(text, { append })`, `getComposerText()`, `focusComposer()` via `useImperativeHandle` for this flow.

### Bookmarks

Per-workspace bookmark set stored at `<workspace>/.shockwave/bookmarks.json` (`{ version: 1, paths: [...] }`, workspace-relative POSIX paths). The `.shockwave/` segment matches the watcher's dotfile-ignore predicate so our own writes don't echo back. Renderer keeps an in-memory Set of absolute paths; on workspace load we convert stored rel → abs, prune entries that no longer exist on disk, and rewrite the file if any were pruned. Toggle via the file context menu (`FILE_ACTIONS.TOGGLE_BOOKMARK`) or the bookmark icon in the sort bar. `renameBookmarkPath` / `removeBookmarkPath` / `persistBookmarks` keep the set in sync through file rename / delete flows. The sort bar's bookmark button toggles a filter mode that prunes the tree to only bookmarked files (and the folders that contain them); right-click on it opens a small picker listing all bookmarks alphabetically.

### Daily notes

Calendar button in the `ThinSidebar`:
- Click → open today's daily note (create if missing).
- Right-click → opens `JournalDatePicker` (a `react-day-picker` popover anchored at the cursor) to pick any date.

Settings → Daily Notes lets the user choose a dayjs format string (`YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY/MM/YYYY-MM-DD`, or custom) and a workspace-relative folder via `FolderCombobox`. `src/dailyNote.js` formats the date and computes `{ dir, name, absPath }` — slashes in the format become subfolder boundaries beneath the configured folder. `openJournal` in `App.jsx` looks the basename up in `pageIndex` first (so an existing note anywhere in the workspace is opened in place, regardless of where the format would put it), and only `ensureDir` + `createFile` when it doesn't exist.

### Quick search & sort bar

- **`SortBar`** (above the file tree): bookmark filter toggle, quick-search opener, sort menu, collapse-all. The sort menu offers Name asc/desc, Modified new→old/old→new, Created new→old/old→new (`TREE_SORT_ORDERS` in `constants.js`). Folders always stay first in A→Z order; the sort only re-orders files inside their folder. Sort is persisted to settings. `buildTree` in main stats every file for `mtimeMs` and `birthtimeMs` so the renderer can sort without re-statting.
- **`QuickSearch`** (`src/QuickSearch.jsx`): modal launched from the sort bar. Empty query → top 10 files by the active sort order. With a query → `fuzzysort` ranks every file by workspace-relative path so typing `j/2026` finds `Journal/2026-05-24.md`. Matches are highlighted via `segmentsFromIndexes`. Arrow keys + Enter; Esc closes.

### Window bounds persistence

`attachWindowBoundsPersistence` in `main.js` tracks the last-known unmaximized bounds and persists `{ x, y, width, height, maximized }` to `settings.windowBounds` on a 400ms debounce, with a final flush on `close`. The `will-quit` handler `event.preventDefault`s once, drains the `settingsWriteQueue`, then calls `app.exit()` so a fast Cmd+Q doesn't lose the last write. On restore, `boundsAreVisible` checks the saved rect against currently-attached displays and falls back to the default 1200×800 if it no longer intersects any display.

### Secrets encryption

Anywhere settings hold a secret (`codingAgent.apiKey`, every entry's `token` in `agentSecrets[]`) the on-disk value is wrapped with `enc:v1:<base64>` via Electron `safeStorage` (macOS Keychain / Windows DPAPI / libsecret on Linux). `encryptSecret` is idempotent — a value already wrapped passes through unchanged — so `writeSettings` can accept a merged object that mixes plaintext (from renderer) and ciphertext (preserved from disk) without double-encrypting. Decryption happens in `readSettings`; legacy plaintext values from before encryption was wired in pass through and are auto-upgraded on the next write. On Linux without a keyring, safeStorage falls back to hardcoded-password mode and we warn once.

### Settings sub-folder

`src/SettingsModal.jsx` is the host; each section lives in `src/settings/`:

- `AppearanceSection.jsx` — theme mode, hide-line-numbers.
- `WorkspacesSection.jsx` — list/add/remove/switch workspaces (folder picker via `dialog:openFolder`).
- `DailyNoteSection.jsx` — format presets + custom format + `FolderCombobox` for the target folder.
- `AgentChatSection.jsx` — provider/model/API key + system prompt textarea with Reset to default.
- `AiSkillsTab.jsx` (Global Skills) — drop folder / pick folder to import a SKILL.md-bearing folder into the library; enable/disable each skill globally; remove.
- `WorkspaceSkillsTab.jsx` (Workspace Skills) — per-workspace override: `inherit` / `enabled` / `disabled`. Workspace picker defaults to the active workspace.
- `AgentSecretsSection.jsx` — add/edit/delete tokens with `{name, description, token}`; names are unique case-insensitive; tokens are encrypted at rest.

The modal's title-bar shows a small `Saving…` / `Saved` / `Save failed` badge driven by `saveStatus` in `App.jsx` (`persistSettings` increments an in-flight counter so overlapping writes don't flash `saved` early). The save badge fades back to idle 1.5s after the last write completes.

### Reusable UI primitives

- `src/Dialog.jsx` — base modal with overlay, keyboard handling, focus management.
- `src/ConfirmDialog.jsx` / `src/ErrorDialog.jsx` — Dialog variants for confirms and errors.
- `src/ErrorMessage.jsx` — inline error banner used by app-level toasts and form-level warnings.

### Theme

Three modes (`light` / `dark` / `system`) stored in settings; system mode listens to `nativeTheme` updates via `theme:systemChanged`. The effective theme is set on `document.documentElement.dataset.theme` and also re-passed into the Editor (which recreates the view to swap `oneDark`).

## Tests

Run `npm test`. Node's built-in `node:test` runner — no install needed.

| File | Coverage |
|---|---|
| `tests/correlator.unit.test.js` | 13 pure-logic tests for the rename correlator: inode matching, hash fallback, grace timer, batch unlinks/adds, double-rename A→B→C, hash-collision determinism. |
| `tests/correlator.integration.test.js` | 10 tests against real chokidar + real `fs.rename`. Single renames, batch of 10, identical-content files, rename + simultaneous delete, atomic saves not classified as renames, folder rename emitting per-file renames inside. |
| `tests/linkIndex.test.js` | 15 tests on `createLinkIndex` invariants: `updateFile`/`removeFile`/`renameFile`/`rebuild`, mtime preservation across rename, case-insensitive backlink keys, heading/alias stripping, `getEntriesGroupedBySource` sort/group semantics, `prettyName`. |
| `tests/parserParity.test.js` | Runs both parsers (`src/linkIndex.js` and `electron/linkParser.js`) against the same fixtures and asserts byte-identical output. Add a fixture here when introducing new link syntax. |
| `tests/renameOps.test.js` | 10 tests on `renameWithReferences` and `rewriteReferences` with an in-memory `fs` stub: rewrite-in-other-files, heading/alias preservation, case-insensitive match, self-reference rewriting, auto-disambiguation handling (final name differs from requested), no-op same-name rename, empty-name rejection. |
| `tests/linkingSystem.e2e.test.js` | 12 end-to-end tests with a real tmp workspace + chokidar + correlator + the renderer-side index. Exercises every external-actor scenario: rename rewrites refs, rename rewrites self-refs, folder rename re-keys nested files, deletes, adds, in-place edits, 10 simultaneous renames, atomic save not classified as rename. |

What's NOT covered by automated tests: the Electron UI itself. Tabs, drag-and-drop in the file tree, title-input commit, right-click menus, editor decorations, the chat sidebar (skills, secrets, attachments), image paste/drop, quick search, bookmarks, daily notes — these need manual verification with `npm run dev`.
