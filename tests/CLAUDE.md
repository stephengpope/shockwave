# CLAUDE.md — tests

Node's built-in `node:test` runner. No install needed.

- `npm test` — runs every `tests/**/*.test.js`.
- `node --test tests/<file>.test.js` — run one file (useful when iterating).

## Coverage

| File | Coverage |
|---|---|
| `correlator.unit.test.js` | 13 pure-logic tests for the rename correlator: inode matching, hash fallback, grace timer, batch unlinks/adds, double-rename A→B→C, hash-collision determinism. |
| `correlator.integration.test.js` | 10 tests against real chokidar + real `fs.rename`. Single renames, batch of 10, identical-content files, rename + simultaneous delete, atomic saves not classified as renames, folder rename emitting per-file renames inside. |
| `linkIndex.test.js` | 15 tests on `createLinkIndex` invariants: `updateFile`/`removeFile`/`renameFile`/`rebuild`, mtime preservation across rename, case-insensitive backlink keys, heading/alias stripping, `getEntriesGroupedBySource` sort/group semantics, `prettyName`. |
| `parserParity.test.js` | Runs both parsers (`src/renderer/linkIndex.js` and `src/main/linkParser.js`) against the same fixtures and asserts byte-identical output. Add a fixture here when introducing new link syntax. |
| `renameOps.test.js` | 10 tests on `renameWithReferences` and `rewriteReferences` with an in-memory `fs` stub: rewrite-in-other-files, heading/alias preservation, case-insensitive match, self-reference rewriting, auto-disambiguation handling (final name differs from requested), no-op same-name rename, empty-name rejection. |
| `linkingSystem.e2e.test.js` | 12 end-to-end tests with a real tmp workspace + chokidar + correlator + the renderer-side index. Exercises every external-actor scenario: rename rewrites refs, rename rewrites self-refs, folder rename re-keys nested files, deletes, adds, in-place edits, 10 simultaneous renames, atomic save not classified as rename. |
| `workspaceWatcher.test.js` | 2 tests against a real git repo + real `git merge` (what GitHub sync runs) with main's exact chokidar config for `.shockwave/`. Asserts the dir watch (depth 0, filtered to `workspace.json`) notifies exactly once on a merge that updates `workspace.json`, and never for sibling-only changes (`bookmarks.json`, `skills/`). Guards against regressing to a single-file watch, which chokidar 5 drops. |

## What's NOT covered by automated tests

The Electron UI itself. Tabs, drag-and-drop in the file tree, title-input commit, right-click menus, editor decorations, the chat sidebar (skills, secrets, attachments, voice), image paste/drop, quick search, bookmarks, daily notes, voice transcription, theme switching — these need manual verification with `npm run dev`.
