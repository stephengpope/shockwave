# Second-brain revamp

Status: plan. Supersedes the direction in `path-prefixed-links.md` (eager rewriting
is rejected here in favor of lazy resolution).

## Why

Four things are being fixed at once:

1. **Duplicate filenames are silently mishandled.** Two files named `Meeting.md`
   in different folders can already appear on disk (via GitHub sync or an external
   editor — the in-app auto-rename guard never runs on those). When they do, the
   name→path map keeps one and the other becomes invisible: no backlinks, dead
   links. The app is in an invalid state the user can't see. We stop forcing unique
   names and support duplicates as first-class.
2. **Everything assumes `.md`.** New files can only be `.md`; tabs and the title
   strip the extension and can't show or edit another one. We default to `.md` but
   allow any extension, and show it wherever it isn't `.md`.
3. **The watcher and cache are heavier than they need to be.** Every structural
   change refetches the whole workspace tree over IPC and rebuilds the name index
   from scratch; the backlink store holds a second copy of much of the vault's
   text; nothing persists between launches. We move to one flat, incrementally
   maintained `path → file` map and an offset-based link store.
4. **chokidar → @parcel/watcher** for a faster native watcher.

## Decided behavior

- **Writing a link:** bare name when unique (`[[Meeting]]`); shortest folder-path
  prefix when the name is duplicated (`[[globex/Meeting]]`). No `.md` in links.
  Bare is kept for unique names because it resolves by name and survives moves;
  the path is added only when the name is ambiguous (bare would be undecidable).
- **Never persist an ambiguous link.** The path is baked in when you write it —
  autocomplete inserts it at type time, and a save-time pass is the backstop for
  hand-typed/pasted links. This edits only the file being saved (no mass rewrites,
  no sync churn). As a result the read-time tiebreaker is a rare fallback, only for
  legacy links written before a duplicate appeared or files added externally.
- **Resolving a link:** exact path if the link carries one; else bare name —
  same-folder file wins, otherwise the single match. A link inside `clients/acme/`
  resolves to that folder's `Meeting`. This covers the real workflow (links are
  co-located with their targets) with no guessing.
- **Rename** updates links pointing at the file (existing behavior, kept).
- **Move** updates links that spelled out the file's old path (new — see Phase 3).
- **A duplicate appearing/disappearing** never rewrites files (lazy). The only
  auto-rewrites of link text remain rename and move — exactly today's surface,
  so no new GitHub-sync churn.
- **Same-folder same-name** stays a hard rejection (the filesystem enforces it on
  case-insensitive APFS anyway).

## Structure of the work

Not four equal phases. Two small independent cleanups, plus one real rebuild:

- **Watcher swap** and **Extensions** are separate, small, and don't touch the
  link system — either can land first, in any order.
- **Links + cache** is the actual revamp: the flat `path → file` map, resolution,
  duplicates, offset-based backlinks, and move-updates all interlock. It's one
  connected change, done together (splitting it only creates half-built states).
  It's landed last because it's the deep one and benefits from the watcher already
  being in place.

### Watcher — chokidar → @parcel/watcher  ✅ DONE

Isolated, testable, no user-visible change. Landed: `@parcel/watcher` replaces
chokidar; the batch→correlator mapping lives in the shared `src/main/
watcherDispatch.js` (imported by main and the correlator/e2e tests for parity).
parcel-specifics handled: no-mtime events (stat in handler), atomic-save as
create-of-known-path, folder-rename via directory expansion, deletes-before-
creates ordering, dotfile filtering in-callback. chokidar removed from deps.
All 79 tests pass against real parcel; live create/delete verified through the
running app.

- Replace the `chokidar.watch(...)` block and the two watchers in
  `src/main/main.ts` (`fs:watchStart`/`stopWatcher`, ~1674–1747) with
  `@parcel/watcher` `subscribe(root, cb, {ignore})` + `.unsubscribe()`.
- **parcel events carry no mtime** — the handler must `fs.stat` each path to get
  `mtimeMs` before emitting `fs:changed`. The self-echo guard depends on the exact
  sub-ms float (`useFsWatcher.ts` + `linkIndex.mtimes`); keep shipping `stat.mtimeMs`.
