# Shockwave Companion — design

Status: **design agreed, nothing built.** This document is the current state of the plan,
including how we got here.

## What we're building

An Express + SQLite server that runs in Docker and acts as the shared backend for Shockwave
desktop clients. It holds:

- **Settings** — agent config, credentials, agent secrets
- **Chats** — the chat rows and the chat JSON files

The desktop connects with a **URL + API key**. Once connected, those things read/write through
the server instead of the local database. Everything machine-specific stays local.

Server config the server needs for its own operation (`MASTER_KEY`, `API_KEY`, later a provider
key and a workspace/repo list) is **env**, not synced state. Env is how the server configures
itself — it is not a sync mechanism.

## Rules

1. **When connected, the server is the source of truth for settings + secrets.** No merging.
2. **Chats are local-first and published up.** The machine that created a chat is its only writer.
3. **All editing happens on the desktop.** The server has no UI. It stores and serves.
4. **The mirror is a copy.** It only receives; it never sends anything up.
5. **Offline: read from the mirror, settings writes blocked.** Nothing is written locally while
   disconnected, so reconnecting is "fetch current", never "reconcile".
6. **Token refresh only happens where the tokens live.** Never against a cache.
7. **One list decides which settings are machine-local.** Same list drives reads and writes.

---

## Settings

### What syncs

| key | what |
|---|---|
| `codingAgent` | provider, model, thinkingLevel, baseUrl, **and `providerKeys.<slug>`** |
| `agentSecrets[]` | user-managed credentials the agent uses — what `get_agent_secret` returns |
| `transcription` | voice dictation: provider + API key |
| `sync.pat` | GitHub personal access token |
| *(future)* Telegram credentials | new settings default to the companion — no work needed |

### What stays on this machine

Written to `<userData>/local-settings.json` (a plain file, not the DB):

```js
MACHINE_LOCAL_KEYS = ['appearance', 'windowBounds', 'sidebarWidth', 'chatSidebarWidth',
                      'chatSidebarOpen', 'viewMode', 'treeSortOrder', 'bookmarkFilterActive',
                      'activeWorkspaceId', 'cron', 'sync.pullIntervalSeconds']
```

**Workspaces stay local**, in the existing `workspace` SQLite table — they're an entity with rows,
not a scalar preference. Later, the server may define workspaces from an env var (a PAT + repo
list); at that point the server defines them *as repos* and each desktop resolves repo → local
folder.

### Routing

One list in `settingsKeys.js`, beside the existing `SETTINGS_SECRET_PATTERNS`.

- **Write** — flatten the patch to dotted leaf keys, route each by prefix: listed keys →
  `local-settings.json`, everything else → the store.
- **Read** — store tree → overlay `local-settings.json` → overlay local workspaces → one object.

This works because settings are already stored **one row per leaf key with `DEFAULT_SETTINGS`
fallback** — absent means default, so there is no merge algorithm. Routing after flattening, by
prefix, is exactly how secret classification already works.

**Subtree vs leaf matters.** `appearance` and `cron` are subtrees — prefix matching pulls in every
leaf under them, which is intended. `sync` is **not** listed, only `sync.pullIntervalSeconds`:
listing the subtree would drag `sync.pat` local and quietly make the GitHub token machine-only.

`sync.disabledWorkspaceIds` is derived on read from the `workspace.sync_disabled` column and
ignored on write — it rides along with workspaces, which are local.

### Cost

**Zero call sites change.** Everything going remote is reached through `readSettings` /
`writeSettings` / `patchAgentSecretOAuth`, all already async and already awaited everywhere
(`main.ts:124,139,222,930,1090,1259,1807…`, `oauth.ts:257`, `cron.ts:129,168,205,281`).

---

## Chats

### Model

**Local-first, published up. One writer per chat.**

- Your chats live locally and are pushed to the server as they happen.
- Other machines' chats are pulled down into your local DB, so everything operates normally.
- `chat_session.machine` / `source` / `source_id` already record origin.
- **Continuing a chat from another machine forks it** — new id, copy of the chat JSON, new row
  owned by you. This is what guarantees a single writer and removes conflicts by construction.

### What syncs

```
push  →  the chat JSON file  +  the chat_session row     (instant, after each turn)
pull  →  same                                            (interval, default 60s)
```

Only chats with recent activity are pushed, and only the bytes/fields new since the last push.

**Message rows are NOT synced** — see below, they're being removed entirely.

### Chat JSON storage

One file per chat, named by session id:

```
/data/sessions/<sessionId>.jsonl        (server)
<userData>/pi-agent/sessions/…          (client, unchanged)
```

