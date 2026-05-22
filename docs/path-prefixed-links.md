# Path-prefixed links (future direction)

Status: design brain dump, not implemented. The current app auto-disambiguates
file names to be workspace-wide unique. This doc captures the design for the
Obsidian-style "duplicates allowed, paths disambiguate" model so we can pick it
up when we're ready.

## What it changes for the user

Today: every file has a unique basename across the workspace. If you rename
`/people/Bar.md` to `Foo` and `/projects/Foo.md` already exists, the IPC
auto-renames you to `Foo 1.md`. You can never have two `Meeting.md` files in
different project folders.

After: duplicate basenames are allowed. Links carry just enough path to
disambiguate.

- Unique basename in the workspace → `[[Foo]]`
- Duplicate basenames → `[[projects/Foo]]`, `[[people/Foo]]`
- "Shortest path that disambiguates" — same as Obsidian's default.

## The hard part: bidirectional re-disambiguation

When a duplicate appears or disappears, **existing links in unrelated files
have to be rewritten**. This is the thing that makes path-prefixed links a
real architectural change, not a parser tweak.

- A second `Foo.md` is added → every existing `[[Foo]]` ref that resolved to
  the original gets promoted to `[[projects/Foo]]` (or whatever the shortest
  unique prefix is). The new file's incoming refs go in as `[[people/Foo]]`.
- One of the duplicates is renamed/deleted → all `[[projects/Foo]]` refs to
  the surviving file get simplified back to `[[Foo]]`.