- Reimplement the dotfile-segment `ignored` predicate as parcel `ignore` globs
  (`**/.*`, `**/.*/**`), or filter inside the callback. Collapse the separate
  `.shockwave` bookmarks watcher into the one subscription + a basename filter
  (parcel is always recursive; no `depth` option).
- Keep `renameCorrelator.js`, the flush/coalesce layer, and the `fs:changed`
  event shapes as-is. Re-verify the correlator against parcel's `delete`+`create`
  rename stream with `tests/correlator.integration.test.js` and
  `tests/workspaceWatcher.test.js`.
- @parcel/watcher is N-API, so its prebuilt binaries are ABI-stable across the
  Electron 42 bump — but confirm `electron-builder` bundles the darwin arm64/x64
  prebuilds in `npm run dist`.

Verify: run `npm run dev`, create/rename/move/delete `.md` files externally (in
Finder / another editor) and confirm the tree, links, and active-file reload all
still fire. Run the watcher/correlator tests.

### Extensions — `.md`-default, allow others, always show in UI  ✅ DONE

Landed: `fs:createFile` defaults `.md` but honors an explicit extension; non-`.md`
text/code files open in the editor (`isOpenable`/`TEXT_RE` in `MediaView.tsx`,
mirrored in main's `OPENABLE_RE`); tabs + editor title show the full filename via
`basenameOf` (`prettyName` untouched — still strips `.md` for wiki-link display);
the title commit routes through the shared `renameFileWithTransitions` helper
(literal rename, extension editable, md↔non-md index transitions) which the file
tree also uses; non-`.md` files stay out of the link index (`writeNow` guards on
`isMdName`). Also added the shared `isIgnoredSegment`/`IGNORED_DIR_NAMES`
(`node_modules` + dotfiles) used by `buildTree`, the walks, and the watcher.
Verified live: external `.txt` opens in the editor; tabs show `Notes.txt` /
`2026-07-09.md`. Build clean, 79 tests pass.

- `fs:createFile` (`main.ts` ~555): stop stripping/forcing `.md`; honor an
  explicit extension, default `.md` when none given. `uniqueInWorkspace` already
  handles non-`.md`.
- Draft promotion (`App.tsx` `writeNow`, ~434): let the draft carry a chosen
  extension; default `.md`. The other `createFile` callers (link-click,
  daily-note) stay `.md`.
- Make non-`.md` text files openable in the editor: extend `isOpenable`
  (`MediaView.tsx:26`), the tree-click gate (`App.tsx:595`), `OPENABLE_RE`
  (`main.ts:1789`), and QuickSearch's filter.
- **Always show the full filename, including the extension**, matching the
  sidebar (which already renders literal names). Tabs show `Meeting.md`,
  `Notes.txt`; the title shows the literal name too. Use the extension-preserving
  `basenameOf` (`pathUtils.ts:10`) for tab/title display — do NOT change
  `prettyName` (`linkIndex.js:15`), which strips `.md` for wiki-link display and
  must stay that way. Sites: `TabStrip.shortLabel` (`TabStrip.tsx:5`), the editor
  title seed (`App.tsx:1352`). The title commits through **`renameFileLiteral`**
  (already exists, `main.ts:587`) instead of the `.md`-forcing `renameFile`, so
  any extension is editable. The tree's `onTreeRename` (`App.tsx:1069`) is the
  reference implementation.
- Non-`.md` files don't join the link index (already how tree md→txt rename
  behaves — `App.tsx:1096`).

Verify: create a `.txt` from the new-file flow, edit and save it, rename a file's
extension in the title bar, confirm the tab shows `Notes.txt` and `.md` files
still show bare names.

### Links + cache — the rebuild  ✅ DONE (incl. the Obsidian-model internals)