**Files, not a DB column.** SQLite's own benchmark puts the blob/file crossover at 100KB
(<https://sqlite.org/fasterthanfs.html>). A real agent session is megabytes — tool results carrying
file contents, plus inline base64 images. And the file is appended every turn: a blob column means
rewriting the whole thing per message, a file means appending a few KB.

**Upload is incremental.** Send bytes after the last known offset; the server verifies its current
length matches and appends. If it doesn't match (pi compacts / rewrites — `_rewriteFile` exists),
send the whole file.

**Order of operations per turn: file first, then the row.** If the row landed first, another
machine could pull a chat with no JSON behind it. File-first means the worst case is a JSON
slightly ahead of its row, which is harmless.

Track two cursors per chat, both local and machine-specific: last pushed byte offset, last pushed
seq.

### Dropping the `message` table

**Verified: the chat JSON is a strict superset of the `message` table.** Every column is derivable,
several with better fidelity:

- **Images** — `piMessageToRow` drops image blocks today (`chatStore.ts:306`: "images degrade to
  text"). The JSON has them as base64 blocks.
- **`isError`** — hardcoded `false` on hydrate today (`chatStore.ts:333`). The JSON has it on every
  tool result.
- **Per-message timestamps** — `persistMessages` stamps the same `now` on every message in a flush
  batch, so DB timestamps are per-turn. The JSON has true per-message times.

**No session boot required.** `parseSessionEntries` and `buildContextEntries` are exported from the
package index, so it's `readFileSync` → parse → map. No model resolution, no auth, no
`SessionManager.open`.

**The only blocker was cross-chat full-text search** (`message_fts`, keyed on `message.id` via
triggers). **Decision: search is title-only**, so the blocker is gone and `message` + `message_fts`
can both go.

`title` and `system_prompt` are genuinely not in the chat JSON (the title is LLM-generated and
never appended; the system prompt is a runtime hook, not session state). Both live in
`chat_session`, so neither blocks anything — and both are why the chat row still has to sync.

**Three things to handle:**

1. **Order comes from walking `parentId`, not line order.** The format is a tree (v3). Nothing in
   the app branches today so line order happens to work, but it isn't guaranteed — use
   `buildContextEntries`, don't hand-roll a line reader.
2. **A missing chat JSON renders empty.** Check on **open**, not on list — opening already reads
   the file, so it costs nothing, whereas listing would mean stat-ing every file. If the read
   fails, show a message plus a Delete button. No recovery attempt.
3. **`deleteSession` never unlinks the JSON** today. Once the file *is* the chat, deleting must
   remove it.

---

## Architecture

### The seam

```
store.call(method, args)
  local  → run core.ts here, against local shockwave.db
  remote → POST {url}/rpc {method, args} + Bearer key
           server runs the SAME core.ts against its own db
```

Chosen **once at boot** by `createStore()` from `companion.json`. `settingsStore.ts` stays a
facade, so `await readSettings()` is unchanged everywhere.

`core.ts` is today's query bodies with electron removed — moved code, not new code. The server is:
verify key → allowlist → `core[method](...args)` → JSON. **No logic of its own**, so adding a store
function later needs no server work.

Not doing an HTTP server inside main for local mode: bound port, loopback auth surface, latency,
extra boot failure mode, zero gain. Unify the contract, not the socket.

**Why `core.ts` has to be extracted:** today's code reaches for electron — `masterKey.ts` calls
`safeStorage`, `db/index.ts` calls `app.getPath('userData')` and `app.isPackaged`. The fix is to
make those **inputs** rather than lookups:

```
desktop → core.getSecret({db: localDb,  key: fromSafeStorage}, name)
server  → core.getSecret({db: serverDb, key: fromEnv},         name)
```

### Files

```
src/shared/store/
  schema.ts        MOVED from src/main/db/schema.ts (already dependency-pure)
  settingsKeys.js  MOVED from src/main/settingsKeys.js (+ MACHINE_LOCAL_KEYS)
  crypto.ts        seal/unseal extracted from masterKey.ts; key becomes a parameter
  core.ts          query bodies + OAuth refresh, async, ctx {db, key}. No electron.
  contract.ts      STORE_METHODS allowlist
src/main/store/
  index.ts  local.ts  remote.ts  localFiles.ts   (companion.json + local-settings.json)
companion/
  package.json  src/server.ts  Dockerfile  docker-compose.yml  .dockerignore  .env.example
drizzle/          shared
```

Only `tests/settingsKeys.test.js` imports anything being moved.

### Companion config

`<userData>/companion.json`, mode 0600, tmp+rename — same treatment as `masterkey.enc`, and it
toggles whether the local tables are used at all, so it can't live inside them.

```json
{ "enabled": false, "url": "", "apiKey": {sealed}, "pollSeconds": 30, "chatPullSeconds": 60 }
```

The API key is sealed under the existing master key. Boot order is acyclic (`masterKey.ts` imports
only `node:*` + electron): `getMasterKey()` → read `companion.json` → unseal → `createStore()`.

Its own IPC (`companion:read` / `companion:write` / `companion:test`) because `settings:read` reads
the DB and this isn't in it — same pattern bookmarks already use.

If `masterkey.enc` is lost, `getMasterKey()` throws by design and the API key can't be decrypted.
Degrade to "re-enter your API key", not a boot crash.

---

## Secrets

Server holds `MASTER_KEY`, owns its `secret_value` rows, decrypts on read — `readSettings()` must
keep returning plaintext credentials, which is the contract every consumer depends on.

Encrypted at rest on both ends, TLS in transit, bearer auth per request. **`http://` is allowed
only for localhost/127.0.0.1**, refused for remote hosts — safe by construction, no escape hatch,
and ngrok issues `https://` anyway.

`crypto.ts` is byte-identical on both sides; only the key *provider* differs (safeStorage-wrapped
file vs env var). Secrets cached in the mirror are **re-sealed under this machine's master key**,
so the cache has the same at-rest guarantees as normal local storage.

### Narrow methods for the agent-secret tools

`get_agent_secret` / `list_agent_secrets` are **model-invoked at unbounded frequency**. Today the
bridge (`main.ts:1839/1846`) calls full `readSettings()` per tool call — and an OAuth secret costs
up to **three** full reads (bridge → `oauth.ts` `loadSecret` → refresh → `emitChanged`), each
decrypting every credential.

Add `getSecret(name)` and `listSecretNames()` (metadata only). Also have `writeSettings` **return**
the fresh settings so `emitChanged` needs no second round trip.

### OAuth

The tool doesn't change — only where it gets its result.

- **Desktop:** `startConnect` / `disconnect`. Needs `shell.openExternal`, the loopback callback
  server, in-memory state/verifier — inherently a desktop flow. Writes its result through the
  store, so connecting on one machine makes the secret usable from another.
- **Shared `core.ts`:** `getFreshToken` + `postToken` + `PROVIDER_PRESETS` — read, check expiry,
  refresh, persist, return. Local mode runs the same code in-process.

**Per-name lock, server-side.** Google rotates refresh tokens, so two clients refreshing
concurrently means the loser's write kills the connection permanently. Client-side in-flight maps
cannot serialize across machines. *Deferrable* — with one desktop, `oauth.ts`'s existing in-process
guard already covers it.

---

## Offline

Three paths, and only two contain refresh code at all:

```
local mode           → core.getSecret(ctx = local db)          → can refresh
remote, connected    → POST /rpc → server runs core.getSecret  → can refresh
remote, disconnected → mirror read                             → NO refresh code exists here
```

That is the enforcement — not a runtime `if (offline)`. The fallback is a separate, smaller
function that can only return stored values; it cannot reach a provider or persist a token, so the
destructive path is unrepresentable. Same discipline as `secret_value`'s `NOT NULL` crypto columns.

Its only check is a timestamp comparison against `oauth_expires_at`:

- **static token** → served from the mirror indefinitely
- **OAuth, still valid** → served from the mirror (access tokens are ~1h, so real grace)
- **OAuth, near/past expiry** → clear error, "reconnect to refresh this credential"

**Refusing is deliberate**: a refresh returns a *new* refresh token and invalidates the old one, so
refreshing without being able to persist destroys the credential silently.

Chats keep working offline entirely — they're local-first, and unpushed work simply queues.

---

## Staleness

The renderer's `settingsRef` only updates on `settings:changed`, which fires for main's own writes
— so another client's change would leave the UI stale while behavior was already correct.

`GET /version` returns `MAX(updated_at)` across the synced settings tables. `agent_secret` and
`secret_value` both have an `updated_at` column (`schema.ts:81,105`), so there's nothing to add.
Client polls every `pollSeconds` (default 30); when it moves, re-read and fire the existing
`settings:changed`, which the renderer already knows how to apply.

Keeping chatty UI state out of the companion is what makes this safe: with `windowBounds` remote,
every window drag would bump the version and make every client re-download all credentials.

---

## Server

**Express 5** — async errors propagate to the error handler natively; Express 4 needs a wrapper
around every async route, which is a footgun for exactly this shape of app.

- `GET /health` — **unauthenticated**, minimal payload (`{ok, migration}`). Docker's healthcheck
  needs it; it must leak nothing.
- `GET /version` — authenticated.
- `POST /rpc` — authenticated. bearer → allowlist → `core[method](...args)` → JSON.
- `GET|PUT /session/:id/transcript` — authenticated, streaming, **outside** the JSON-RPC dispatch.

Boot: open SQLite at `DATA_DIR/shockwave.db`, run the shared `drizzle/` migrations, **refuse to
start** without `MASTER_KEY` / `API_KEY`. Outbound network required (OAuth refresh).

### Hardening

- **Auth:** `crypto.timingSafeEqual` on the bearer token, not `===`. Compare fixed-length hashes so
  the comparison can't leak length either.
- **Rate limit** `/rpc` and `/version` — the API key is the only thing between the internet and
  every credential. Set the limit above the poll rate × expected clients, or normal use trips it.
- **`express.json({ limit: '1mb' })`** — RPC payloads are small; larger is abuse. (Transcript
  upload is a separate streaming route.)
- **No CORS — it does not apply.** CORS is enforced by *browsers*, not servers. The desktop calls
  from Electron's main process via Node `fetch`, not a browser context, so no preflight or origin
  check ever happens; `cors()` would be dead code. It's not a security control here either — a
  webpage can send a request regardless; CORS only governs reading the response. The bearer token
  is the gate.
- **`helmet()`** for security headers.
- **`app.set('trust proxy', 1)`** behind Traefik, or rate limiting sees one IP for everyone.
- **Error handler that does not leak** — map to `{error: code}`; never return stack traces or SQL.
- **Method allowlist is a literal array** — not `if (method in core)`, which would make every
  export remotely callable, including internal helpers and anything added later.
- **Graceful shutdown:** `SIGTERM` → stop accepting, drain, close SQLite.
- **Structured logging** (`pino`) of method, status, duration only. **Never log request/response
  bodies or the API key** — `/rpc` responses are credentials by design, and Docker captures stdout.

### Packaging

**Own `package.json` + `node_modules`.** This repo's `postinstall` runs `electron-rebuild -f -w
better-sqlite3`, compiling the native module against Electron's ABI. A plain-node server sharing
those modules fails to load it outright. Not optional.

**Build step.** `core.ts` is TypeScript. The companion bundles `server.ts` + the shared store with
esbuild into `dist/server.js` at image build time, so the runtime is plain node plus the
better-sqlite3 native module.

### Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (needs src/shared/store + drizzle).
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 installs via `prebuild-install || node-gyp rebuild`; these make the fallback work.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY companion/package*.json ./
RUN npm ci
COPY companion/ ./
COPY src/shared/store ./src/shared/store
RUN npm run build          # esbuild → dist/server.js
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /data/sessions && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```

`node -e fetch` for the healthcheck because the slim image has no curl. **`.dockerignore` must
exclude `node_modules`**, or `COPY companion/ ./` drags in the host's Electron-ABI build.

### docker-compose.yml

```yaml
services:
  companion:
    build: { context: ., dockerfile: companion/Dockerfile }
    restart: unless-stopped
    environment:
      MASTER_KEY: ${MASTER_KEY:?set in .env}
      API_KEY:    ${API_KEY:?set in .env}
      DATA_DIR:   /data
      PORT:       8080
    volumes: [companion-data:/data]
    ports: ["8080:8080"]      # remove when fronting with Traefik
    # labels:
    #   - traefik.enable=true
    #   - traefik.http.routers.shockwave.rule=Host(`companion.example.com`)
    #   - traefik.http.routers.shockwave.tls.certresolver=le
    #   - traefik.http.services.shockwave.loadbalancer.server.port=8080
volumes:
  companion-data:
```

Runs identically with or without a proxy. Local testing: `docker compose up`, connect to
`http://localhost:8080` (allowed — loopback), or point ngrok at it for an `https://` URL.

`/data` holds the secrets and chat JSON. Destroying the volume (realistically `docker compose
down -v`) loses them, but each connected desktop keeps a copy — recoverable, not fatal.

---

## Boot ordering (must fix)

`createWindow()` awaits `readSettings()` **before** creating the BrowserWindow (`main.ts:222`), and
`ensureBuiltinSecretSlots()` (`main.ts:1946`) reads *and writes* before any window exists. In
remote mode a down companion means the app launches to **nothing** — no window, no error, no way to
fix the URL.

Create the window first with defaults, apply saved bounds after; make `ensureBuiltinSecretSlots`
non-blocking and failure-tolerant. It only ADDs missing names, so it's idempotent across machines.

---

## Verified constraints

- **better-sqlite3 transactions are synchronous.** `writeSettings` (`settingsStore.ts:225-239`)
  uses `db.transaction((tx) => {…})`, which cannot await — so it must be **one** RPC call executing
  wholly server-side. It cannot be decomposed into finer methods.
- **`loadSecrets()` must stay unexported.** It returns a `Map`, which `JSON.stringify` flattens to
  `{}` — silent empty secrets, no error.
- **Everything else is JSON-clean** (verified): timestamps are `integer` epoch-ms, booleans are
  0/1, no BigInt, and the only BLOBs (`secret_value.iv`/`.tag`) never escape `loadSecrets`.
- **`getDb()` cannot move into core** — electron-coupled twice (`db/index.ts:22-40`). Core receives
  a ready drizzle handle via ctx. `emitChanged` stays desktop-side.
- **`importLegacySettingsIfNeeded()` always targets local.** It uses `safeStorage` directly and
  migrates *this machine's* old `settings.json`, before the store is chosen.

---

## Other decided items

- **Toggling the companion requires an app restart.** `store` is chosen once at boot; swapping live
  splits in-flight work across backends.
- **Push local → companion / Pull companion → local** — two buttons in the Companion section,
  always available, also offered at toggle time as a plain confirm ("…This replaces what's
  there."). Keep the first version dumb: read one side, write the other, no diffing or merging.
- **Secrets can't be copied as ciphertext** — sealed under different master keys. Transfer =
  decrypt locally, send, re-encrypt server-side.
- **Concurrent writes to one setting** are last-write-wins, silently. Acceptable — a PAT can be
  re-pasted. Concurrent OAuth refresh is not; hence the lock.
- **First connect to an empty companion** shows nothing — expected, and what Push is for. Say so in
  the UI rather than letting it look like data loss.

---

## Phases

**1 — extract the seam. Local only, no server, no behavior change.**
Move `schema.ts` + `settingsKeys.js` to `src/shared/store/`; extract `crypto.ts`; move query bodies
+ OAuth refresh into `core.ts`; `contract.ts` + `store/local.ts` + `store/index.ts`;
`localFiles.ts`; `MACHINE_LOCAL_KEYS` + the split; facades; `getSecret` / `listSecretNames` and
point the bridge at them; fix boot ordering.
Gate: `npm test`, `npm run typecheck`, `npx eslint .`, app behaves identically.

**2 — chat JSON as the source of truth.** Render transcripts from the chat JSON via
`parseSessionEntries` + `buildContextEntries`; title-only search; drop `message` + `message_fts`;
handle a missing JSON on open; unlink the JSON on delete. Independent of the server — could ship
on its own.

**3 — companion server + Docker.**

**4 — remote client + UI.** `remote.ts` (timeout, typed errors, loopback-only-http guard,
write-through mirror, expiry-aware fallback); `companionConfig.ts` + the three IPC channels;
Settings → Companion section (URL, key, toggle, intervals, Test) following the existing
`SyncSection.tsx` verify-then-save pattern; push/pull buttons; offline banner; version poll.

**5 — chat sync.** Push worker (file first, then row, incremental, recent chats only); pull loop;
fork-on-continue.

---

## How we got here

Scope moved several times. Recording the reasoning so it isn't relitigated:

- **Started broad** — settings, secrets, workspaces, and chat history on the server.
- **Cut chats**, because `chat_session.jsonlPath` is an absolute local path and a missing chat JSON
  fails *silently*: pi's `SessionManager.open()` returns an empty transcript, mints a fresh session
  id, and even `mkdir`s the other machine's directory tree locally. The UI still shows full history
  (it renders from the DB), so the model has amnesia while everything looks fine — and
  `persistMessages`' cursor guard then silently drops the next ~40 messages.
- **Narrowed to agent secrets only**, on the argument that everything else is server config and
  belongs in env.
- **Widened back** to most settings (agent config, PAT, transcription, Telegram later), keeping
  workspaces local.
- **Chats came back** once the ownership model was clear: one writer per chat, fork-on-continue,
  push one-way. That removes the merge problem, and local-first removes the offline problem.
- **`message` table is being dropped**, because the chat JSON is a strict superset and the only
  thing that needed the index was cross-chat text search — which is now title-only.

Two things were investigated and settled with evidence rather than opinion: the JSONL/`message`
parity check above, and the blob-vs-file question (SQLite's own 100KB crossover, versus transcripts
that run to megabytes and are appended every turn).
