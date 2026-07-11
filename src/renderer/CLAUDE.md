# CLAUDE.md — renderer

React 19 + Vite renderer. Vite root is `src/renderer/` (configured in `electron.vite.config.js`'s `renderer` section); build output goes to `out/renderer/`. Entry: `index.html` → `main.jsx` → `App.jsx`.

`main.jsx` also installs a window-level dragover/drop preventer for `Files` drags so a stray drop outside an explicit handler doesn't navigate the renderer away to the file URL.

Cross-cutting invariants (terminology, link-index rules, parser parity, save-before-mutate) live in the **root `CLAUDE.md`** — read that first.

## State model

`App.jsx` is the orchestrator. Three custom hooks in `hooks/` own the heavy state, plus a small helper:

- `useTabs` — tabs, `activeTabId`, per-path view state, per-tab back/forward history. Tabs may be drafts (`isDraft: true, path: null`); `promoteTabPath(tabId, newPath)` flips a draft to a real file once the caller has created it on disk. The actual create-on-disk happens inside `writeNow` in `App.jsx` (see "Save lifecycle" below) — a draft has no file until its first save fires.
- `useLinkIndex` — wraps `createMetadataCache()` (in `metadataCache.js`, modeled on and named after Obsidian's) behind a ref + a `version` counter, `bump()`ed after every mutation. The cache owns `resolvedLinks` (source→dest paths), `unresolvedLinks`, the reverse backlinks, and a PRIVATE basename→paths "phone book"; it resolves links itself via `getFirstLinkpathDest` (rules in the pure `linkResolver.js`). There is no public `pageIndex` — consumers call `cache.getFirstLinkpathDest` / `candidatesFor` / `getBacklinksForFile`. Rename/move reference rewrites (`renameOps.js`) capture a context snapshot (`captureRewriteContext`) before the cache re-keys so resolution stays correct regardless of order.
- `useFileOps` — rename/duplicate/delete/link-click, and the `treeAndIndexChanged()` helper that re-reads the tree and bumps the link index after any structural change.
- `useSyncRef` — keeps a ref in sync with a value/callback so a stable closure (e.g. `writeNow`) can read fresh state without being rebuilt.

The **Editor** (`Editor.jsx`) is imperative: parent gets a ref with `setContent / getText / getViewState / clear / flashRanges / setReadOnly / focus`. `App.jsx` loads content into the editor via an effect that watches `activeFile` — this decouples load timing from React state-update ordering. The `dark` prop recreates the EditorView (theme can't be reconfigured live). `viewMode` toggles the live-preview decoration bundle via a Compartment — cursor, history, and scroll all survive a reconfigure.

## Save lifecycle

Edits are debounced (`SAVE_DEBOUNCE_MS = 500` in `App.jsx`) via `dirtyTabIdRef` + `saveTimerRef`. `writeNow()` flushes immediately and is awaited before any operation that would change `activeFile` (tab switch, workspace switch, rename, delete, graph toggle, `beforeunload`). When you add a new place that changes the active file, call `writeNow()` first or you'll lose unsaved edits.

`writeNow` is the **only** place a file gets created from a draft. The dirty marker holds a *tab id*, not a path. When the timer fires (or anything awaits `writeNow`), it looks up the tab: if `isDraft`, it creates the file via `window.api.createFile(newFileDir(), titleDraft || 'Untitled', buffer)` and calls `promoteTabPath(tabId, newPath)` to flip the tab to a real file; otherwise it writes through to `tab.path`. A per-tab in-flight map inside `writeNow` coalesces concurrent calls so two near-simultaneous saves can't both fire `createFile` and leave an orphan disambiguated file behind. On failure the dirty marker is re-armed so the next attempt retries the same tab. Drafts have no file on disk until the first save fires — typing into a draft, pasting an image, committing a title, or switching tabs are all events that eventually call `writeNow`, which creates the file as a side-effect of saving.

The load effect (App.jsx) tracks the last-loaded `(tabId, path, isDark)` and skips the disk read when the same tab transitions from `null` → real path. That's how draft promotion doesn't clobber the buffer: same tab id, previous path was null → don't reload.

## In-app rename

`renameOps.js` is the in-app rename flow. Order of operations (important):
1. `api.renameFileLiteral` — main renames to `toName` verbatim (no `.md` forcing, so extension changes like `Foo.md` → `Foo.txt` work) and throws on a same-folder collision. Returns the FINAL path used.
2. `linkIndex.renameFile(oldPath, finalNewPath)` — re-keys the index.
3. `rewriteReferences` — rewrites `[[OldName(#h|alias)?]]` to `[[NewName(#h|alias)?]]` (case-insensitive match, suffix preserved) in every file in `getBacklinks(oldBaseName)`. Self-references in the renamed file itself are also rewritten.
4. Re-read the renamed file and `updateFile` it so its own outgoing links reflect any self-reference rewrites.

The watcher will echo a `rename` event ~350ms later (see `src/main/CLAUDE.md`); the renderer's handler runs the same `rewriteReferences` against the new state, which is idempotent (regex matches nothing because refs are already rewritten).

## Renderer-side `fs:changed` listener discipline

External fs changes (terminal, pi coding agent, other apps) reach the renderer through the `fs:changed` listener in `App.jsx`. That listener subscribes **once per `workspacePath`** and accesses every dependency (`linkIndex`, `refreshTree`, `renameTabsPath`, `showError`, `activeFile`, `activeIsDraft`) **via refs**.

Do NOT add `linkIndex` (or any per-render object) to the listener's `useEffect` deps. The handlers call `linkIndex.bump()` synchronously, which triggers a re-render; if the effect re-ran on that, its cleanup would clear the 80ms `refreshTimer` set inside the listener, and external `.md` adds would silently never refresh the sidebar.

In-app file operations call `fileOps.treeAndIndexChanged()` directly AND get echoed by the watcher, so they paper over watcher bugs; external changes (terminal, pi coding agent, other apps) rely solely on this path. If external changes stop updating the sidebar, the listener-churn pattern is the first place to look.

## Wiki-link UX inside the editor

- `wikiLinks.js` — CodeMirror `ViewPlugin` that replaces `[[…]]` ranges with a clickable `LinkWidget` (calls back into `onLinkClick`, which opens or creates the target via `useFileOps.onLinkClick`).
- `wikiCompletions.js` — autocomplete source triggered by `[[`; reads `pageIndex` and `workspacePath` through refs so completions see live data without re-creating the editor.
- `taskCheckboxes.js` — interactive `- [ ]` / `- [x]` rendering.
- `autoLinks.js` / `headingStyles.js` / `hideMarkdownMarkers.js` / `bulletPoints.js` — live-preview decorations that style markdown syntax in place.
- `markdownLinks.js` — renders `[text](url)` as a clickable link showing just `text`; reveals raw syntax when the cursor touches it. Also exports `findLinkAtPos` so the editor context menu can offer Edit / Remove for the link under the cursor (handles both plain text links and image-wrapping links like `[![alt](src)](url)`).
- `imageWidgets.js` — replaces `![alt](url)` ranges with an `<img>`. URLs resolve relative to the active file's folder (or absolute, or `http(s)://`) and are served via the `app://media/<rel>` protocol — see "Image pipeline" below.
- `diffFlash.js` — green-flash decoration applied when the watcher reloads the active file and the renderer wants to highlight what changed (word-level diff via the `diff` npm package).

## View mode + editor status bar

`EditorStatusBar.jsx` is a pure-presentation strip pinned to the bottom of the editor pane, visible only when a tab is active. It shows: backlink count, view-mode toggle (live ↔ raw), word count, character count, and save state. All state lives in `App.jsx`:

- `viewMode` (`VIEW_MODES.LIVE` | `VIEW_MODES.RAW` in `constants.js`) is persisted to settings and passed into `<Editor>`. The Editor toggles a CodeMirror Compartment carrying the live-preview decoration bundle without rebuilding the view — cursor, history, and scroll all survive a reconfigure. Only the `dark` prop forces an editor recreation. The `markdown()` extension always loads with `SetextHeading` removed (ATX headings only — `=== / ---` underline headings are intentionally unsupported).
- `editorStats` (`{ words, chars }`) is computed inside `Editor.jsx` (`computeStats`) and pushed up via the `onStats` callback (rAF-throttled).
- `saveState` (`SAVE_STATES.SAVED` | `SAVE_STATES.UNSAVED`) is set to UNSAVED on every editor change and flipped back to SAVED inside `writeNow()` — but only if `dirtyTabIdRef.current === null` after the write, so a write that races a subsequent edit doesn't flash SAVED prematurely.
- "Hide line numbers" (appearance setting) doesn't remove the gutter — it keeps the reserved width so the text column doesn't shift. The host element class drives CSS that hides the digits + active-line highlight.

## Image pipeline (renderer side)

For the `app://media/...` protocol see `src/main/CLAUDE.md`. Renderer pieces:

- **`imageWidgets.js`** — replaces `![alt](url)` ranges with an `ImageWidget` (`Decoration.replace`). Builds decorations by regex-scanning the visible ranges; rebuilds on `docChanged || viewportChanged || selectionSet` so that placing the cursor on the image's range reveals the raw markdown (same convention as `markdownLinks.js`). `resolveImageUrl` handles relative URLs (against active file's folder), absolute paths (workspace-root-relative), `http(s)://`, `data:`, `app:`, `file:`. Anything that resolves outside the workspace returns null and the source stays visible. The widget detects a wrapping `[…](url)` link via the syntax tree and, if present, makes the image click-open the link; otherwise its `ignoreEvent` lets CM place the cursor on a single click so the user can select/edit.
- **`imagePaste.js`** — handles both clipboard paste and drag-drop into the editor. Pasted screenshots arrive without a name → fall back to a timestamped `"Pasted image …"`; dropped files use their original basename. Multiple images get one `![](filename)` per line. The main-process `fs:writeImage` handler runs the chosen base through `uniquePath` (same-dir uniqueness) so collisions get `" 1"`, `" 2"`, … appended. For draft tabs (no file on disk yet), the plugin calls `flushDraftToDisk` to force the pending save through the normal `writeNow` path — the draft turns into a real file, the image lands next to it. The load effect's "same tab, last path was null → skip" rule keeps the buffer intact across the resulting `activeFile` change.

**Sidebar→editor image drag**: dragging an image from the file tree into the editor inserts a relative `![](…)` reference to that workspace file. react-arborist's react-dnd backend is **scoped to the tree element** via the `<Tree dndRootElement={wrapRef.current}>` prop (`FileTree.jsx`), so it no longer owns window-wide drag events — the editor receives the native drop cleanly. The tree row sets the workspace-absolute path under a custom dataTransfer MIME (`SIDEBAR_IMAGE_MIME`, exported from `imagePaste.js`) on `dragstart`; the editor's `dropPlugin` reads it back via `getData` on `drop`. The drop is still attached via `view.contentDOM.addEventListener` (not CM6's `domEventHandlers`) so it can `stopImmediatePropagation` before CM6's built-in drop handler runs — CM6 would otherwise `readAsText` the image bytes and insert garbage (this is about CM6's own behavior, unrelated to react-dnd). The image-row `dragstart` still `stopPropagation`s react-arborist's drag source so image rows drag-to-embed rather than tree-reorder.

## Coding agent (renderer side: chat sidebar)

Right-side chat sidebar (`ChatSidebar.jsx`) backed by `@earendil-works/pi-coding-agent`. The sidebar is collapsed to a 28px strip by default; clicking the strip expands it. State (`chatSidebarOpen`, `chatSidebarWidth`) is persisted to settings.

For the main-side session lifecycle (session keying, skills, agent-tokens bridge, failed-image guard, system prompt) see `src/main/CLAUDE.md`.

### Event protocol consumed by the sidebar

`agent_start` / `agent_end` gate the running state. `turn_end` carries pi's normalized `usage` (we sum `totalTokens` across turns; each turn re-pays for context so the sum matches billed usage). `message_update` carries `assistantMessageEvent` which is either `text_start` (open a new assistant bubble) or `text_delta` (append to current bubble). `tool_execution_start` / `tool_execution_update` / `tool_execution_end` build collapsible tool entries keyed by `toolCallId`. Assistant text is rendered through `react-markdown` + `remark-gfm`. The sidebar also runs an elapsed-time ticker and a shimmer "Working" indicator while pi is running.

**`MessageRow` is wrapped in `React.memo`** so typing in the composer doesn't re-parse every prior assistant bubble's markdown through `react-markdown`. Keep `MessageRow`'s prop surface narrow (just the message object) — adding non-memoized callbacks would defeat this.

### Workspace change

The chat sidebar is mounted with `key={workspacePath ?? 'no-workspace'}` in `App.jsx`, so switching workspaces remounts it and clears the transcript. The pi session itself is reset lazily on the next send (because the session key changes).

### Attachments (`chatAttachments.js`)

The composer accepts images (PNG/JPEG/GIF/WebP) and a long list of text/code file extensions, via the paperclip button, paste, or drag-drop onto the sidebar. Images are sent as pi's `ImageContent[]` shape; text files are inlined into the prompt as `<file name="…">…</file>` blocks before the user's typed message. Rejected files (unsupported format or read error) surface a dismissible inline error.

### Voice input (composer mic button)

The composer's microphone button uses `voice/useVoiceInput.js`, which streams 16kHz PCM via the Web Audio API + an inline `AudioWorklet` to AssemblyAI's real-time WebSocket. The flow:

1. Renderer asks main for a short-lived (60s) streaming token via `voice:getToken`. The long-lived AssemblyAI API key never leaves main.
2. `useVoiceInput` prefetches a token on mount and caches it for 50s; on click it consumes the cached token instantly and kicks off a background refresh so the next click is also instant. Without this, every click would pay the renderer→main→AssemblyAI round-trip.
3. `navigator.mediaDevices.getUserMedia({audio: true})` opens the mic, fed into an `AudioContext({sampleRate: 16000})` and through an `AudioWorkletNode` running a tiny PCM-buffering processor registered inline via a Blob URL (no separate static file).
4. The worklet posts 4096-sample Float32 chunks back to the main thread; we convert to `Int16` and send over the WebSocket, while emitting per-chunk RMS volume for the `VoiceBars` visualization (`voice/VoiceBars.jsx`).
5. AssemblyAI returns `Turn` messages — partials (`end_of_turn: false`) call `onPartialTranscript`; finals (`end_of_turn: true`) call `onTranscript`. The composer renders partials in a faded color and commits finals into the text.

**Mic permission gotcha**: Electron prompts for microphone access on the first `getUserMedia` call and persistently grants it for the origin. The Settings → Transcription "Test microphone" button (`settings/TranscriptionSection.jsx`) exists primarily so users can trigger that one-time prompt in Settings, where they expect it — without it, the first click of the chat composer's mic would prompt mid-conversation. The "Test microphone" UI also verifies the key works end-to-end.

## GitHub sync (renderer side)

The engine lives in main (see `src/main/CLAUDE.md`); the renderer just bridges three things.

**Mount-only subscription.** `App.jsx` subscribes once on mount (no workspace dep) to two push events: `sync.onFlushRequest` and `sync.onStatus`. Same discipline as the `fs:changed` listener — do NOT add per-render objects (`writeNow`, `linkIndex`, etc.) to deps. `writeNow` is read via `writeNowRef.current()`, so the closure stays stable. If the listener tore down per render, an in-flight tick could lose its flush ack.

**Engine start on workspace switch.** `loadWorkspace` calls `window.api.sync.engineStart({ workspacePath, intervalSeconds })` after `watchStart`. The engine self-checks for an origin + PAT and emits `disabled` if either's missing, so the renderer doesn't gate on those locally. The mount-effect cleanup calls `engineStop` so a full reload doesn't leave a tick running against a torn-down window.

**Status icon.** `EditorStatusBar.jsx`'s `SyncStatusIcon` maps the 6 statuses to one icon each: `unconfigured` → **hidden**; `idle` + `lastSyncAt===null` → gray `Cloud` ("not synced yet"); `idle` + set → `CloudCheck`; `syncing` → spinning `Refresh`; `offline` → `CloudAlert` (amber, "retrying"); `paused` → yellow `AlertTriangle` (click → conflict view via `onOpenConflicts`); `disabled` → `Stop` (click → a small popover with the reason + an **Enable** button → `onEnableSync` → `setWorkspaceDisabled(false)`). Idle/syncing/offline still click through to the repo URL when known.

### Conflict-resolution view

When `syncStatus.conflicts` is non-empty, a red conflict toggle appears at the **far right** of the `SortBar` (with a count) and the red sync icon links to it; clicking either flips the file tree into a conflict-only view (`conflictFilterActive` in `App.tsx`). It auto-exits when the list clears.

- **Data source is the git conflict list, NOT the file tree.** `buildConflictTree(absPaths, workspacePath)` constructs folder/file nodes straight from `syncStatus.conflicts` (rel→abs). The normal tree (`buildTree`) hides dotfiles, but conflicts happen in them (`.obsidian/workspace.json`), so the view is built independently — any file type, including hidden, shows up.
- **Review-only.** Right-click a file → **Conflict resolved** / **Keep our file** / **Reset to remote** (`FILE_ACTIONS.RESOLVE`/`KEEP`/`RESET` → `conflictFileAction` → `sync.resolveConflict`/`keepConflict`/`resetConflict`). Resolve flushes the file first (`writeNow`) so git stages the user's edits, not stale on-disk content.
- **Whole-tree** actions live on the cloud icon's **right-click** (`showConflictCloudMenu` → `keep`/`reset` → confirm dialog → `sync.keepAll`/`resetToRemote`). Both are behind a `ConfirmDialog` (destructive).
- The view refreshes from the engine's `sync:status` push (fewer conflicts / idle), not the watcher — the watcher ignores dotfiles and `git add` changes nothing on disk.

**Settings.** Two UI files under `settings/`:
- `SyncSection.jsx` — global PAT (verify button hits `sync:verifyPat`), interval slider, and a git-presence check that runs once on mount.
- `WorkspaceSyncDialog.jsx` — per-workspace setup picker (three choice cards: clone into empty, init+create new repo, adopt existing local `.git`). Launched from `WorkspacesSection.jsx`.

## Send to Agent

The editor context menu offers "Message Agent" when the active file has a path on disk (`EDITOR_ACTIONS.SEND_TO_AGENT`; drafts opt out). It builds a framing snippet (`buildSendToAgentSnippet` in `App.jsx`) with a `[cwd]/...` workspace-relative path plus selection or cursor coordinates, fences any selected text in `~~~`, and injects it into the chat composer:

- Sidebar closed → expand it, queue the injection in `pendingComposerInjection`, drain via an effect once the sidebar's imperative ref attaches (`chatSidebarReady` flag flips on a callback ref).
- Sidebar open with empty composer → inject directly.
- Sidebar open with existing text → open a Dialog asking Replace / Append / Cancel.

The chat sidebar exposes `setComposerText(text, { append })`, `getComposerText()`, `focusComposer()` via `useImperativeHandle` for this flow.

## Bookmarks

**Bookmarks are `.md`-only and identified by basename, not path.** Only `.md` files can be bookmarked (the context menu offers it only for `.md`); the link index already guarantees `.md` basenames are workspace-unique, so the name alone identifies the file and its location is resolved on click via `linkIndex.pageIndex` (basename → path). **Tracking the name is what makes moves free** — moving a file between folders doesn't change its basename, so there is no per-move bookmark bookkeeping. Only a *rename* (which changes the basename) re-keys, and that rides along with the existing wiki-link rename rewrite.

Stored at `<workspace>/.shockwave/bookmarks.json` as `{ version: 1, names: ["recipes", ...] }` (lowercased basenames). The `.shockwave/` segment matches the watcher's dotfile-ignore predicate so our own writes don't echo back. The renderer keeps an in-memory `Set<basenameKey>` (`bookmarkKey(path)` = basename, no `.md`, lowercased — the same key `pageIndex` uses). On workspace load `seedBookmarks(names, resolvableKeys)` prunes names whose `.md` file is gone and rewrites if pruned. No migration from the old path format — by design.

Toggle via the file context menu (`FILE_ACTIONS.TOGGLE_BOOKMARK`, `.md` only) or the bookmark icon in the sort bar. `renameBookmarkName(oldKey, newKey)` / `removeBookmarkName(key)` / `persistBookmarks` keep the set in sync; the watcher's `fs:changed` rename/unlink handlers and the two in-app rename spots (`onTreeRename` file branch, `onTitleCommit` → `performRename`) call them — a *move* hits `renameBookmarkName` with equal keys and no-ops. The sort bar's bookmark button toggles a filter mode that prunes the tree to only bookmarked files (and the folders that contain them); right-click opens a picker — App resolves each bookmarked name → current path (`bookmarkItems`) so the picker can open it and show its folder.

## Daily notes

Calendar button in the `ThinSidebar`:
- Click → open today's daily note (create if missing).
- Right-click → opens `JournalDatePicker` (a `react-day-picker` popover anchored at the cursor) to pick any date.

Settings → Daily Notes lets the user choose a dayjs format string (`YYYY-MM-DD`, `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY/MM/YYYY-MM-DD`, or custom) and a workspace-relative folder via `FolderCombobox`. `dailyNote.js` formats the date and computes `{ dir, name, absPath }` — slashes in the format become subfolder boundaries beneath the configured folder. `openJournal` in `App.jsx` looks the basename up in `pageIndex` first (so an existing note anywhere in the workspace is opened in place, regardless of where the format would put it), and only `ensureDir` + `createFile` when it doesn't exist.

## Quick search & sort bar

- **`SortBar`** (above the file tree): bookmark filter toggle, quick-search opener, sort menu, collapse-all. The sort menu offers Name asc/desc, Modified new→old/old→new, Created new→old/old→new (`TREE_SORT_ORDERS` in `constants.js`). Folders always stay first in A→Z order; the sort only re-orders files inside their folder. Sort is persisted to settings. `buildTree` in main stats every file for `mtimeMs` and `birthtimeMs` so the renderer can sort without re-statting.
- **`QuickSearch`** (`QuickSearch.jsx`): modal launched from the sort bar. Empty query → top 10 files by the active sort order. With a query → `fuzzysort` ranks every file by workspace-relative path so typing `j/2026` finds `Journal/2026-05-24.md`. Matches are highlighted via `segmentsFromIndexes`. Arrow keys + Enter; Esc closes.

## Settings sub-folder

`SettingsModal.jsx` is the host; each section lives in `settings/`:

- `AppearanceSection.jsx` — theme mode, hide-line-numbers.
- `WorkspacesSection.jsx` — list/add/remove/switch workspaces (folder picker via `dialog:openFolder`). Each row offers a Sync button that opens `WorkspaceSyncDialog`.
- `DailyNoteSection.jsx` — format presets + custom format + `FolderCombobox` for the target folder.
- `SyncSection.jsx` — global GitHub sync settings: PAT (encrypted at rest), tick interval, `sync:verifyPat` button, `sync:checkGit` presence check.
- `WorkspaceSyncDialog.jsx` — per-workspace setup picker (three choice cards: clone into empty / init+create new / adopt existing). Launched from `WorkspacesSection.jsx`.
- `TranscriptionSection.jsx` — AssemblyAI API key + "Test microphone" button (see Voice input above).
- `AgentChatSection.jsx` — provider/model/API key + reasoning level. The system prompt is no longer editable here — it's assembled from the workspace's `SOUL.md` + the internal helper (see `src/main/prompt/`); the section just points users at `SOUL.md` / `AGENTS.md`. Provider + model lists are fetched live from main via `agent:listProviders` / `agent:listModels`.
- `AiSkillsTab.jsx` (Global Skills) — drop folder / pick folder to import a SKILL.md-bearing folder into the library; enable/disable each skill globally; remove.
- `WorkspaceSkillsTab.jsx` (Workspace Skills) — per-workspace override: `inherit` / `enabled` / `disabled`. Workspace picker defaults to the active workspace.
- `AgentSecretsSection.jsx` — add/edit/delete tokens with `{name, description, token}`; names are unique case-insensitive; tokens are encrypted at rest.

The modal's title-bar shows a small `Saving…` / `Saved` / `Save failed` badge driven by `saveStatus` in `App.jsx` (`persistSettings` increments an in-flight counter so overlapping writes don't flash `saved` early). The save badge fades back to idle 1.5s after the last write completes.

## Theme & design tokens

Three modes (`light` / `dark` / `system`) stored in settings; system mode listens to `nativeTheme` updates via `theme:systemChanged`. The effective theme is set on `document.documentElement.dataset.theme` and also re-passed into the Editor (which recreates the view to swap the light/dark syntax highlight style).

**Tokens live in `app.css`** (the Tailwind v4 entry, imported by `main.tsx` and processed by `@tailwindcss/vite` — the plugin is registered in `electron.vite.config.js`'s renderer section). It defines the shadcn semantic tokens (`--background`, `--primary`, `--border`, …) plus app-specific ones (`--selected` accent-soft fill, `--sidebar`, `--chrome`, `--chat`, `--raise`, `--success/-soft`, `--bullet`, `--folder`, `--code-chip`, amber `--ring`) in light + dark, and maps them to Tailwind utilities via `@theme inline` (`bg-selected`, `text-muted-2`, `bg-chrome`, `font-chat`, …). Dark mode is a custom variant on `[data-theme="dark"]` — do NOT introduce a `.dark` class.

The palette is the "polish spec": warm neutrals, one indigo accent (#5B57D8 light / #7D79E8 dark) used only for active/primary, amber keyboard-focus ring, JetBrains Mono for code/paths/line numbers, Instrument Sans (`font-chat`) for chat-panel message text only. All three fonts are self-hosted in `assets/fonts/` — never load fonts from the network.

`app.css` is the app's ONLY stylesheet (`styles.css` is gone). Its bottom section is a clearly-banner-marked **unlayered legacy block** — CodeMirror widget styling (`.cm-*`), `.chat-markdown` typography, the Excalidraw sizing rule, `.image-drag-ghost`, the legacy `--bg-*`/`--fg-*` tokens those rules use — kept unlayered because CodeMirror injects its own runtime styles and ours must keep beating Tailwind's layers. Never add component classes there; style components with Tailwind utilities inline. Also beware: react-arborist rows receive an inline `paddingLeft` (the nesting indent) that beats any class padding — see FileTree's Node.

## Reusable UI primitives

shadcn/ui components live in `components/ui/` (installed via `npx shadcn@latest add <name>`, config in `components.json`, `cn()` in `lib/utils.ts`, `@/*` alias → `src/renderer/*`). Icons: `lucide-react` (a few app-specific ones remain in `Icons.tsx`).

**Updating vendored components:** `npm run ui:diff` shows upstream drift for every installed component (`npm run ui:diff -- button` for one). It's read-only. To update: `npx shadcn@latest add <name> --dry-run`, review, then merge preserving local edits — `sonner.tsx` is intentionally customized (data-theme instead of next-themes) and will always show drift.

- `Dialog.tsx` — legacy-API wrapper (`open/onClose/title/children/footer`) over shadcn Dialog; portal + focus trap come from Radix.
- `ConfirmDialog.tsx` — shadcn AlertDialog two-button confirm (`destructive` prop → red action).
- `ErrorMessage.tsx` — shadcn Alert (destructive) banner.
- `QuickSearch.tsx` — cmdk Command in a Dialog; fuzzysort does the ranking (`shouldFilter={false}`).
- `Combobox.tsx` / `settings/FolderCombobox.tsx` — custom input + filtered listbox (freeForm typing), Tailwind-styled.
- Toasts: `sonner` `<Toaster>` mounted in `App.tsx` OUTSIDE the `.app` grid (a stray grid child adds an implicit row and squeezes the layout). Use `toast()` for background events only; inline errors stay `ErrorMessage`.

## UI conventions (read before building any new dialog / settings page)

**Everything new is Tailwind + shadcn.** Compose `components/ui/*` primitives; style with Tailwind utilities against the semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`, `bg-selected`, `bg-raise`, …). Never hardcode hex colors, never use `dark:` overrides for colors the tokens already handle, no `style={{}}` for colors/borders/fonts.

**Templates:**
- New settings section → copy `settings/AppearanceSection.tsx`: `<SettingsSection title description>` + `<SettingsGroup title>` per concern + `<SettingsDivider />` between groups (scaffolding in `settings/SectionUI.tsx`, 360px measure; pass `wide` for entity lists). Controls: shadcn `Field`/`FieldLabel`/`FieldDescription`, `Input`, `InputGroup` (Show/Hide, Verify addons), `Select`, `Checkbox`, `Switch`, `Slider`, `Button`. Wire into `SettingsModal.tsx`'s NAV + `SETTINGS_SECTIONS` in `constants.ts`.
- New modal dialog → shadcn `Dialog`/`DialogContent`/`DialogHeader`/`DialogFooter` (or the legacy-API `Dialog.tsx` wrapper); confirms → `ConfirmDialog`. Footer buttons: `Button` (default = primary, `variant="outline"` = cancel, `variant="destructive"` = irreversible).
- **Button hierarchy: at most ONE primary (purple, default variant) button per settings page / dialog** — the page's main action. Everything else is `outline` (secondary), `ghost` (row icons), or `destructive`. Form-only pages (auto-saving selects/switches) have zero primaries.
- Icon buttons in chrome: 26px hit targets `size-[26px] rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground`; rail buttons 34px. Active state: `bg-selected text-primary`.
- Menus → `DropdownMenu`; anchored pickers that must not own left-click → controlled `Popover` + `PopoverAnchor` (see SortBar's bookmark picker).

**Other rules that still hold:**
- Labels describe the control, not the section ("Color theme", not "Theme" again).
- Validation/operation error → `<ErrorMessage>`; helper text → `FieldDescription` / `text-xs text-muted-foreground`; success note → `text-xs text-success`.
- Entity lists (workspaces, secrets): rows as `flex items-center justify-between rounded-lg border border-border px-3 py-2.5`.
- Paths/URLs/tokens/commands render in `font-mono` (JetBrains Mono).

## Path helpers (`pathUtils.js`)

POSIX-only helpers: `basenameOf`, `dirOf`, `toRelPath`, `toAbsPath`. The renderer always uses forward slashes regardless of OS (workspace paths come in this form from main, and we keep them that way for link parsing, sidebar drag-drop, etc.). **Do not import `node:path`** — it's unavailable behind contextIsolation.

## Renderer-only constants (`constants.js`)

Re-exports cross-process constants (`APP_NAME`, `FILE_ACTIONS`, `FOLDER_ACTIONS`, `EDITOR_ACTIONS`, `SUPPORTED_PROVIDER_SLUGS`, `DEFAULT_PROVIDER_SLUG`) from `src/shared/constants.js`. Renderer-only additions: `SETTINGS_SECTIONS`, `THEME_MODES`, `VIEW_MODES`, `SAVE_STATES`, `TREE_SORT_ORDERS`, `TREE_SORT_LABELS`.