**Internals now mirror Obsidian** (`src/renderer/metadataCache.js`, `createMetadataCache`):
`resolvedLinks` (source→dest paths, resolved eagerly at index time), `unresolvedLinks`,
backlinks as the reverse of `resolvedLinks`, and a PRIVATE incrementally-maintained
basename→paths phone book hidden behind `getFirstLinkpathDest` (rules in the pure
`linkResolver.js`). The old public `pageIndex` (rebuilt from the tree) and the
basename-keyed backlink bucket + resolve-filter are gone. The graph reads
`resolvedLinks` directly (no per-edge resolution). Rename/move reference rewrites
(`renameOps.js`) capture a context snapshot before the cache re-keys, so resolution
stays correct regardless of order. Persisted disk cache (below) unchanged. Verified:
build clean, 87 tests pass, live duplicate resolution + backlinks confirmed.

The original model/behavior notes below are retained for history.


**Landed and verified:** duplicate basenames are allowed; wiki-links resolve by
path when qualified and by same-folder→shortest tiebreaker when bare.

- Parser (`linkIndex.js` + `linkParser.js`, in lockstep) gains `parseTarget` →
  `{segments, basename}`; each parsed link carries `targetParsed`. `normalizeTarget`
  now returns the basename.
- New pure `src/renderer/linkResolver.js`: `resolveLinkTarget` (path-qualified
  with **stale-path→basename fallback**; bare with same-folder→shortest) and
  `shortestUniqueLinkFor`. 10 unit tests.
- `pageIndex` is now `Map<basename, path[]>`. Every resolution site routes through
  the resolver: in-editor widget, `onLinkClick` (creates honoring a path prefix),
  graph edges, autocomplete, bookmarks, daily notes.
- Backlinks stay basename-keyed but each entry carries `targetParsed`, and
  `getBacklinksForFile` **resolve-filters** the bucket so duplicates attribute to
  the right file (fixes the old "loser shows 0 backlinks" bug).
- Autocomplete emits one option per duplicate with a folder hint and inserts
  `shortestUniqueLinkFor` — so an ambiguous bare link is rarely authored.
- **Workspace-wide auto-disambiguation removed.** `fs:createFile` /
  `fs:renameFile` / `fs:renameFileLiteral` / `fs:moveItem` and the renderer
  conflict checks are same-folder only. `clients/*/Meeting.md` now coexist.
