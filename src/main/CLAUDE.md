# CLAUDE.md — main process

Main-process internals. Code under `src/main/`. Cross-cutting invariants (terminology, link-index rules, parser parity, save-before-mutate) live in the **root `CLAUDE.md`** — read that first.

## Files

- `main.ts` — entry point. Window lifecycle, every IPC handler, watcher orchestration, `app://` protocol.

**Chat provenance.** `chat_session` carries three columns describing where a chat came from: `source` (`'desktop'` — interactive, the default — or `'cron'`; open-ended so a future channel like telegram needs no migration), `source_id` (identity *within* that source — the cron job name, or a chat/thread id; null for desktop, where a person at this app has no external id), and `machine` (`os.hostname()` at creation — chats travel with the workspace, but a cron run is machine-local, so the transcript alone can't say which box executed it). All three are set by `upsertSession`. Note `source` is nullable in SQL despite always being written: adding `NOT NULL` would require rebuilding `chat_session`, and `message` cascades from it — see the comment in `drizzle/0006_chat_source.sql`.
- `settingsStore.ts` — settings + secrets in the `setting` DB table: `readSettings`/`writeSettings`, `patchAgentSecretOAuth`, `DEFAULT_SETTINGS`, and the one-time `settings.json` import. See "Settings persistence + secrets encryption" below.
- `settingsKeys.js` — PURE key policy + shape mapping for the above (plain `.js`, unit-tested under `node --test`): `SETTINGS_SECRET_PATTERNS` / `AGENT_SECRET_FIELDS` (what goes to `secret_value`), `OAUTH_OWNED_FIELDS` / `OAUTH_OWNED_COLUMNS`, `LEAF_KEYS`, the flatten helpers, and `splitAgentSecret`/`joinAgentSecret` (the AgentSecret ⇄ two-table mapping).
- `masterKey.ts` — the `safeStorage`-wrapped master key at `<userData>/masterkey.enc`, plus `seal`/`unseal` (AES-256-GCM) for secret setting values.
- `pathResolver.ts` — `isMdFile`, `uniquePath` (same-dir uniqueness), `uniqueInWorkspace` (workspace-wide basename uniqueness for `.md` files), `walkMarkdownPaths`, `collectMarkdownBasenamesLower`. The link index is keyed by basename, so two `.md` files sharing one breaks it; `uniqueInWorkspace` is what `fs:renameFile`, `fs:moveItem`, and `fs:createFile` call to auto-disambiguate. Folder renames stay same-folder-unique because folders aren't part of the link index.
- `workspaceBackfill.js` — two one-shot migration helpers (plain `.js`): `backfillWorkspaceOrigins` runs BEFORE migrations and resolves each pre-0007 workspace's real git remote into the `origin_url` column 0007 parses — SQL can't shell out, and running it after migrations would force the repo columns nullable until a later release. `claimLocalRowsForThisMachine` stamps `os.hostname()` onto the `workspace_local` rows 0007 writes with an empty machine. Both no-op once past 0007.
- `workspaceRow.js` — PURE `workspace` row → `WorkspaceEntry` projection (plain `.js`, unit-tested). The single place `sync_disabled` (0/absent = syncing) is negated into the renderer-facing `syncEnabled`; getting it backwards silently inverts every Sync switch with nothing failing, so all three polarity cases are pinned by tests.
- `workspaceFolder.js` — PURE folder classification for the add-workspace flow (plain `.js`, unit-tested under `node --test`): `classifyFolder` → `empty` | `clone` | `occupied`, plus `parseGithubUrl` / `cloneUrlFor` / `repoMismatch` / `sameRepo` (case-insensitive, as GitHub is). No electron import, same split as `cronScheduler.js` vs `cron.ts`. `sync.ts` re-exports these.
- `linkParser.js` — ESM mirror of the wiki-link parser in `src/renderer/linkIndex.js` (intentionally kept as `.js` so both processes load the exact same module bytes — see parser-parity rule in root).
- `renameCorrelator.js` — pairs unlink+add events into rename events. See below.
- `watcherDispatch.js` — maps a `@parcel/watcher` event batch to correlator/pending-state calls. Imported by BOTH `main.ts` (real sinks) and the correlator/e2e tests (tmp-dir sinks), so main and the tests exercise identical watcher logic — same parity discipline as `linkParser.js`. Handles the parcel-specific shapes: atomic-save-as-`create`-of-known-path, folder-rename via directory expansion, deletes-before-creates batch ordering.
- `codingAgent.ts` — pi `AgentSession` lifecycle: one live session per chat in a map, sessionId-stamped events, mid-turn steering, system-prompt override, failed-image splice.
- `cronScheduler.js` — PURE cron math (plain `.js`, unit-tested under `node --test`): `parseCronJobs` (validate cron.json), `planTick` (catch-up decision + longest-overdue pick), `nextAfter`/`prevOccurrence` (cron-parser, local tz), `describeSchedule`.
- `cron.ts` — the stateful scheduler controller: reconciles `cron_state`, ticks every 60s + on activate/file-change, fires runs via the injected `runAgentTurn`. See "Scheduled runs (cron)" below.
- `defaults/` — everything a human authors: the system prompt AND the on-disk default files. `tools.ts` (`TOOL_CATALOG` — rendered into the prompt AND passed to pi as the `tools` allowlist; one list so the two can't drift), `helper.ts` (`buildShockwaveHelper` — the app mechanics, sections as named consts), `soul.ts` (`DEFAULT_SOUL` + `AGENTS_STUB` + `readSoul`), `files.ts` (`DEFAULT_FILES` + `ensureWorkspaceFiles`), `index.ts` (`assembleSystemPrompt`). See "System prompt" and "Workspace default files" below.
- `agentTokensExtension.ts` — the `list_agent_secrets` + `get_agent_secret` tool definitions, passed to pi in-process via `customTools`. `installAgentTokensBridge` injects the secret getters at startup (module scope, not `global`). `get_agent_secret` returns a usable credential for both static tokens and OAuth connections (a fresh access token for the latter).
- `openFileExtension.ts` — the `open_file` tool definition, same shape; `installOpenFileBridge` injects the handler.
- `oauth.ts` — OAuth2 engine for `oauth`-kind agent secrets (arctic + a loopback callback server; BYO Desktop-app client). See "OAuth for agent secrets" below.
- `skillLibrary.ts` — on-disk skill library under `<userData>/pi-agent/skill-library/<skill-name>/SKILL.md` and the workspace-override resolution.
- `sync.ts` — GitHub sync support: REST helpers (`verifyPat`, `createRepo`, `listRepos`), the `gitSpawn` wrapper that injects a PAT via `GIT_ASKPASS`, the git-presence check, and the workspace setup flows. **`ensureCheckout`** makes a folder BE a checkout of `owner/repo` whatever state it starts in — clone if empty, verify-and-leave-alone if it's already that repo, refuse otherwise — so adding a workspace and checking one out on this machine are one operation, not two implementations of it. `createWorkspaceRepo` stays separate because creating a repo also scaffolds it. Folder classification itself lives in `workspaceFolder.js`; it is the one place that reads `.git/config`, ONCE at setup, to learn what a folder already is (not the per-tick re-derivation the row replaced). The old `setupLink` (git-init an arbitrary folder and force a remote onto it) is gone — adopting now requires the remote to already be there.
- `syncEngine.ts` — singleton per-workspace tick engine. Sequential ticks (pause-if-conflicts → flush → commit → fetch → **merge** if behind → push), status state machine (with a `conflicts[]` payload on pause), per-file + whole-tree conflict resolution (`resolveConflict`/`keepConflict`/`resetConflict`/`keepAll`/`resetToRemote`), flush-renderer-dirty bridge, drain-on-quit hook. **Every git op — the tick and each resolution op — runs through one serial chain (`exclusive`)**; the interval SKIPS when the chain is busy, user-driven ops QUEUE. Conflict ops also refuse any path the engine isn't currently bound to.

## File watcher

`@parcel/watcher` (native, N-API — ABI-stable across Electron bumps). One `subscribe()` per active workspace (lifecycle: started in `loadWorkspace`, stopped in `loadWorkspace`/`removeWorkspace`/`before-quit`), plus a second `subscribe()` on `.shockwave/` for `workspace.json`. parcel is always recursive and reports only changes after subscribe (no initial scan) — seeding is our only startup enumeration. Per-path events are coalesced within a 150ms window; `.md` adds/changes are read + parsed in main (reusing `linkParser.js`).

parcel-specific handling (all in `watcherDispatch.js`): events are `{type: 'create'|'update'|'delete', path}` with **no mtime and no file/dir discriminator**, so the dispatch stats each path (for the inode + to reject directories); a `create` of an already-known path is an atomic save (temp-write + rename-over) and is treated as a modification; a folder rename arrives as delete(oldDir)+create(newDir) and is expanded into per-file events (paired by inode → per-file renames); deletes in a batch are dispatched before creates so rename pairing always has the unlink buffered first. The `ignore` globs are a perf hint; the authoritative dotfile filter is `isIgnoredWatchPath` in the callback.

Events shipped to the renderer (via `fs:changed`):

- `{type:'add'|'change', path, mtime, outgoingLinks}` — `.md` file appeared or modified
- `{type:'add'|'change', path, mtime}` (no `outgoingLinks`) — a `.excalidraw` drawing or a non-`.md` **reloadable text/code file** (`isReloadableText` — everything in `OPENABLE_RE` except the `.md` family, images, video, drawings) changed. Bypasses the rename correlator (link-index machinery); the renderer re-reads the file to reload an open canvas/buffer, keyed by its own mtime store (`drawingMtimesRef` / `textMtimesRef`) for the self-echo guard.
- `{type:'unlink', path}` — `.md`/drawing/reloadable-text file removed (grace window already elapsed without a paired add)
- `{type:'rename', oldPath, newPath, mtime, outgoingLinks}` — paired by the correlator (inode primary, hash fallback); `.md` only (drawings/text surface as unlink+add)
- `{type:'tree'}` — folder change or a non-reloadable change (binaries, etc.) — tree refresh only

The watcher only sees inside the active workspace, and `isIgnoredWatchPath` skips any path with a dotfile segment (`.git`, `.obsidian`, `.shockwave`, etc.) — mirrors `buildTree`. The `.shockwave/` segment is how we store our own per-workspace data (bookmarks) without echoing back through the main watcher (a separate subscription watches it for `workspace.json`).

### End-to-end pipeline

The watcher is a state machine spread across `main.ts` (orchestration), `watcherDispatch.js` (event mapping), and `renameCorrelator.js` (rename pairing). The flow from a parcel event batch to the renderer:

```
@parcel/watcher subscribe(root) (fsevents on macOS)
   │
   ├── batch of {type: create|update|delete, path}
   ▼
onParcelEvents → watchDispatch.handleBatch(events)   (deletes first, then creates/updates)
   │
   ├─ drawing / reloadable-text path? → pend as add/change (mtime-only event; bypasses correlator)
   ├─ other non-.md path? → markTreeOnly() → pendingTreeOnly = true; scheduleFlush() (150ms debounce)
   ├─ directory? → create: walk .md inside and upsert each; delete: unlink every known .md under it
   └─ .md file? → stat ino + hash file, hand to correlator:
                    create (unknown path) → correlator.onPathAppeared(p, ino, hash)
                    create (known path) / update → onPathSeen(p, ino, hash); pendingByPath.set(p, 'change')
                    delete → correlator.onPathGone(p)  (buffered for 800ms grace)
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
6. **Seeding runs synchronously on `watchStart`.** Every `.md` under the root is stat'd + sha1'd before `subscribe()` is awaited. Without this, an unlink fired immediately after startup couldn't be correlated (we'd have no prior identity to match against). It also feeds `correlator.isKnown` / `knownUnder`, which the dispatch relies on to classify atomic saves and expand folder deletes.

### Rename correlator (`renameCorrelator.js`)

External actors — Finder, `mv`, `git checkout`, a coding agent shelling out to `fs.rename` — bypass the in-app rename flow. Without intervention, the watcher would see a rename as unrelated `unlink(old) + add(new)` events, references in other files would break, and the link index would lose the connection between the old and new paths.

The correlator buffers unlinks and pairs them with subsequent adds:

- **Primary key: inode.** `fs.stat(p, { bigint: true }).ino` is stable across `fs.rename` on every realistic filesystem (NTFS, APFS, ext4, btrfs, xfs). The correlator stores `{path → {ino, hash}}` for every known file; on `unlink`, it buffers the identity; on `add`, it stats the new file's ino and matches against buffered unlinks.
- **Fallback: content hash.** For filesystems where ino is unreliable (FAT, exFAT, some SMB shares), the correlator falls back to matching the SHA-1 of the file contents (computed eagerly on `onPathSeen` because the file is gone by the time `unlink` fires).
- **Grace window.** `RENAME_GRACE_MS = 800` in `main.js`. Buffered unlinks that aren't claimed within that window are emitted as real `unlink` events.
- **Atomic saves** (vim/VS Code write-temp-then-rename-over-existing) come through parcel as `create` of the existing destination (+ a delete of the temp). The dispatch sees the destination is already known (`correlator.isKnown`) and treats it as a modification, not a rename — see `tests/correlator.integration.test.js`.

## Settings persistence + secrets encryption

Settings live in `<userData>/shockwave.db` across **five tables**, split by what the data *is*. `settingsStore.ts` owns `readSettings`/`writeSettings` and `DEFAULT_SETTINGS`; the `Settings` type stays in `src/shared/settings.ts`.

| Table | Holds | Why not key-value |
|---|---|---|
| `setting` | scalar preferences, one row per dotted leaf key | — this is what KV is good at |
| `workspace` | workspace entities — which GitHub repo each one is | an entity needs atomicity; N key rows can leave a half-record |
| `workspace_local` | per `(workspace, machine)`: checkout path, active flag, sync on/off | machine-scoped facts; keyed by machine so the DB stays copyable |
| `agent_secret` | agent-secret entities (no crypto columns) | same |
| `secret_value` | **every** encrypted value, crypto columns `NOT NULL` | makes a plaintext credential unrepresentable |

Reads LEFT-join the two workspace tables, scoped to `machine = hostname()`, so a workspace with no local row here surfaces with `path: null` — "exists, not checked out on this machine" — rather than disappearing. That's the normal state for a DB copied to a second machine, and what a vanished folder degrades to: `workspace:forgetLocal` drops only the local row, because the repo is still valid and re-clonable. `workspace:setUpHere` is the inverse.

`readSettings()` / `writeSettings(patch)` keep the signatures they had as file operations and still return/accept one flat `Settings` object, so every call site in `main.ts`, `oauth.ts`, `cron.ts` — and the whole renderer — is unchanged. The five-way split is invisible above this file.

### The store is the source of truth

Two rules make that true rather than aspirational:

1. **`writeSettings` writes only the keys in the patch.** The renderer's `persistSettings` sends just what changed (it used to merge into an in-memory canonical object and write all 14 subtrees — correct for a JSON file, but with per-key rows it put every unrelated setting, credentials included, in the blast radius of a stale copy). A key absent from a patch keeps whatever the store holds.
2. **`settings:changed` pushes main's own writes to the renderer.** Main writes settings in places the renderer can't observe — OAuth token refresh, window bounds, cron toggles, `ensureBuiltinSecretSlots` — and its copy would silently drift. `emitChanged(keys)` broadcasts `{ keys, settings }` (changed top-level keys + a fresh full read) and the renderer applies **only those keys**, so an unrelated main write can't stomp a field the user is editing.

The event fires for main-initiated writes only: the `settings:write` IPC passes `notify: false`, because the renderer already has what it just wrote and an echo could overwrite a newer local edit still in flight. The legacy import passes `notify: false` too — it runs before any window exists.

The renderer keeps a copy (`settingsRef` in `useSettings`) purely to render from and to build whole sub-objects for per-field setters. It is a cache, not the truth.

### Why these shapes

The old `<userData>/settings.json` was read-modify-written in full on every save, so two writers touching unrelated settings raced over one blob and last-write-won. Per-key rows make those writes disjoint. Consequences worth knowing:

- **No deep-merge to maintain.** A key with no row falls back to `DEFAULT_SETTINGS`. The old hand-written per-key merge in `readSettings` is gone.
- **No write queue.** better-sqlite3 writes are synchronous and committed by the time `writeSettings` resolves, so `will-quit` no longer drains anything for settings — only the sync engine.
- **Nested objects flatten** (`appearance.treePanel.content`); `windowBounds` is in `LEAF_KEYS` and stored whole as one JSON row.
- **Collections get tables, not key rows.** `workspaces` and `agentSecrets` are intercepted in `writeSettings` *before* flattening and routed to their tables, so no stray settings row can reappear and shadow one. `sync.disabledWorkspaceIds` became `workspace.sync_disabled` — as an array it was a foreign key by another name, and ids outlived the workspaces they named. The settings array is gone entirely: the flag rides the workspace projection as `syncEnabled` (negated once, in `workspaceRow.js`) and is authored only by the `sync:setWorkspaceDisabled` IPC via `setWorkspaceSyncDisabled(id, disabled)` — one boolean on one row. As three copies — column, settings array, renderer state — it drifted: editing the PAT rebuilt the sync object without the array and flipped every switch on. `activeWorkspaceId` got the same treatment: it was a `setting` row (a foreign key hiding in a key-value store, global when it should be per-machine) and is now `workspace_local.active`, derived on read and routed to `setActiveWorkspace` on write. **`writeSettings` can no longer create or delete a workspace** — `updateWorkspaces` only renames and reorders, so a stale renderer list can't erase a workspace it hadn't heard about; creation is `workspace:createWithRepo`/`addFromRepo`, removal is `workspace:remove`.
- **Agent-secret order is derived**, `createdAt` then name, rather than stored — a shared ordering row would reintroduce the cross-writer collision the design removes. Workspaces do store `sort_order` (REAL), because their order is user-visible and arbitrary.

The pure half — key classification, the flatten mapping, and the entity split/join — lives in **`settingsKeys.js`** (plain `.js`, no electron import) so `node --test` exercises it directly; same split as `cronScheduler.js` vs `cron.ts`. See `tests/settingsKeys.test.js`.

Adding a persisted field means: extend the `Settings` type in `src/shared/settings.ts` + `DEFAULT_SETTINGS` in `settingsStore.ts`, add a slice + setter in the renderer's `useSettings` hook (the canonical in-memory copy and only `persistSettings` caller), and — **if it holds a credential** — add its key pattern to `SETTINGS_SECRET_PATTERNS` in `settingsKeys.js`.

### Secret encryption

Envelope encryption, one level deep:

```
safeStorage (OS keychain) ──wraps──> master key (32 bytes) ──AES-256-GCM──> each secret value
```

- **Master key** (`masterKey.ts`): 32 random bytes generated on first run, wrapped with `safeStorage` and written to `<userData>/masterkey.enc` (mode 0600, tmp+rename). It lives in a **file, not the DB**, because it is machine-bound while the DB is portable — a copied/backed-up DB shouldn't carry bytes that only one keychain can unwrap. Cached in main's memory; never crosses IPC. If the key file exists but can't be unwrapped (restored machine, changed login keychain) `getMasterKey` **throws rather than regenerating** — silently minting a new key would leave every existing secret row undecryptable while looking healthy.
- **Per value**: AES-256-GCM with a **fresh 12-byte IV per write**, one row in `secret_value` keyed by `(owner, field)`. `ciphertext`/`iv`/`tag`/`key_version` are all `NOT NULL` — that is the structural guarantee: a plaintext credential cannot be stored in that table. A row that fails to decrypt yields `''` and warns, so one bad row doesn't take down the whole settings read.
- **`owner`** is `'settings'` for standalone credentials (the field is then the settings key: `sync.pat`, `transcription.apiKey`, `codingAgent.providerKeys.<slug>`), or an `agent_secret.name` for that entry's `token` / `oauth.{clientSecret,accessToken,refreshToken}`.
- **Absent means unset.** An empty value deletes its row rather than encrypting `''`, so "is this configured" is a row-existence check. A built-in-skill slot with no key pasted yet has an `agent_secret` row and no `secret_value` row.
- **Where a value goes** is decided by `SETTINGS_SECRET_PATTERNS` + `AGENT_SECRET_FIELDS` in `settingsKeys.js`. Two earlier designs failed silently here and are worth remembering: hand-maintained encrypt/decrypt field lists in `main.ts` (miss one, it persists in the clear), then a `secret` flag column on `setting` (set it wrong, same result). Routing to a table whose crypto columns are `NOT NULL` is what removed that failure mode.
- Only `secret_value` is encrypted. Everything else — settings, workspaces, agent-secret metadata, chat messages, cron state — is plaintext.
- **Key rotation** is a single `SELECT`/`UPDATE` over one table; `key_version` marks which master key sealed each row so a rotation can proceed incrementally.
- On Linux without a keyring `safeStorage` falls back to a hardcoded password, so wrapping buys nothing; the key is stored marked `plain` and we warn once, rather than pretending. Same posture the old path had (it wrote plaintext secrets in that situation).

### Legacy import

`importLegacySettingsIfNeeded()` runs once in `whenReady`, before anything reads settings. It no-ops unless the `setting` and `agent_secret` tables are both empty **and** a `<userData>/settings.json` exists. It unwraps the old `enc:v1:<base64>` safeStorage values, drops retired keys (`ai`, `dailyNote`, `templates`, `codingAgent.systemPrompt`, `codingAgent.skills`, `appearance.dailyNotesInBookmarks`), writes everything through `writeSettings` (re-encrypting under the master key), then **renames** `settings.json` → `settings.json.migrated` — never deletes it. It can't be a standalone script: `safeStorage` only exists inside a running Electron process. It ships permanently, since every install from v1.0.12 and earlier upgrades from a `settings.json`.

### OAuth for agent secrets

An `agentSecrets[]` entry is either `kind: 'static'` (a pasted token, in `.token`) or `kind: 'oauth'` (an OAuth2 connection, in `.oauth` — see `AgentSecretOAuth` in `src/shared/settings.ts`). `oauth.ts` runs the whole flow in main:

- **BYO client, RFC 8252 loopback.** The user creates their own OAuth client in the provider console (Google → "Desktop app" client type) and pastes `clientId`/`clientSecret`. `startConnect` opens the **system browser** (`shell.openExternal`) to the consent URL and catches the redirect on a throwaway `http` server bound to `127.0.0.1:<ephemeral port>`. No embedded webview; the app never sees credentials. Ephemeral port ⇒ Google works (it accepts any loopback port); exact-match providers like GitHub do not (see each preset's `hint`).
- **arctic** (`arctic@^3.7.0`, ESM — externalized, resolved by the ESM main at runtime) is used **only for the pure authorize-URL + PKCE building** (`createAuthorizationURLWithPKCE`, `CodeChallengeMethod.S256`, `generateState`, `generateCodeVerifier`). The **token exchange + refresh are our own `fetch`** (`postToken`), NOT arctic's `validateAuthorizationCode`/`refreshAccessToken`: arctic 3.7.0 manually sets a `Content-Length` header on its token request, which Electron's undici rejects with `UND_ERR_INVALID_ARG` "invalid content-length header" — the request never leaves the app. Our `postToken` sends a `URLSearchParams` string body with only `Content-Type`/`Accept` (undici computes Content-Length) and puts `client_id`+`client_secret` in the body. `PROVIDER_PRESETS` bakes in endpoints/scopes/quirks (Google's `access_type=offline` + `prompt=consent` guarantees a refresh token).
- **State/verifier live in-memory** for the flow's lifetime (a webapp would use httpOnly cookies; we have neither). `state` is checked on the callback (CSRF). 5-min timeout.
- **`getFreshToken(name)`** is what the agent-tokens bridge calls for an oauth secret: returns the stored access token, or refreshes (arctic `refreshAccessToken`) if within `EXPIRY_SKEW_MS` of expiry, re-persists, and returns the new one. Concurrent callers for one name share a single in-flight refresh (Google rotates refresh tokens). No refresh token / refresh failure ⇒ status flips to `expired` and it throws a "reconnect in Settings" message.
- **Settings reads are injected** via `initOAuth({ readSettings })` (called once at startup, before any `oauth:*` IPC) to avoid a circular import back into `main.ts`. Writes don't need injecting — `patchSecret` calls `patchAgentSecretOAuth` in `settingsStore.ts` directly, touching **only** this connection's token rows in `secret_value` plus its OAuth status columns on `agent_secret`, in one transaction. It used to read-modify-write the entire `agentSecrets` array, which raced the renderer's own array write: the renderer's copy was built from pre-refresh state, so it could overwrite a token main had just rotated, and Google rotates refresh tokens on every refresh — a lost write killed the connection permanently. Two guards now: the writes are disjoint, and `OAUTH_OWNED_FIELDS` (`oauth.accessToken`, `oauth.refreshToken`) + `OAUTH_OWNED_COLUMNS` (`oauthExpiresAt`, `oauthStatus`, `oauthAccountEmail`) bar any bulk `writeSettings` from authoring them at all, so a stale echo can't win even in principle. `clientId`/`clientSecret` are deliberately NOT owned — the user enters those in Settings. `patchAgentSecretOAuth` also emits `settings:changed(['agentSecrets'])`, so the renderer picks up fresh status on its own; the explicit `reloadAgentSecrets` call after Connect/Disconnect is now a belt rather than the mechanism.
- IPC: `oauth:listPresets`, `oauth:startConnect`, `oauth:disconnect`.

## `app://media/...` protocol

Registered before `app.ready` via `registerSchemesAsPrivileged({scheme: 'app', privileges: {standard, secure, supportFetchAPI, stream}})` so the renderer can fetch it with `webSecurity` intact. Requests resolve `<rel>` against `watcherRootDir` (the active workspace), reject path traversal outside the workspace with 403, and stream the file via `net.fetch(file://…)`. `<img src="app://media/…">` in the live-preview decoration loads with no extra wiring.

## Window bounds persistence

`attachWindowBoundsPersistence` tracks the last-known unmaximized bounds and persists `{ x, y, width, height, maximized }` to `settings.windowBounds` on a 400ms debounce, with a final flush on `close`. The `will-quit` handler `event.preventDefault`s once, drains the **sync engine**, then calls `app.exit()`. It no longer drains a settings queue: the bounds write is a synchronous sqlite transaction that has already committed when `writeSettings` resolves, so a fast Cmd+Q can't lose it the way it could with the old async tmp+rename. On restore, `boundsAreVisible` checks the saved rect against currently-attached displays and falls back to the default 1200×800 if it no longer intersects any display.

## Coding agent (main side)

Keeps **one live pi `AgentSession` per chat** in a `Map<sessionId, Entry>` (`codingAgent.ts`) — chats run concurrently and switching chats never aborts a turn. Chat IDs are **renderer-minted UUIDs** (see `chatStore.ts`); main hands them to pi via `SessionManager.create(..., { id })`, so every event is routable from the first millisecond. Open-vs-new is derived from the DB: a stored row with a `jsonlPath` → `SessionManager.open` (resume); no row → create under the supplied id.

Lifecycle rules:

- **Send to an idle chat** → boot (or reuse) that chat's session, run the turn, persist messages to the DB on `agent_end`. A concurrent boot for the same id awaits the in-flight boot (`booting` map) — two managers on one JSONL would corrupt it.
- **Send to a chat mid-turn** → **steer**: `session.prompt(text, { streamingBehavior: 'steer' })`; pi queues it and delivers at the next step boundary of the running turn.
- **Config change** (model/key/thinking — the `makeKey` fields) on an idle chat → its session is rebuilt on the next send, continuing the same JSONL with its frozen prompt. Mid-turn config changes wait: a running entry is reused unconditionally.
- **Dispose** (`session.dispose()` + map delete) happens ONLY on chat delete (`chat:deleteSession` aborts first) and `before-quit` (`agentDisposeAll`). Idle sessions hold no timers/sockets — just their transcript on the heap — so there is no idle eviction.
- Every event forwarded to the renderer is stamped with its `sessionId` (both `agent:event` and `agent:error`). `agent:runningSessions` returns the ids with a turn in flight (renderer reseeds its running set after a window reload).

The agent runs with the **active workspace as `cwd`** and an in-memory `AuthStorage`. Live session objects don't survive an app restart, but chats do: pi's JSONL is the continuation source of truth, and every send re-opens it on demand.

### System prompt

The system prompt is **assembled**, not a setting. `assembleSystemPrompt(workspacePath)` (`defaults/index.ts`) joins two parts:

    <SOUL>            ← the workspace's SOUL.md (root of cwd), or DEFAULT_SOUL if absent
    <SHOCKWAVE_HELPER> ← buildShockwaveHelper({tools}) — app mechanics + the tool list from tools.ts

That combined string is passed to pi via `DefaultResourceLoader`'s `systemPromptOverride`, replacing pi's built-in coding-agent prompt. pi then appends, on its own, at session boot: discovered context files (**AGENTS.md** / **CLAUDE.md**, walked cwd→root — standard pi discovery, unfiltered), the enabled skills list, and `Current date: YYYY-MM-DD` (date only). So the final order is SOUL → helper → context files → skills → date.

The assembled string is part of the session key (`makeKey`), so it's baked once per conversation and only reboots when SOUL/workspace/model changes. **SOUL.md is a normal file** the user edits in-app; there is no settings UI for it. A repo created through the app gets a physical `SOUL.md` — see "Workspace default files" below; a workspace whose file is missing or empty falls back to `DEFAULT_SOUL` in-memory. The old `codingAgent.systemPrompt` setting and the `agent:getDefaultSystemPrompt` IPC were removed.

### Skills (`skillLibrary.ts`)

On-disk library at `<userData>/pi-agent/skill-library/<skill-name>/SKILL.md` (one folder per skill). Pi never auto-discovers this directory. Each session boot we recompute the effective enabled list (`computeEffectivePaths`: workspace override wins over global; `inherit` falls back to global) and write it as `skills: []` to `<userData>/pi-agent/settings.json` via `writePiSettings`. Pi reads `skills` only at session boot — the user can hit Clear in the chat to apply a changed set.

### Tools (`agentTokensExtension.ts`, `openFileExtension.ts`)

**`TOOL_CATALOG` in `defaults/tools.ts` is the whole tool set** — it is BOTH the prompt's "Available tools" section AND the `tools:` allowlist handed to `createAgentSession`. Adding or removing a tool is one edit there plus, for a custom tool, its definition object.

Our three custom tools (`list_agent_secrets`, `get_agent_secret`, `open_file`) are passed **in-process** via `customTools`. Their getters/handlers are injected at startup by `installAgentTokensBridge` / `installOpenFileBridge` into module-scoped variables, so the definitions never import back into `main.ts`; the getters re-read settings per call, so secret edits land mid-conversation.

pi's own built-ins are enabled by NAME in the same catalog. pi's default is only `read`/`bash`/`edit`/`write`; we also enable `grep`/`find`/`ls`, which `createAllToolDefinitions` instantiates regardless (the allowlist just selects). They return truncated, structured output and respect `.gitignore`, so the prompt steers searching to them rather than to `bash`.

**Why the allowlist is not optional.** These used to be materialized as plain-JS extension files under `<userData>/pi-agent/extensions/`, reaching main through `global.__SHOCKWAVE_*` globals — necessary then, because node's resolver can't find `electron` from that directory. pi's `discoverAndLoadExtensions` **scans that directory unconditionally** (plus `<cwd>/.pi/extensions/`) and loads whatever it finds, ADDING to any configured list; the `extensions: []` we write to pi's settings.json cannot restrict it. So a retired extension's file outlived the source that wrote it: a deleted `resolve_link` kept registering itself for months against a bridge that no longer existed, and the prompt advertised 7 tools while pi ran 8. The allowlist is what bounds the set now — a stray extension can still load, but its tool is filtered out unless `TOOL_CATALOG` names it.

Known pi quirk: the `grep` tool spawns ripgrep with a hardcoded `--hidden` and no way to disable it, so it descends into `.git/`. The workspace's default `.ignore` file (see below) is what excludes it.

### Failed-image guard

Pi pushes a user message into `state.messages` before the API call and a failure assistant message after, so a provider error (e.g. image too large) leaves both stuck in context to re-poison every subsequent turn. `codingAgent.ts`'s `agentSend` wraps the emit callback to detect the failure on `agent_end`, splices the bad pair out of pi's in-memory state, and emits a synthetic `agent_send_failed` event so the renderer can drop the matching transcript entry from its UI.

### Provider/model discovery

`agent:listProviders` returns pi-ai's provider list filtered against `SUPPORTED_PROVIDER_SLUGS` (the bearer-key providers we support; cloud/OAuth providers like bedrock/vertex/azure/copilot are filtered out because our settings schema only carries a single API key). The list lives in `src/shared/constants.ts`.

`agent:listModels` returns the **models.dev** catalog for the provider, not pi's bundled list — models.dev is fresher and richer. `modelCatalog.ts` owns this: fetch `models.dev/api.json`, cache in memory (10-min TTL) + to `<userData>/model-catalog.json`, with a fallback chain `live → mem → disk → pi getModels()` (per-provider). Nothing to hand-maintain — the disk copy self-writes and pi's list is the bundled offline seed. The one static bit is `DEV_KEY` (our slug → models.dev key: `fireworks→fireworks-ai`, `together→togetherai`, `vercel-ai-gateway→vercel`, `kimi-coding→kimi-for-coding`; identity otherwise). `initModelCatalog(userDataDir)` is called once in `whenReady`.

Because pi *executes* via a `Model` object (not a string), `codingAgent.ts`'s **`resolveModel(provider, model)`** reconciles catalog and runtime at boot: `getModel` (pi's bundled, vetted descriptor) when pi has the model, else **synthesize** one from the models.dev record — the provider's API wiring (`api`/`baseUrl`/`compat`) is a per-provider constant, so it's cloned from any sibling model pi already knows, and the models.dev metadata (name/context/cost/input) is overlaid. `bootSession` uses it and throws if it returns null.

**Reasoning levels** (`listThinkingLevels`, async) come from models.dev's `reasoning_options`, not pi: `['off', …reasoningLevels]` translated to pi's vocabulary via `toPiThinkingLevel` (models.dev's top level is **`max`**, pi's is **`xhigh`** — the same tier) and de-duplicated (models.dev lists both). The same translation runs in `bootSession` before the level is handed to pi, so the level shown in the dropdown is exactly the one that executes — pick `max`/`xhigh` and pi runs its true top tier instead of clamping an unknown `max` down to `off`. The renderer's `THINKING_LABELS` (`AgentChatSection.tsx`) labels pi's vocabulary only.

## Workspace default files

Every workspace gets a small set of authored files at its root. They are **files, not settings**, so the user can read, edit, diff, and sync them like anything else — same reasoning that keeps `SOUL.md` out of the settings UI. The manifest and the write logic are in `defaults/files.ts`.

| File | Purpose |
|---|---|
| `SOUL.md` | The agent's identity for this workspace (else `DEFAULT_SOUL` in memory) |
| `AGENTS.md` | The user's own instructions; pi discovers and appends it |
| `.ignore` | Paths the agent's search tools skip. Contains `.git/` — pi's `grep` runs ripgrep with `--hidden`, which would otherwise return binary blobs from `.git/objects`. ripgrep honors `.ignore` independently of `.gitignore`, so this is the only lever from outside pi |
| `.gitignore` | OS droppings only (`.DS_Store`, `._*`, `Thumbs.db`). Deliberately minimal — syncing everything is the point. Notably NOT `.shockwave/`, which carries `workspace.json` and workspace skills and SHOULD travel between machines |

`ensureWorkspaceFiles(path, { overwrite })` writes them. **Never clobbers by default** (`wx` — fail-if-exists), so adding an entry to `DEFAULT_FILES` is safe to ship: existing workspaces pick it up on request and nobody loses an edit.

- **Automatic:** `createWorkspaceRepo` ONLY — a repo the user just created here, which is empty and theirs.
- **Manual:** `workspace:listFiles` reports what's missing; `workspace:ensureFiles` writes it. With `overwrite: true` it replaces all of them — the renderer confirms first, because git only makes that recoverable for what's already COMMITTED, and an edit made since the last sync tick has no copy to come back from.

**Clone / adopt / set-up-here (`ensureCheckout`) deliberately does NOT scaffold.** Cloning is adopting someone else's repo, and the sync engine commits and pushes on its next tick — automatic scaffolding there would push four files into a repo the user may neither own nor be alone in. `.gitignore` is the sharpest case, since adding one changes git's behavior for every collaborator. A cloned workspace with no `SOUL.md` falls back to `DEFAULT_SOUL` in memory and works fine; the manual action is how the user opts in.

It deliberately does **not** run on workspace activation: writing to the user's folder every time they switch workspaces is silent, repeated, and surprising.

## Scheduled runs (cron)

In-app scheduler that runs the coding agent on a schedule, per **active workspace**, exactly like an interactive chat.

- **Source of truth is `cron.json`** at the workspace root (agent- and hand-editable): `[{ name, schedule (5-field, LOCAL time), prompt, enabled }]`. Machine-local timing (`nextRunAt`/`lastRunAt`/`lastError`/`lastSessionId`) lives in the `cron_state` DB table — it must NOT sync between machines.
- **Next-run / catch-up:** a missed run fires only if its *most-recent* occurrence is within `cron.maxCatchupHours` (default 36); older misses collapse into one. `planTick` measures staleness from `prevOccurrence(now)`, NOT the stored `nextRunAt` (measuring from the oldest miss would drop recent wanted runs).
- **Lifecycle rides the watcher.** `cronActivate(dir)` is called from the `fs:watchStart` handler; `cronDeactivate()` from `stopWatcher`. So cron follows the active workspace. The watcher's main-side dispatch also pings `cronOnFileChanged()` when `<ws>/cron.json` changes (promptness only — the 60s tick catches it regardless; reconcile is idempotent so our own toggle-write self-echo is harmless).
- **Firing:** `runJob` mints a fresh uuid and calls the injected `runAgentTurn` (main's `runAgentTurnForCron`, which builds agentSend opts exactly like the `agent:send` handler but with an EXPLICIT workspace + `unattended: true`, `source: 'cron'`, `cronTitle: job.name`). The `unattended` flag threads through untyped `opts` → `bootSession` (create branch) → `assembleSystemPrompt(ws, { unattended })` → the `UNATTENDED` helper section that overrides "ask first". Fresh uuid ⇒ always the create branch ⇒ always unattended.
- **Concurrency:** one run at a time per workspace; cron defers to ANY agent running in the workspace (`agentRunningSessions()` → the user's own chat always wins). The scheduler is the SOLE writer of `nextRunAt` (advanced at attempt); `runJob` records only `lastRunAt`/`lastError`/`lastSessionId`, so manual "Run now" never disturbs the schedule. A run over `cron.maxRunMinutes` (default 30) is aborted so a hung provider can't wedge the scheduler.
- **One-way: `cron.json` → UI.** The file is the source of truth for job definitions AND the per-job `enabled` flag; the UI DISPLAYS them and never writes them back. Editing jobs / enabling / disabling is done in the file (by the user or the agent). The only UI-driven writes are machine-local *settings* (master toggle + windows → `settings.cron`) and out-of-band actions (Run now → a run, no file write). `cronRead` computes each valid job's next occurrence live so "next" is meaningful even when the master is off.
- **Master toggle** (`settings.cron.enabled`, global machine-local, opt-in) gates FIRING only — watching/validation/UI stay live when off. cron.ts is injected via `initCron({ readSettings, writeSettings, runAgentTurn, getWindow })` (no import of main). IPC: `cron:read` / `cron:setEnabled` / `cron:runNow` / `cron:setMaxCatchupHours` / `cron:setMaxRunMinutes`; push events `cron:state` + `cron:chatsChanged`.

## GitHub sync

Per-workspace background sync to GitHub. Two files: `sync.ts` (one-shot helpers + setup) and `syncEngine.ts` (the singleton tick loop).

### Auth model

PAT is stored encrypted in the `sync.pat` setting row (AES-256-GCM under the master key — see "Secret encryption" above). For shell git, the decrypted PAT is set on the child process's `GITHUB_PAT` env, and `GIT_ASKPASS` points at `<userData>/sync/askpass.sh` — a tiny posix helper that echoes `x-access-token` for `Username` prompts and `$GITHUB_PAT` for everything else. The PAT lives in process memory only for the lifetime of that one git child. **Never written to `.git/config`**; remote URLs stay plain `https://github.com/owner/repo.git`. REST calls use a `Bearer` header with the same memory-only lifetime.

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

- `unconfigured` — sync not set up (no origin / no PAT), or a benign engine stop (workspace switch / window reload). **Renderer hides the icon.**
- `idle` — synced. `lastSyncAt === null` = "not synced yet" (gray cloud); set = synced (cloud-check).
- `syncing` — a tick is in progress; `detail` describes the current step.
- `paused` — **merge conflicts** (carries `conflicts[]`). The engine is stateless — once unmerged files are gone, the next tick completes the merge and resumes (see the per-file / whole-tree resolution above).
- `offline` — **a transient/network error. Sync is NOT off — it backs off (10s → 30s → 1m) and keeps retrying forever.** `state.retryAt` gates ticks during backoff; a confirmed fetch clears it.
- `disabled` — **stopped**: the user turned it off (`userDisable`), or a *terminal* error stopped it (`disableOnError` — clears the interval). The renderer shows the **stop** icon; clicking it → reason + **Enable** (→ `setWorkspaceDisabled(false)` → `engineStart`).

**Network NEVER disables sync.** Only `isTerminalGitError` (an allowlist: big file `GH001`, secret `GH013`, protected branch, auth/perms, repo-not-found) routes a failure to `disabled`. Anything unrecognized → `offline` + retry. Bias is intentional: when unsure, keep trying, don't turn off.

### Lifecycle

- `start({ workspacePath, pat, intervalSeconds, windowId })` — stops any previous instance, looks the workspace row up by path and takes repo + branch FROM THE ROW (no `git remote get-url`, no per-tick `rev-parse`), then kicks the interval. **First tick fires immediately** so a workspace switch doesn't wait up to `intervalSeconds` before picking up remote changes.
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
| Settings | `settings:read`, `settings:write` (writes only the keys present); plus push event `settings:changed` (`{keys, settings}`, main-initiated writes only) |
| OAuth | `oauth:listPresets`, `oauth:startConnect`, `oauth:disconnect` |
| Bookmarks | `bookmarks:read`, `bookmarks:write` |
| Theme | `theme:getInitial`; plus `theme:systemChanged` push event |
| Voice | `voice:getToken` |
| Agent | `agent:send` (takes `sessionId`; steers if that chat is mid-turn), `agent:abort` (per sessionId), `agent:runningSessions`, `agent:listProviders`, `agent:listModels`; plus push events: `agent:event` / `agent:error` (every payload stamped with its `sessionId`) |
| Skills | `skills:list`, `skills:libraryDir`, `skills:importPicker`, `skills:importFromPath`, `skills:remove` |
| Workspaces | `workspace:inspectFolder`, `workspace:createWithRepo`, `workspace:addFromRepo` (covers both clone-into-empty and adopt-a-clone), `workspace:setUpHere`, `workspace:remove`, `workspace:forgetLocal`, `workspace:listFiles`, `workspace:ensureFiles` |
| Sync | `sync:verifyPat`, `sync:checkGit`, `sync:listRepos`, `sync:setWorkspaceDisabled`, `sync:engineStart`, `sync:engineStop`, `sync:engineStatus`, `sync:flushDone`, `sync:listConflicts`, `sync:resolveConflict`, `sync:keepConflict`, `sync:resetConflict`, `sync:keepAll`, `sync:resetToRemote`; plus push events `sync:status` (carries `conflicts[]` when paused), `sync:flushRequest` |

The renderer reaches every one of these via `window.api.*` — see `src/preload/preload.cjs`. The renderer never touches Node directly.