This runs on every add/rename/delete that flips a basename's uniqueness. It
runs in the same code path for in-app ops (synchronously, before tree refresh)
and for external ops (in the watcher's `rename`/`add`/`unlink` handlers).

## What changes in code

### Parser (both `src/linkIndex.js` and `electron/linkParser.js`)

`normalizeTarget(raw)` returns a structured object instead of a lowercased
basename string:

```js
{
  pathSegments: ['projects', 'subdir'],  // empty array for bare names
  basename: 'foo',                        // lowercased
}
```

`LINK_RE` doesn't change — `[[a/b/Foo]]` already matches because the body
regex allows `/`. The difference is in how `parseLinks` consumes the captured
text. Both parsers must stay in lockstep — `tests/parserParity.test.js`
enforces this.

### Link index (`src/linkIndex.js`)

- `pageIndex` value changes from `string` (single path) to `string[]` (all
  paths sharing this basename).
- `outgoingByFile` keys stay as full paths; values become the array of raw
  targets the file's links resolve to (still keyed by some canonical form).
- `backlinks` is the painful one. Today it's keyed by lowercased basename.
  That has to change to "resolved target file path" — otherwise a `[[Foo]]`
  in one folder and a `[[Foo]]` in another folder both end up under the same
  key even though they resolve to different files. So:
  - `backlinks: Map<absoluteFilePath, Entry[]>` (was `Map<basename, Entry[]>`)
  - Resolution happens at index-write time. When `updateFile(path, content)`
    runs, it parses links, resolves each to a target file path (using the
    rules below), and stores the entry under that resolved path.
  - When the resolution result changes (because uniqueness flipped), the
    affected backlinks have to be re-bucketed. That's the bidirectional
    rewrite mentioned above.

### Resolver (new — `src/linkResolver.js`)

Pure module, unit-testable in isolation. Two functions:

```js
resolveLinkTarget(targetParsed, sourceFilePath, pageIndex)
  → absoluteFilePath | null

shortestUniqueLinkFor(targetFilePath, pageIndex, sourceFilePath)
  → string  // the [[…]] body to write for this link
```

Resolution rules (Obsidian-compatible):

1. If `targetParsed.pathSegments` is non-empty: look up the file at the
   relative path from workspace root. If it exists and ends in `.md`, return
   it. Otherwise null (unresolved).
2. If `pathSegments` is empty (bare `[[Foo]]`):
   - Look up `pageIndex.get(basename)`. Returns 0, 1, or N paths.
   - 0 → null (unresolved, render dim).
   - 1 → return it.
   - N → tiebreaker: prefer the one in the same folder as `sourceFilePath`,
     else prefer the one with the shortest workspace-relative path, else
     return null and render as ambiguous (a separate visual state from
     unresolved would be ideal — orange-yellow vs grey).

`shortestUniqueLinkFor`:

- If basename is unique → return `Foo`.
- Else compute the shortest path suffix that uniquely identifies the file
  among the other candidates. Walk up from the file's immediate parent
  folder, adding segments until the prefix excludes all other candidates.
  Examples:
  - `/a/Foo.md` vs `/b/Foo.md` → `a/Foo` and `b/Foo`
  - `/x/a/Foo.md` vs `/y/a/Foo.md` → `x/a/Foo` and `y/a/Foo`
  - `/a/sub/Foo.md` vs `/b/Foo.md` → `sub/Foo` and `Foo` (sub is unique; b is
    the only one with no `sub` in its path so it stays bare). Note this
    differs from Obsidian's "always include the disambiguating prefix" rule
    — pick one approach and document it.

### Rename (`src/renameOps.js`)

`rewriteReferences` today uses a regex against `[[OldName(#h|alias)?]]`. That
breaks under path-prefixed links — `[[projects/Foo]]` won't match the regex
even though it resolves to the renamed file.

The right shape:

```js
for (const sourceFile of getBacklinks(targetFilePath)) {
  const content = await api.readFile(sourceFile);
  const parsed = parseLinksWithPositions(content);  // includes char offsets
  for (const link of parsed) {
    if (resolveLinkTarget(link.parsed, sourceFile, pageIndex) === renamedFile) {
      // rewrite this link's [[…]] body to shortestUniqueLinkFor(newRenamedFile, ...)
    }
  }
  // splice the new bodies back into content, write
}
```

So we go from regex-replace to parse-edit-serialize. Less brittle, but
needs the parser to return character offsets so we can do precise splices.

### Auto-promotion / auto-simplification

Hook into `updateFile`, `removeFile`, `renameFile` in the link index. After
each mutation, look at the basenames whose uniqueness might have changed and:

- For each basename that just became ambiguous (1 → N): walk every existing
  backlink entry that resolves to one of the affected files. Rewrite the
  link body to its new shortest-unique form. Update the file on disk.
- For each basename that just became unique (N → 1): same idea in reverse,
  simplifying to bare basenames.

This is what guarantees the invariant "every `[[Foo]]` in the workspace
resolves to exactly one file." Without it, you can end up with stale
`[[projects/Foo]]` refs lingering after the duplicate gets deleted.

The watcher path needs this too. When the renderer's `'rename'` /
`'add'` / `'unlink'` handlers run, they must call into the same auto-
promote/simplify logic.

### Autocomplete (`src/wikiCompletions.js`)

Show the disambiguating path in the completion's detail text when a basename
has multiple matches. On select, insert `shortestUniqueLinkFor(...)`.

### Wiki-link rendering (`src/wikiLinks.js`)

Resolved-vs-unresolved test goes from `pageIndex.has(basename)` to
`resolveLinkTarget(parsed, sourceFile, pageIndex) != null`. Optionally add a
third visual state for "ambiguous" (multiple resolution candidates, none
disambiguated).

### `findNameConflict` and the title input

The live "another file has this name" warning becomes informational rather
than a hard stop. Renaming `Bar.md` to `Foo` when `/other/Foo.md` exists is
allowed; it just causes auto-promotion of existing `[[Foo]]` refs.

### IPC handlers (`electron/main.js`)

`fs:renameFile`, `fs:moveItem`, `fs:createFile` stop auto-disambiguating.
`uniqueInWorkspace` and `collectMarkdownBasenamesLower` go away. Same-folder
collisions (two files with the same name in the same folder) still throw
because the filesystem itself rejects them on case-sensitive FSes and APFS
default is case-insensitive — so this is a hard collision regardless of
link semantics.

## What stays the same

- The rename correlator (`electron/renameCorrelator.js`) is unaffected.
  Inode + hash pairing is independent of how links are resolved.
- The folder rename re-keying logic in `App.jsx` is unaffected.
- The save lifecycle, watcher debouncing, mtime self-echo guard — all
  unchanged.
- The four invariant rules in CLAUDE.md (link-index sync, tree refresh,
  parser parity, save before mutating active file) all still apply.

## Tests to add

Mirror the current tests but exercise the new resolution rules:

- `tests/linkResolver.test.js` — pure unit tests for `resolveLinkTarget` and
  `shortestUniqueLinkFor`. Cover: bare unique, bare ambiguous (same-folder
  tiebreaker, shortest-path tiebreaker, neither → ambiguous), path-prefixed
  exact match, path-prefixed miss.
- Extend `tests/linkIndex.test.js` with path-prefixed input fixtures.
- Extend `tests/parserParity.test.js` with `[[a/b/Foo]]` and edge cases like
  `[[a/Foo#H|D]]`.
- Extend `tests/renameOps.test.js` to assert: renaming a file in a
  collision-set causes other refs to auto-promote/simplify correctly.
- Extend `tests/linkingSystem.e2e.test.js` with the bidirectional flip:
  add a duplicate `Foo.md` and assert existing `[[Foo]]` refs become
  `[[folder/Foo]]`; then delete the duplicate and assert they collapse back.

## Effort estimate

~400–600 lines of net new code (resolver, auto-promote logic, parser
changes, rename rewriter rewrite). Plus a comparable amount of test code.
The pure modules (resolver, parser, index) can be landed first behind
their existing surface, then consumers cut over.

## Order of work when resuming

1. `src/linkResolver.js` — pure module, unit tests pass first.
2. Update both parsers to return structured target info. Update
   `parserParity` tests.
3. Refactor `pageIndex` from `Map<basename, path>` to
   `Map<basename, path[]>`. Update consumers (wiki-link widget,
   autocomplete, graph view).
4. Refactor `backlinks` to key by resolved path. This requires the resolver
   to be wired in.
5. Add auto-promote/simplify hooks into `updateFile`/`removeFile`/
   `renameFile`. New tests for the bidirectional rewriting.
6. Rewrite `rewriteReferences` against the new model. Update
   `tests/renameOps.test.js`.
7. Update autocomplete and link widget to use the resolver.
8. Remove `uniqueInWorkspace` workspace-wide auto-disambiguation. Keep
   the live warning informational only.
9. Extend the e2e test for bidirectional flip.

## Alternative considered: keep auto-disambiguation, never implement this

For solo users with strong "every note has a unique name" discipline, the
current model is fine. The disambiguation is invisible (auto-numbers the
colliding file). Users only feel the friction if they want hierarchical
organization with reused names — typical for project-folder workflows where
each project has its own `Meeting.md`, `Notes.md`, etc.

If we never get a user complaint about it, this whole doc stays in `docs/`
unused. The four changes already shipped (correlator, folder rename,
collision check, self-refs) don't depend on this — they hold under either
model.
