# CLAUDE.md — main process

Main-process internals. Code under `src/main/`. Cross-cutting invariants (terminology, link-index rules, parser parity, save-before-mutate) live in the **root `CLAUDE.md`** — read that first.

## Files

- `main.ts` — entry point. Window lifecycle, every IPC handler, watcher orchestration, settings I/O, `app://` protocol, secret encryption.
- `pathResolver.ts` — `isMdFile`, `uniquePath` (same-dir uniqueness), `uniqueInWorkspace` (workspace-wide basename uniqueness for `.md` files), `walkMarkdownPaths`, `collectMarkdownBasenamesLower`. The link index is keyed by basename, so two `.md` files sharing one breaks it; `uniqueInWorkspace` is what `fs:renameFile`, `fs:moveItem`, and `fs:createFile` call to auto-disambiguate. Folder renames stay same-folder-unique because folders aren't part of the link index.
- `linkParser.js` — ESM mirror of the wiki-link parser in `src/renderer/linkIndex.js` (intentionally kept as `.js` so both processes load the exact same module bytes — see parser-parity rule in root).
- `renameCorrelator.js` — pairs unlink+add events into rename events. See below.
- `codingAgent.ts` — pi `AgentSession` lifecycle, system-prompt override, emit-callback wrapping for the failed-image splice.
- `agentSystemPrompt.ts` — exports `DEFAULT_AGENT_SYSTEM_PROMPT`.
- `agentTokensExtension.ts` — pi extension exposing `list_agent_secrets` + `get_agent_secret`; installed via `installAgentTokensBridge` at startup.
- `skillLibrary.ts` — on-disk skill library under `<userData>/pi-agent/skill-library/<skill-name>/SKILL.md` and the workspace-override resolution.
- `sync.ts` — GitHub sync support: REST helpers (`verifyPat`, `probeWrite`, `createRepo`), URL parsing, the `gitSpawn` wrapper that injects a PAT via `GIT_ASKPASS`, git-presence check, per-workspace status, and the four setup flows (clone / init+create / adopt-existing / teardown).
- `syncEngine.ts` — singleton per-workspace tick engine. Sequential ticks (pause-if-conflicts → flush → commit → fetch → **merge** if behind → push), status state machine (with a `conflicts[]` payload on pause), per-file + whole-tree conflict resolution (`resolveConflict`/`keepConflict`/`resetConflict`/`keepAll`/`resetToRemote`), flush-renderer-dirty bridge, drain-on-quit hook.

## File watcher

`chokidar` v4. One watcher per active workspace (lifecycle: started in `loadWorkspace`, stopped in `loadWorkspace`/`removeWorkspace`/`before-quit`). Per-path events are coalesced within a 150ms window; `.md` adds/changes are read + parsed in main (reusing `linkParser.js`).

Events shipped to the renderer (via `fs:changed`):

- `{type:'add'|'change', path, mtime, outgoingLinks}` — `.md` file appeared or modified
- `{type:'unlink', path}` — `.md` file removed (grace window already elapsed without a paired add)
- `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` — paired by the correlator (inode primary, hash fallback)
- `{type:'tree'}` — folder change or non-`.md` change (tree refresh only)

The watcher only sees inside the active workspace, and the `ignored` predicate skips any path with a dotfile segment (`.git`, `.obsidian`, `.shockwave`, etc.) — mirrors `buildTree`. The `.shockwave/` segment is how we store our own per-workspace data (bookmarks) without echoing back through the watcher.

### End-to-end pipeline

The watcher is a state machine spread across `main.js` (the orchestration) and `renameCorrelator.js` (the rename pairing). The flow from chokidar event to renderer:

```
chokidar (fsevents on macOS)
   │
   ├── add/change/unlink/addDir/unlinkDir per path
   ▼
on{Chokidar}{Add,Change,Unlink}(p)
   │
   ├─ non-.md path? → set pendingTreeOnly = true; scheduleFlush() (150ms debounce)
   └─ .md path? → stat ino + hash file, hand to correlator:
                    add → correlator.onPathAppeared(p, ino, hash)
                    change → correlator.onPathSeen(p, ino, hash); pendingByPath.set(p, 'change')
                    unlink → correlator.onPathGone(p)  (buffered for 800ms grace)
   ▼
createRenameCorrelator
   │
   ├─ pairs `unlink(old)` + `add(new)` by inode (primary) or sha1 hash (fallback for FAT/SMB/etc.)
   └─ emits ONE of: { type: 'rename', oldPath, newPath } | { type: 'add', path } | { type: 'unlink', path }
        ▼
   setupCorrelator's emit callback:
        rename  → renameQueue.push(e); scheduleFlush()
        unlink  → pendingByPath.set(p, 'unlink'); scheduleFlush()
        add     → pendingByPath.set(p, prev === 'unlink' ? 'change' : 'add'); scheduleFlush()
   ▼
flushWatcher (fires 150ms after the first scheduleFlush since last flush)
   │
   ├─ renames first: read content + stat, send {type:'rename', oldPath, newPath, mtime, outgoingLinks}
   ├─ then per-path entries: unlink → send {type:'unlink', path}; add/change → read + parse + send
   └─ if treeOnly + nothing else: send {type:'tree'}
        ▼
win.webContents.send('fs:changed', evt)  →  renderer's onFsChanged
```

