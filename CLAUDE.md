# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — run vite + electron concurrently (vite on :5173, electron waits via `wait-on`)
- `npm run build` — vite build into `dist/`
- `npm start` — run electron against an existing build
- `npm run dist` — `vite build` then `electron-builder` (produces dmg/nsis/AppImage per `build` block in `package.json`)
- `npm test` — run the test suite (node:test, no install needed)

No linter configured.

## Architecture

Electron app with a Vite + React 19 renderer. The renderer is a markdown-workspace editor (CodeMirror 6) with wiki-links (`[[name]]`), backlinks, tabs, drafts, multiple workspaces, a force-graph view, and inline AI (Ask / Rewrite).

### Process boundary

- **Main** (`electron/main.js`): owns the filesystem, dialogs, context menus, settings persistence, `nativeTheme`, the file watcher + rename correlator, and AI streaming (`@ai-sdk/anthropic`, `@ai-sdk/openai` via `electron/aiActions.js`). All IPC handlers are registered here. Settings persist to `app.getPath('userData')/settings.json` via an atomic tmp+rename.
- **Preload** (`electron/preload.cjs`): exposes a single `window.api` surface. The renderer never touches Node — every fs/dialog/AI call goes through `window.api.*`.
- **Renderer** (`src/`): React app rooted at `src/main.jsx` → `App.jsx`. Vite root is `src/` (see `vite.config.js`); build output goes to `dist/`.

### Renderer state model

`App.jsx` is the orchestrator. Four custom hooks own the heavy state:

- `useTabs` — tabs, `activeTabId`, per-path view state, per-tab back/forward history. Tabs may be drafts (`isDraft: true, path: null`); `promoteDraft` creates the file on disk and converts the tab. Draft promotion is guarded by an in-flight map so rapid edits don't race to create two files.
- `useLinkIndex` — wraps `createLinkIndex()` (in `src/linkIndex.js`) behind a ref + a `version` counter. The counter is `bump()`ed after every mutation so consumers can re-render. `pageIndex` (basename → path, lowercase keys) is rebuilt from the tree via `useMemo`.
- `useFileOps` — rename/duplicate/delete/link-click, and the `treeAndIndexChanged()` helper that re-reads the tree and bumps the link index after any structural change.
- `useInlineAi` — drives the editor's right-click "Ask" / "Rewrite" actions. Owns the AI stream, an editor lock for the target range, and cancellation. `flushAndCancel` (in `App.jsx`) is the variant used by paths that change the active file — `writeNow` does NOT cancel the stream (the debounced save fires every ~500ms during streaming and we don't want to kill the stream).

The **Editor** (`src/Editor.jsx`) is imperative: parent gets a ref with `setContent / getText / getViewState / clear`. `App.jsx` loads content into the editor via an effect that watches `activeFile` — this decouples load timing from React state-update ordering. The `dark` prop recreates the EditorView (theme can't be reconfigured live).

### Save lifecycle

Edits are debounced (`SAVE_DEBOUNCE_MS = 500` in `App.jsx`) via `dirtyPathRef` + `saveTimerRef`. `writeNow()` flushes immediately and is awaited before any operation that would change `activeFile` (tab switch, workspace switch, rename, delete, graph toggle, `beforeunload`). When you add a new place that changes the active file, call `writeNow()` first or you'll lose unsaved edits. Use `flushAndCancel()` (writeNow + AI stream cancel + close inline AI modal) for switches that must also stop in-progress AI streaming.

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

**Terminology:** the user-facing term is **file**. Use "file" in UI strings, dialog text, button labels, and user-visible copy ("New file", "Delete file", "There's already a file with the same name", etc.). "Page" and "note" should not appear in user-visible text — they were earlier conventions that have been retired.

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
9. **Watcher does NOT touch active-file content.** External `change` events refresh tree + link index only. Re-reading editor content on disk change would clobber unsaved edits. A reload-with-prompt flow can be added later behind an mtime/dirty-state guard.
10. **Self-references are rewritten on rename.** `renameOps.js` does NOT skip `src === oldPath`. If `Foo.md` contains `[[Foo]]` and is renamed to `Bar.md`, the on-disk file ends up containing `[[Bar]]`. Don't reintroduce the skip.

### File watcher

`chokidar` v4 in main process. One watcher per active workspace (lifecycle: started in `loadWorkspace`, stopped in `loadWorkspace`/`removeWorkspace`/`before-quit`). Per-path events are coalesced within a 150ms window; `.md` adds/changes are read + parsed in main (reusing `linkParser.js`).

Events shipped to the renderer (via `fs:changed`):

- `{type:'add'|'change', path, mtime, outgoingLinks}` — .md file appeared or modified
- `{type:'unlink', path}` — .md file removed (grace window already elapsed without a paired add)
- `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` — paired by the correlator (inode primary, hash fallback)
- `{type:'tree'}` — folder change or non-.md change (tree refresh only)

The watcher only sees inside the active workspace, and the `ignored` predicate skips any path with a dotfile segment (`.git`, `.obsidian`, etc.) — mirrors `buildTree`.

### Cross-process constants to keep in sync

- `APP_NAME` lives in three places: `src/constants.js`, `electron/main.js` (`APP_NAME` const), and `package.json` (`build.productName`). Comments in each file flag this.
- `FILE_ACTIONS` and `FOLDER_ACTIONS` are duplicated in `src/constants.js` and `electron/main.js` (used by the native context menus).

### Wiki-link UX inside the editor

- `src/wikiLinks.js` — CodeMirror `ViewPlugin` that replaces `[[…]]` ranges with a clickable `LinkWidget` (calls back into `onLinkClick`, which opens or creates the target via `useFileOps.onLinkClick`).
- `src/wikiCompletions.js` — autocomplete source triggered by `[[`; reads `pageIndex` and `workspacePath` through refs so completions see live data without re-creating the editor.
- `src/taskCheckboxes.js` — interactive `- [ ]` / `- [x]` rendering.
- `src/autoLinks.js` / `src/headingStyles.js` / `src/hideMarkdownMarkers.js` / `src/bulletPoints.js` — live-preview decorations that style markdown syntax in place.
- `src/streamingInsert.js` — used by the inline AI hook to insert streamed deltas into the editor while preserving cursor behavior.

### Inline AI

Right-click in the editor → "Insert AI Response" (no selection) or "Rewrite with AI" (with selection). The modal (`InlineAiModal.jsx`) collects the prompt; `useInlineAi.run` dispatches `ai:run` with the action id + params. Main (`electron/aiActions.js`) holds the action registry — each action defines its `systemPrompt` and `buildUserMessage`. Streaming is via Vercel `ai`'s `streamText`. Adding a new action means dropping an entry in `ACTIONS` and a constant in `src/constants.js#AI_ACTIONS`. The IPC handler and hook are action-agnostic.

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

What's NOT covered by automated tests: the Electron UI itself. Tabs, drag-and-drop in the file tree, title-input commit, right-click menus, editor decorations — these need manual verification with `npm run dev`.
