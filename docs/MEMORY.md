# Agent memory

Design notes for adding persistent memory for the chat sidebar's coding agent. Captures what's been settled in discussion, what's still open, and the reasoning behind the shape.

## What memory is

Persistent context the agent accumulates across sessions: user preferences, project conventions, things it has learned about the workspace. Memory is for the agent. The user can see and edit it but doesn't need to engage with it — it sits in the workspace like any other content.

## Settled shape

**Memory is markdown files in the workspace.** Many small files, one per memory entry, following Shockwave's existing wikilink pattern. Not one big document — that would just be a notepad with references inside it, not the graph-of-linked-files shape the rest of the app uses.

**Memory participates in the workspace's existing link index.** No second index, no parallel infrastructure. Memory files are parsed, indexed, and linked the same way user notes are. The wikilink tools (`resolve_basename`, `get_backlinks`, etc.) work on memory automatically because memory is just markdown files in the indexed workspace.

**Memory uses wikilinks like everything else.** A memory file can contain `[[ProjectX]]` to reference a user note, or `[[user-prefers-terse]]` to reference another memory. The link index resolves both transparently.

**Memory is shared between user and agent.** Both can read, edit, delete, and link to memory. The user can wikilink TO memory from their own notes — making memory part of the workspace's knowledge graph, not a hidden agent compartment. Trust property: the user can always see what the agent remembers.

## Why not the alternatives