Pipeline invariants:

1. **The watcher windowId is captured at `watchStart`.** Subsequent flushes target that window via `BrowserWindow.fromId(watcherWindowId)`. If the window is destroyed and re-created (full reload), the watcher must be restarted to pick up the new id.
2. **Coalescing key is the path.** Multiple events for the same path within the 150ms window collapse to the latest type, with one special case: `unlink → add` for the same path collapses to `change` (atomic save pattern from vim/VS Code).
3. **The rename correlator buffers unlinks for `RENAME_GRACE_MS` (800ms).** If a paired add arrives in that window with matching inode or content hash, it's emitted as `rename` instead of separate unlink+add. After the grace period, buffered unlinks become real unlinks.
4. **Renames go through `renameQueue`, not `pendingByPath`.** They're already paired events and shouldn't be merged with per-path bursts.
5. **Self-echo guard is mtime-based.** `fs:writeFile` and `fs:createFile` return the file's `stat.mtimeMs` (sub-ms float) post-write. The renderer stores that exact value via `linkIndex.updateFile(path, text, mtime)`. The watcher's later flush re-stats and ships the same `stat.mtimeMs`. `evt.mtime > stored` is false → skip. Never substitute `Date.now()` for the renderer-side mtime — integer ms compared to a sub-ms float makes every save look fresh and the editor reloads mid-typing. See "Real mtimes everywhere" in the root invariants.
6. **Seeding runs synchronously on `watchStart`.** Every `.md` under the root is stat'd + sha1'd before chokidar starts firing events. Without this, an unlink fired immediately after startup couldn't be correlated (we'd have no prior identity to match against).

### Rename correlator (`renameCorrelator.js`)

External actors — Finder, `mv`, `git checkout`, a coding agent shelling out to `fs.rename` — bypass the in-app rename flow. Without intervention, the watcher would see a rename as unrelated `unlink(old) + add(new)` events, references in other files would break, and the link index would lose the connection between the old and new paths.

The correlator buffers unlinks and pairs them with subsequent adds:

- **Primary key: inode.** `fs.stat(p, { bigint: true }).ino` is stable across `fs.rename` on every realistic filesystem (NTFS, APFS, ext4, btrfs, xfs). The correlator stores `{path → {ino, hash}}` for every known file; on `unlink`, it buffers the identity; on `add`, it stats the new file's ino and matches against buffered unlinks.
- **Fallback: content hash.** For filesystems where ino is unreliable (FAT, exFAT, some SMB shares), the correlator falls back to matching the SHA-1 of the file contents (computed eagerly on `onPathSeen` because the file is gone by the time `unlink` fires).
- **Grace window.** `RENAME_GRACE_MS = 800` in `main.js`. Buffered unlinks that aren't claimed within that window are emitted as real `unlink` events.
- **Atomic saves** (vim/VS Code write-temp-then-rename-over-existing) come through chokidar as `change` (not unlink+add), so they don't trip the correlator — see `tests/correlator.integration.test.js`.

## Settings persistence + secrets encryption

`settings.json` lives at `app.getPath('userData')/settings.json`. `DEFAULT_SETTINGS` + the `Settings` type live in `src/shared/settings.ts` (single source of truth). Top-level keys: `workspaces`, `activeWorkspaceId`, `appearance` (`themeMode`, `hideLineNumbers`), `dailyNote` (`format`, `folder`), `codingAgent` (`provider`, `model`, `apiKey`, `systemPrompt`, `skills.{global,workspaces}`), `agentSecrets[]`, `transcription` (`provider`, `apiKey`), `sync` (`pat`, `pullIntervalSeconds`), `chatSidebarOpen`, `chatSidebarWidth`, `treeSortOrder`, `windowBounds`.