- Rename reference-rewrite (`renameOps.js`) is resolution-aware: rewrites only
  links that resolve to the renamed file, handles path-qualified links (swaps the
  basename segment, preserves prefix + #heading/|alias), stays backward-compatible
  for legacy/no-duplicate callers. Wired into both the in-app rename and the
  watcher echo.
- `useLinkIndex` return is memoized (stops per-render backlink recompute).

Verified live: two `Meeting.md` in different folders; `[[Meeting]]` in acme
resolves to acme's, backlinks attribute correctly, click opens the same-folder
one. Rewrite tested with a duplicate + path-qualified fixture. Build clean, 90
tests pass.

**Deferred (non-blocking):**
- *Eager move-rewrite.* When a file **moves**, path-qualified links naming its old
  location aren't re-qualified. The resolver's stale-path→basename fallback keeps
  them resolving (no dead links); re-qualification is a tidiness/edge-case refinement
  for the duplicate+move case.
- *Save-time ambiguity backstop.* Autocomplete already inserts the path form at
  authoring time; a save-time pass to qualify hand-typed ambiguous links is deferred.
- *Flat path→file map + offset-based backlinks (the memory/cold-start rewrite).*
  The correctness feature is complete on the existing derive-`pageIndex`-from-tree +
  text-in-backlinks model; the offset/flat-map restructure is a pure internal
  efficiency change and is deferred to avoid destabilizing a working system.

#### Duplicate basenames + path-prefixed links

- **Parser (both `linkIndex.js` + `linkParser.js`, kept in lockstep):**
  `normalizeTarget` returns `{pathSegments, basename}` instead of a bare string.
  `LINK_RE` unchanged. Extend `tests/parserParity.test.js`.
- **New pure module `src/renderer/linkResolver.js`** (unit-tested in isolation):
  - `resolveLinkTarget(parsed, sourcePath, fileMap) → path | null` — path given →
    exact lookup with basename fallback if stale; bare → same-folder wins, else the
    single match, else null.
  - `shortestUniqueLinkFor(targetPath, fileMap, sourcePath) → string` — the `[[…]]`
    body to write (bare when unique, shortest disambiguating prefix otherwise).
- **Centralize resolution:** the two current call sites —
  `pageIndex.has(normalizeTarget(x))` (`wikiLinks.ts:66`) and `pageIndex.get(key)`
  (`useFileOps.ts:45`, `GraphView.tsx:57`, `useLinkIndex.ts:67`) — both route
  through `resolveLinkTarget`.
- **Backlinks** re-key from basename to resolved target path (`linkIndex.js`
  `backlinks` Map; `getBacklinksForFile` guard `useLinkIndex.ts:67`). Fixes the
  duplicate-shows-0-backlinks bug.
- **Autocomplete** (`wikiCompletions.ts`): one option per duplicate with a path
  `detail`; insert `shortestUniqueLinkFor(...)` on select.
- **Rename rewrite** (`renameOps.js`): regex → parse-edit-serialize using the
  parser's char offsets (from Phase 4), so `[[folder/Foo]]` is rewritten too.
- **Move rewrite (new):** when a file moves, rewrite incoming links that named its
  old path to the new shortest form (or simplify to bare if now unique). Runs in
  both the in-app move (`onMoveItems`/`fs:moveItem`) and the watcher rename path,
  through one shared function — same discipline as rename.
- **Drop workspace-wide auto-disambiguation:** remove `uniqueInWorkspace`'s
  cross-folder renaming from `fs:createFile`/`fs:renameFile`/`fs:moveItem`; keep
  same-folder rejection. `findNameConflict`/`findTreeRenameConflict` become
  informational, not hard blocks.
- **Graph/tabs/title:** path hint on duplicate basenames (labels only).

Verify: create two `Meeting.md` in different folders; confirm co-located `[[Meeting]]`
links resolve to the right one, autocomplete inserts the path form for the other,
backlinks attribute correctly to each file, and moving one updates its incoming
path-links. Extend `tests/linkResolver.test.js`, `linkIndex.test.js`,
`renameOps.test.js`, `linkingSystem.e2e.test.js`.

#### Flat path→file map + offset-based cache

The other half of the rebuild — lands together with the resolution work above.

- **One source of truth:** `files: Map<path, {basename, mtime, ext}>`, maintained
  incrementally on each add/remove/rename — not rederived from a full `readTree`.
  `byBasename: Map<basenameLower, Set<path>>` derived and updated by delta. This
  replaces `pageIndex` (`useLinkIndex.ts:12`, the full-rebuild-from-tree map) and
  removes the O(workspace) rebuild per event. The nested tree becomes a view
  rendered from `files`, not a second source resolution depends on.
- **Incremental tree updates:** apply add/unlink/rename deltas to `tree` in place
  (the watcher already ships exact paths) instead of refetching via `readTree` on
  every structural event.
- **Offsets, not text:** backlink entries store `{fromPath, line, colStart, colEnd}`
  instead of the current full `lineText` + up-to-20 `contextLines`. Context is read
  lazily from disk/editor when the backlinks panel opens. Removes the largest
  memory duplication and provides the char offsets Phase 3's rewrites need.
- **Memoize the `useLinkIndex` return object** so `activeBacklinks` (`App.tsx:1346`)
  stops recomputing on nearly every render.
- **(Optional) Persist the index** keyed by path+mtime under `.shockwave/`, and
  reconcile on launch with parcel's `getEventsSince` — skip the full re-parse of
  every `.md` on workspace open. Add a "rebuild cache" escape hatch. Defer if
  Phase 4 is already large.

Verify: on a large workspace, confirm a single edit no longer refetches the tree
(instrument `readTree`), backlinks still render correctly from offsets, and memory
is lower. Run the full suite.

## What stays unchanged

- The rename correlator's inode/hash pairing.
- The folder-rename re-keying discipline (CLAUDE.md invariant #3).
- The save lifecycle and the sub-ms mtime self-echo guard.
- Wiki-links are still only `[[ ]]`.
- Rename/move remain the only operations that auto-edit link text.