**Why not `.shockwave/memory/` (dotfolder)?** Four sites in the codebase skip dotfile segments (`buildTree`, `collectMarkdownBasenamesLower`, `walkMarkdownPaths`, the watcher's `ignored` predicate). Memory under `.shockwave/` would be invisible to all of them, which means rebuilding the watcher pipeline AND the link index AND the tree builder in parallel. The bookmarks-style "second focused watcher" pattern doesn't apply: bookmarks is a single JSON file with a flat name list, not linked markdown content. There's no `createLinkIndex` instance for bookmarks. Adopting that pattern for memory would mean a real duplicate index, which doubles the maintenance surface.

**Why not a single `MEMORY.md`?** One file is one node with many outgoing wikilinks — it doesn't form an internal graph. That's a notepad, not a knowledge structure. Doesn't match how the rest of Shockwave uses wikilinks.

**Why not segregate at the index level (two indexes, one watcher)?** Would require routing watcher events by path to two different index instances, modifying all four dotfile-skip sites with parallel memory-skip rules, and maintaining two parallel `createLinkIndex` consumers in the renderer. Every site that today has one branch grows a second. The user pushed back on this for good reason — it's doubled code for an outcome the shared-index path achieves more simply.

## The basename namespace problem

The link index is keyed by basename, and `uniqueInWorkspace` (in `src/main/pathResolver.ts`) enforces workspace-wide basename uniqueness for `.md` files. Memory files and user files share this namespace.

Concrete consequence: if the agent saves a memory called `q4-deadline.md` and the user later creates a note with the same name, the user's gets auto-disambiguated to `q4-deadline 1.md`. Or vice versa if the agent writes second. The link index stays consistent — `[[q4-deadline]]` resolves cleanly to whichever file owns that basename — but the naming is awkward and the loser's wikilink target ends up ugly.

This is structural to the basename-keyed design. The `docs/path-prefixed-links.md` direction is the long-term structural fix (path-prefixed wikilinks like `[[Memory/q4-deadline]]` vs `[[Notes/q4-deadline]]`). Until that exists, collisions are a real but bounded cost.

How often it bites depends on what the agent actually writes about. Names like `user-prefers-terse` or `feedback-dev-server` are clearly memory-shaped and unlikely to collide. Names anchored to user content (`q4-deadline`, `deploy-process`) are likelier to collide.

## Marking memory

To filter memory out of user-facing surfaces (quick search, autocomplete, graph view, recently-modified sort), the index needs to know which entries are memory.

**Source of truth lives on disk.** The classification comes from one of:

- Filename prefix (`_memory_q4-deadline.md`)
- Frontmatter field (`memory: true` or `kind: memory`)
- Folder path (under `Memory/`)
- Sub-extension (`q4-deadline.mem.md`)

Each survives different operations differently. Filename prefix and sub-extension survive moves but rename-ugly. Frontmatter survives moves and renames but requires parsing the file body. Folder path is cheapest to check but locks memory to a location.

**Boolean cached on the index entry.** At ingest time, the classification is decided once and stored as `isMemory: true` (or `kind: 'memory' | 'note'`) on the index entry. Filter call sites then read the boolean directly — O(1) property check, not a string operation re-done per query.

The boolean isn't strictly necessary for performance at small workspace sizes — `name.startsWith('_memory_')` is fast too. The real win is at scale (a long-time user with many notes plus accumulated memory) and architectural: the marker convention can change later without touching every filter site. Filter code reads `entry.isMemory`; ingest code is the only place that knows how the marker is encoded.

The data structures involved:

- `backlinks: Map<targetLower, [{fromPath, lineNumber, lineText, contextLines}]>` — each backlink entry is already an object; adding `isMemory` is trivial.
- `outgoingByFile: Map<absPath, string[]>` — currently a plain array of target basenames; would need either a richer shape or a parallel `Map<absPath, boolean>`.
- `pageIndex` (basename → path) in the renderer — same; either richer entries or a parallel map.

## UI surface filtering

Each surface decides independently whether memory shows. Possibilities, none decided:

- **Quick search**: hide memory by default; toggle to include (matches the bookmarks-filter pattern in the sort bar).
- **Autocomplete** (`wikiCompletions.js`): exclude memory by default; show only when the user types a memory-namespaced trigger.
- **Graph view**: render memory nodes with different color / smaller / behind a "show memory" toggle.
- **File tree**: either show the memory folder collapsed under an "Agent Memory" virtual node, or just let it appear as a normal folder the user can fold.
- **Recently-modified sort**: exclude memory writes so agent activity doesn't shuffle the user's recent work.
- **Backlinks panel**: section memory backlinks below user-note backlinks.

The surfaces don't all have to agree. Each one's default reflects what the surface is for.

## Wikilink tools for the agent

Independent of memory, the agent benefits from tools that expose the link index directly rather than forcing it to grep the workspace. Targeted (one question per call), not tree-dumps:

- `resolve_basename(name) → path | null` — turn `[[Foo]]` into a real path. The single most useful tool; nothing else works without it.
- `get_backlinks(name, limit=20) → [{fromPath, line, lineText, contextLines}]` — what links to a file, with the matching line and the indented context block already collected by the index.
- `get_outgoing(path) → [name]` — what does this file link to.
- `rename_with_rewrites(oldPath, newName) → newPath` — atomic rename + workspace-wide reference rewrite. The invariants are subtle (case-insensitive match, suffix preserved, self-references rewritten); wrapping it as a tool prevents the agent from doing this unsafely via raw fs.

Tools considered and not included in the minimum:

- `neighborhood(path, hops)` — tree-dump shape. Two `get_outgoing` calls compose the same answer; better to keep the agent thinking in single hops.
- Workspace-wide `find_broken_links()` / `find_orphans()` — too broad. Per-file `broken_links_in(path)` and `is_orphan(path)` answer real questions; the workspace-wide audit can wait until a use case shows up.
- `recently_modified()` unscoped — same problem; if useful, scope it (`recently_modified_near(path)` etc.).

These work on memory files automatically because memory is in the shared index.

## Open questions

- **Marker convention.** Filename prefix vs. frontmatter vs. folder vs. sub-extension. Each has different mobility/discoverability trade-offs. Not decided.
- **Default memory location.** A configurable folder like daily notes, or a fixed default? Configuration model TBD.
- **Memory frontmatter shape.** What fields besides the classification marker? (`description`, `created`, `updated`, `type`?) Influences agent recall behavior.
- **Lifecycle.** Permanent until deleted, or mtime-decay, or confidence-scored? Probably permanent + the user can prune manually, but unclear.
- **Recall mechanism.** Preloaded list of memory titles in the agent system prompt vs. tool-driven discovery (`list_memories()`). Preload is simpler but pays tokens every session; tool-driven is lazier but adds a discovery step. Not decided.
- **Cross-workspace memory.** Memory is per-workspace by default (it lives in the workspace folder). Some memories (e.g., `user-prefers-terse`) might be user-global rather than workspace-specific. Not addressed.

## What was learned from reading the codebase

The watcher and indexing infrastructure that shapes this design:

- Four sites skip dotfile segments: `buildTree` (`main.ts:468`), `collectMarkdownBasenamesLower` (`pathResolver.ts:50`), `walkMarkdownPaths` (`pathResolver.ts:110`), the chokidar `ignored` predicate (`main.ts:1582-1588`). Anything under `.shockwave/` is automatically excluded from all four.
- The chokidar `ignored` is just a predicate function — exceptions can be carved into it (`if (rel.startsWith('.shockwave/memory')) return false;`). No need for a second watcher just to unignore a path.
- Bookmarks uses a second focused watcher (`main.ts:1603`) because bookmarks is JSON, not markdown, and needs its own event channel (`bookmarks:changed`) rather than `fs:changed`. Memory wouldn't need this — markdown content flows through the existing pipeline.
- The link index lives in the renderer (`useLinkIndex` hook wrapping `createLinkIndex` in `linkIndex.js`). Pi runs in main. Memory tools called by the agent would either query a renderer-side index via IPC or live in main with their own index instance — but since memory is just in the shared workspace index, no IPC bridge is needed; the agent uses the existing fs tools and the wikilink tools query whatever index instance answers them.
- `uniqueInWorkspace` (`pathResolver.ts`) enforces basename uniqueness workspace-wide for `.md` files. This is what creates the namespace pressure described above.