Adding a persisted field means: extend the `Settings` type + `DEFAULT_SETTINGS` in `src/shared/settings.ts`, extend `readSettings`'s deep merge in `main.ts`, and add a slice + setter in the renderer's `useSettings` hook (which owns the canonical in-memory copy and is the only `persistSettings` caller).

`writeSettings` is serialized through `settingsWriteQueue` so concurrent writers (renderer-side `persistSettings` vs. main-side `persistWindowBounds`) can't race a partial overwrite. Writes go through tmp+rename for atomicity.

Anywhere settings hold a secret (`codingAgent.apiKey`, every `agentSecrets[].token`, `transcription.apiKey`, `sync.pat`) the on-disk value is wrapped with `enc:v1:<base64>` via Electron `safeStorage` (macOS Keychain / Windows DPAPI / libsecret on Linux). `encryptSecret` is idempotent — a value already wrapped passes through unchanged — so `writeSettings` can accept a merged object that mixes plaintext (from renderer) and ciphertext (preserved from disk) without double-encrypting. Decryption happens in `readSettings`; legacy plaintext values from before encryption was wired in pass through and are auto-upgraded on the next write. On Linux without a keyring, safeStorage falls back to hardcoded-password mode and we warn once.

## `app://media/...` protocol

Registered before `app.ready` via `registerSchemesAsPrivileged({scheme: 'app', privileges: {standard, secure, supportFetchAPI, stream}})` so the renderer can fetch it with `webSecurity` intact. Requests resolve `<rel>` against `watcherRootDir` (the active workspace), reject path traversal outside the workspace with 403, and stream the file via `net.fetch(file://…)`. `<img src="app://media/…">` in the live-preview decoration loads with no extra wiring.

## Window bounds persistence

`attachWindowBoundsPersistence` tracks the last-known unmaximized bounds and persists `{ x, y, width, height, maximized }` to `settings.windowBounds` on a 400ms debounce, with a final flush on `close`. The `will-quit` handler `event.preventDefault`s once, drains the `settingsWriteQueue`, then calls `app.exit()` so a fast Cmd+Q doesn't lose the last write. On restore, `boundsAreVisible` checks the saved rect against currently-attached displays and falls back to the default 1200×800 if it no longer intersects any display.

## Coding agent (main side)

Keeps **one** pi `AgentSession` at a time, keyed by `(workspacePath, provider, model, apiKey, effectiveSystemPrompt)`. The next `agent:send` whose key differs from the stored one tears down the previous session and creates a new one — there is no eager invalidation on settings change, only lazy reconciliation on the next send. `app.on('before-quit')` calls `agentReset()` to abort cleanly.

The agent runs with the **active workspace as `cwd`**, and uses an in-memory `AuthStorage` + `SessionManager` (sessions do not survive an app restart).

### System prompt

`agentSystemPrompt.js` exports `DEFAULT_AGENT_SYSTEM_PROMPT`, pre-filled into `codingAgent.systemPrompt` on first install and writable from Settings → Agent Chat. An empty/whitespace value falls back to the default at session boot. Pi's default coding-agent prompt is overridden via a custom `DefaultResourceLoader` with `systemPromptOverride`. The renderer fetches the current default via `agent:getDefaultSystemPrompt` for the "Reset to default" button.

### Skills (`skillLibrary.ts`)

On-disk library at `<userData>/pi-agent/skill-library/<skill-name>/SKILL.md` (one folder per skill). Pi never auto-discovers this directory. Each session boot we recompute the effective enabled list (`computeEffectivePaths`: workspace override wins over global; `inherit` falls back to global) and write it as `skills: []` to `<userData>/pi-agent/settings.json` via `writePiSettings`. Pi reads `skills` only at session boot — the user can hit Clear in the chat to apply a changed set.

### Agent-tokens extension (`agentTokensExtension.ts`)

Exposes `list_agent_secrets` + `get_agent_secret` tools so the agent can look up user-managed API tokens. The on-disk extension file is plain JS with no imports — it talks back to main through a process-global bridge (`global.__SHOCKWAVE_AGENT_TOKENS`) installed by `installAgentTokensBridge` at startup. The bridge re-reads settings on every call so user-side edits to secrets are picked up mid-conversation.

The extension source string is materialized fresh on every session boot via `ensureAgentTokensExtension`, so editing the source in this repo and restarting the app picks up the change without any user-side install step. The reason for the bridge pattern: the extension file lives under `<userData>/pi-agent/extensions/` (outside this project), and node's resolver can't find `electron` from there; writing decrypted secrets to disk would defeat the `safeStorage` encryption; pi runs in the same V8 isolate as main so a `global` function is the cleanest bridge.

### Failed-image guard

Pi pushes a user message into `state.messages` before the API call and a failure assistant message after, so a provider error (e.g. image too large) leaves both stuck in context to re-poison every subsequent turn. `codingAgent.ts`'s `agentSend` wraps the emit callback to detect the failure on `agent_end`, splices the bad pair out of pi's in-memory state, and emits a synthetic `agent_send_failed` event so the renderer can drop the matching transcript entry from its UI.

### Provider/model discovery

`agent:listProviders` and `agent:listModels` return pi-ai's provider/model lists filtered against `SUPPORTED_PROVIDER_SLUGS` (the bearer-key providers we support; cloud/OAuth providers like bedrock/vertex/azure/copilot are filtered out because our settings schema only carries a single API key). The list lives in `src/shared/constants.ts`.

## GitHub sync

Per-workspace background sync to GitHub. Two files: `sync.ts` (one-shot helpers + setup) and `syncEngine.ts` (the singleton tick loop).

### Auth model

PAT is stored encrypted in `settings.sync.pat` (`enc:v1:` via `safeStorage`). For shell git, the decrypted PAT is set on the child process's `GITHUB_PAT` env, and `GIT_ASKPASS` points at `<userData>/sync/askpass.sh` — a tiny posix helper that echoes `x-access-token` for `Username` prompts and `$GITHUB_PAT` for everything else. The PAT lives in process memory only for the lifetime of that one git child. **Never written to `.git/config`**; remote URLs stay plain `https://github.com/owner/repo.git`. REST calls use a `Bearer` header with the same memory-only lifetime.

### Tick (sequential, never overlapping)

0. **`git diff --name-only --diff-filter=U -z` → if any unmerged files exist, emit `paused` + the conflict list and RETURN — before step 2.** `git add -A` on a conflicted tree stages the marker-laden files and git treats them resolved, so push would ship `<<<<<<<` garbage. This bail is the entire defense; it must run first. (`-z` / NUL-split is required — the default output escapes spaces/unicode paths.)
1. `sync:flushRequest(token)` → renderer flushes dirty editor tabs → `sync:flushDone(token)`. **1 s timeout** so a hung renderer can't stall the engine.
2. `git status --porcelain`; if dirty → `git add -A` + commit (message `Shockwave sync: <ISO>`). A `git commit` here with `MERGE_HEAD` present also **concludes a resolved-but-open merge** — that's how the engine stays *stateless* about the pause (once conflicts are gone, the normal commit finishes the merge).
3. `git fetch origin <branch>`, then `git rev-list --count HEAD..origin/<branch>` to see if the remote is ahead. Fetch failing with "couldn't find remote ref" = no remote branch yet (fresh init) → skip to push.
4. If the remote is ahead → **`git merge origin/<branch>`** (NOT rebase — merge touches only genuinely-differing files and resolves in one pass; rebase replayed every auto-commit and churned the tree). On conflict the merge leaves unmerged files + `MERGE_HEAD`; emit `paused` + the list and return.
5. If local is ahead → `git push --set-upstream origin <branch>`.

### Conflict resolution (driven by the renderer's conflict view)

While paused, the renderer surfaces the conflict list and lets the user resolve. All of these stage the index (serialized with the tick via the `ticking` guard), re-list conflicts, and — when the list hits empty — kick a tick immediately so the merge commit + push happen at once:

- `resolveConflict(ws, rel)` — accept the file as hand-edited: `git add <rel>`.
- `keepConflict(ws, rel)` — keep ours: `git checkout --ours -- <rel>` + add.
- `resetConflict(ws, rel)` — take remote: `git checkout --theirs -- <rel>` + add.
- `keepAll(ws)` — whole tree, keep ours: `git checkout --ours .` + `git add -A` (then the merge completes; remote's non-conflicting changes still come in).
- `resetToRemote(ws)` — whole tree, take remote: `git merge --abort` + fetch + `git reset --hard origin/<branch>` (discards ALL local divergence — the renderer confirms first).

### Status state machine

`sync:status` push event carries `{ status, detail, lastSyncAt, repoUrl, conflicts }`. `conflicts` is the workspace-relative path list, present only on `paused`-for-conflicts (every other emit resets it to `[]` — see `emitStatus`):

- `disabled` — workspace has no origin, or no PAT configured. Icon hides.
- `idle` — last tick succeeded, waiting for next.
- `syncing` — a tick is in progress; `detail` describes the current step.
- `paused` — **merge conflicts** (carries `conflicts[]`) OR auth failure. **No retry loop.** For conflicts the user resolves in the renderer's conflict view (per-file or whole-tree, above); the engine is stateless — once unmerged files are gone, the next tick completes the merge and resumes. For auth, fix the PAT.
- `error` — transient (network, generic git failure). Next tick retries automatically.

### Lifecycle

- `start({ workspacePath, pat, intervalSeconds, windowId })` — stops any previous instance, self-checks origin + PAT, kicks the interval. **First tick fires immediately** so a workspace switch doesn't wait up to `intervalSeconds` before picking up remote changes.
- `stop()` — clears the interval and awaits the in-flight tick (so a partial commit/push never leaks).
- `drainBeforeQuit()` — called from `before-quit`. Same as `stop()` minus the disabled-status emit. Without this, a fast Cmd+Q could kill a child mid-push.

### Flush bridge

`requestFlush()` posts a token to the renderer and resolves either when the renderer acks via `sync:flushDone(token)` or when the 1 s timeout fires. Pending flushes are tracked in a `Map` keyed by token. The renderer subscribes once on mount (not per workspace) and reads `writeNow` via a ref — same discipline as the `fs:changed` listener.

The flush runs at the head of every tick, so on a fast-typing user the engine's `git add` + `git commit` will see and stage the just-flushed buffer — but `writeNow` records the file's real `stat.mtimeMs` in the link index as the canonical "last self-write." When chokidar fires its echo for the same write ~350ms later, the watcher's `evt.mtime` equals the stored value and the self-echo guard skips it. Without that exact-mtime match the watcher would treat the renderer's own save as an external change and reload the editor mid-typing. See "Real mtimes everywhere" in the root `CLAUDE.md` — this is the chain that broke in v1.0.1 when a wrapper dropped the mtime arg.

### Platform support

`ensureAskpass` writes the right credential helper for the host: a posix `.sh` on macOS/Linux, a `.cmd` batch file on Windows (both answer `x-access-token` for the `Username` prompt and `$GITHUB_PAT`/`%GITHUB_PAT%` for the password). `gitSpawn` is otherwise platform-agnostic, so sync runs on all three platforms wherever `git` is on PATH.

## Voice transcription IPC

`voice:getToken` mints a short-lived (60s) AssemblyAI streaming token. The long-lived API key (`settings.transcription.apiKey`) never leaves main — the renderer requests a fresh streaming token on each WebSocket connection. The actual WebSocket + audio pipeline lives in the renderer; see `src/renderer/CLAUDE.md`.

## IPC surface

| Group | Handlers |
|---|---|
| Dialogs | `dialog:openFolder` |
| FS | `fs:readTree`, `fs:readAllMarkdown`, `fs:readFile`, `fs:writeFile`, `fs:createFile`, `fs:renameFile`, `fs:duplicateFile`, `fs:trashFolder`, `fs:trashFile`, `fs:createFolder`, `fs:ensureDir`, `fs:moveItem`, `fs:renameFolder`, `fs:writeImage`, `fs:pathExists`, `fs:watchStart`, `fs:watchStop` |
| Shell | `shell:revealInFolder`, `shell:openExternal` |
| Context menus | `context:fileMenu` (`conflictMode` → Conflict resolved / Keep our file / Reset to remote), `context:conflictCloudMenu` (whole-tree keep/reset), `context:folderMenu`, `context:editorMenu` |
| Settings | `settings:read`, `settings:write` |
| Bookmarks | `bookmarks:read`, `bookmarks:write` |
| Theme | `theme:getInitial`; plus `theme:systemChanged` push event |
| Voice | `voice:getToken` |
| Agent | `agent:send`, `agent:abort`, `agent:reset`, `agent:getDefaultSystemPrompt`, `agent:listProviders`, `agent:listModels`; plus push events: `agent:event` (per pi event), `agent:error` |
| Skills | `skills:list`, `skills:libraryDir`, `skills:importPicker`, `skills:importFromPath`, `skills:remove` |
| Sync | `sync:verifyPat`, `sync:checkGit`, `sync:workspaceStatus`, `sync:setupClone`, `sync:setupInitAndCreate`, `sync:setupExistingLocal`, `sync:teardown`, `sync:setWorkspaceDisabled`, `sync:engineStart`, `sync:engineStop`, `sync:engineStatus`, `sync:flushDone`, `sync:listConflicts`, `sync:resolveConflict`, `sync:keepConflict`, `sync:resetConflict`, `sync:keepAll`, `sync:resetToRemote`; plus push events `sync:status` (carries `conflicts[]` when paused), `sync:flushRequest` |

The renderer reaches every one of these via `window.api.*` — see `src/preload/preload.cjs`. The renderer never touches Node directly.
