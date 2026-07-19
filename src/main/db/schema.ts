// Chat-history schema (drizzle / better-sqlite3).
//
// Design (see docs discussion): pi's JSONL is the source of truth for CONTINUATION
// — pi resumes/continues from its own session file. This DB is the source of truth
// for DISPLAY + SEARCH — the sidebar rebuilds from `message` rows, and cross-chat
// search runs over `message_fts`. The two things pi does NOT persist and we do:
// the auto-generated `title` and the FROZEN `system_prompt` (pi re-derives the
// prompt live on resume; we capture the exact one used so resume is faithful).
//
// Deliberately far simpler than a hermes-style store: no billing/token/handoff/
// rewind columns, because pi carries the transcript. One row per pi message; a
// message's tool CALLS ride on the assistant row (`tool_calls` JSON), each tool
// RESULT is its own `role='tool'` row paired by `tool_call_id`.

import { sqliteTable, text, integer, real, blob, index, primaryKey } from 'drizzle-orm/sqlite-core';

// The workspaces the user has opened. A real table rather than rows in
// `setting`, because a workspace is an ENTITY, not a scalar preference: it has a
// fixed shape, and it must be atomic (one row = one workspace, so a delete can't
// leave a half-workspace behind the way N key rows could).
//
// A workspace IS a GitHub repo — `repoOwner`/`repoName`/`defaultBranch` are NOT
// NULL, so a workspace without a remote is unrepresentable. They are also the
// SOURCE OF TRUTH: nothing reads `.git/config`. They replaced an
// `origin_url`/`checked_at` cache that existed only because the repo used to be
// *discovered* by shelling out; owning it removed the discovery, the cache, the
// `setupLink` adopt-a-folder flow, and the id↔path adapters bridging the two.
//
// The trade that buys: a hand-run `git remote set-url` now makes disk disagree
// with this table, and this table wins. Pointing a workspace at a different repo
// is a UI action, not something picked up out of band.
export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  // REAL, not INTEGER, so a future drag-to-reorder can insert between two
  // neighbours (2.0, 3.0 → 2.5) in ONE write instead of renumbering the list.
  sortOrder: real('sort_order').notNull(),
}, (t) => ({
  bySort: index('idx_workspace_sort').on(t.sortOrder),
  byRepo: index('idx_workspace_repo').on(t.repoOwner, t.repoName),
}));

// What's true about a workspace ON ONE MACHINE. Split out from `workspace`
// because those two things answer different questions: `workspace` says which
// repo this is — the same answer everywhere — while everything here is local. A
// checkout path is meaningless on another box, "which one is open" is
// per-install, and pausing sync is a thing you do to one machine, not to a repo.
//
// Keyed by `(workspaceId, machine)` rather than workspaceId alone, so the rows
// for every machine can coexist. That's what lets this DB be copied or synced
// without its local half being wrong somewhere: each install reads its own row
// (every query joins on `machine = hostname()`) and leaves the others alone. A
// machine that has never opened a given workspace simply has no row, which is
// also how "not checked out here" is represented — there is no null path.
//
// `activeWorkspaceId` used to be a row in `setting`, i.e. a foreign key hiding
// in a key-value store — free to name a workspace that no longer existed, and
// global when it should have been per-machine. As a column it's deleted with
// its row, and the partial unique index makes two-active unrepresentable.
export const workspaceLocal = sqliteTable('workspace_local', {
  workspaceId: text('workspace_id').notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  // `os.hostname()`, same value and meaning as `chat_session.machine`.
  machine: text('machine').notNull(),
  // Absolute path of the clone on that machine.
  path: text('path').notNull(),
  // At most one row PER MACHINE may hold 1 (see idx_workspace_local_active).
  // NULL rather than 0 for "not active": SQLite treats NULLs as distinct in a
  // unique index, so a partial index over `active = 1` enforces the
  // single-active rule without a trigger.
  active: integer('active'),
  // Was `sync.disabledWorkspaceIds` — an array of ids in the settings blob,
  // i.e. a foreign key by another name. As a column it can't outlive its
  // workspace; the array could (and did) keep ids for workspaces long deleted.
  syncDisabled: integer('sync_disabled').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.machine] }),
  byPath: index('idx_workspace_local_path').on(t.machine, t.path),
  // NOTE: `idx_workspace_local_active` — the PARTIAL unique index that makes
  // two-active-on-one-machine unrepresentable — is created in
  // drizzle/0007_workspace_repo.sql and CANNOT be declared here: drizzle-kit
  // has no partial-index syntax. It is therefore invisible to schema diffing,
  // so a generated migration would emit a DROP for it and silently delete the
  // invariant. Hand-carry it, the same way `message_fts` is.
}));

// Scalar app preferences, one row per leaf key (dotted path, e.g.
// `appearance.treePanel.content`). Replaces the old `<userData>/settings.json`.
//
// Holds ONLY non-secret scalars. Credentials are in `secretValue`; collections
// (workspaces, agent secrets) are entity tables. What's left is what key-value
// is genuinely good at — heterogeneous, sparse, unrelated scalars.
//
// One row per key rather than a JSON blob means writes never collide, and a key
// with no row falls back to DEFAULT_SETTINGS — so there is no deep-merge to
// hand-maintain when a nested setting is added.
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  // 'string' | 'number' | 'boolean' | 'json' — tells the reader how to parse.
  type: text('type').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// User-managed credentials the coding agent can use. The ENTITY half only —
// every secret-bearing field lives in `secretValue`, which is why this table has
// no crypto columns at all.
export const agentSecret = sqliteTable('agent_secret', {
  // Unique identifier (case-insensitive by convention). Also the `owner` of this
  // entry's rows in `secretValue`.
  name: text('name').primaryKey(),
  description: text('description'),
  kind: text('kind'), // 'static' | 'oauth'; null ⇒ static (pre-OAuth entries)
  oauthProvider: text('oauth_provider'),
  oauthClientId: text('oauth_client_id'),
  oauthAuthUrl: text('oauth_auth_url'),
  oauthTokenUrl: text('oauth_token_url'),
  oauthScopes: text('oauth_scopes'), // JSON array
  // These three are written by the OAuth flow only (oauth.ts), never by a bulk
  // settings save — see OAUTH_OWNED_COLUMNS in settingsKeys.js.
  oauthExpiresAt: integer('oauth_expires_at'),
  oauthStatus: text('oauth_status'), // 'disconnected' | 'connected' | 'expired'
  oauthAccountEmail: text('oauth_account_email'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// EVERY encrypted value in the app, in one table.
//
// The crypto columns are NOT NULL, and that is the whole point: a plaintext
// credential is unrepresentable here. The previous shape carried a `secret` flag
// on `setting`, so a key that should have been secret but wasn't flagged
// persisted in the clear and nothing complained — the same silent-failure mode
// as the hand-maintained encrypt/decrypt field lists that flag had replaced.
//
// `owner` is 'settings' for standalone credentials (`sync.pat`,
// `transcription.apiKey`, `codingAgent.providerKeys.*`) or an agent_secret.name
// for that entry's token / OAuth tokens. One table also means key rotation is a
// single SELECT + UPDATE rather than a walk over the settings tree.
export const secretValue = sqliteTable('secret_value', {
  owner: text('owner').notNull(),
  field: text('field').notNull(),
  ciphertext: text('ciphertext').notNull(), // base64, AES-256-GCM
  iv: blob('iv').notNull(),
  tag: blob('tag').notNull(),
  // Which master key sealed this row. Single key today; present so a future
  // rotation can re-encrypt incrementally instead of all at once.
  keyVersion: integer('key_version').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.owner, t.field] }),
}));

export const chatSession = sqliteTable('chat_session', {
  // pi session id (SessionManager.getSessionId()). Stable key for the chat.
  sessionId: text('session_id').primaryKey(),
  // Workspace this chat belongs to (chats are workspace-scoped, like pi's cwd).
  workspace: text('workspace').notNull(),
  // Absolute path to pi's JSONL — what we pass to SessionManager.open() to resume.
  jsonlPath: text('jsonl_path').notNull(),
  // Auto-generated after the first exchange (fire-and-forget), or user-renamed.
  title: text('title'),
  // The FULL effective system prompt that actually went to the model, captured
  // at session create. Re-injected on resume via the pi extension so the model
  // continues with the same context (pi would otherwise re-derive today's prompt).
  systemPrompt: text('system_prompt'),
  model: text('model'),
  // Where this chat came from. 'desktop' (interactive, the default) or 'cron'
  // today; the column is open-ended so a future channel (telegram, api, …) needs
  // no migration. Lets the picker badge non-interactive runs and skip
  // auto-titling in favor of the job name.
  // Nullable in SQL on purpose — see drizzle/0006_chat_source.sql for why the
  // table isn't rebuilt to add NOT NULL. `upsertSession` always writes a value,
  // so it's effectively non-null going forward.
  source: text('source'),
  // Identity of the thing that started it, WITHIN that source. Null for desktop
  // (a person at this app — there's no external id to point at). For cron it's
  // the job name; a chat channel would put its chat/thread id here. Paired with
  // `source` it's the answer to "which specific X started this".
  sourceId: text('source_id'),
  // Hostname of the machine that created the chat (os.hostname()). Chats sync
  // between machines via the workspace, but a cron run is machine-local — this
  // is what tells you which box actually executed it.
  machine: text('machine'),
  createdAt: integer('created_at').notNull(),
  // Bumped on every turn; drives the "recent chats" sort + keyset pagination.
  updatedAt: integer('updated_at').notNull(),
  archived: integer('archived').notNull().default(0),
  // User-favorited chats float to their own section at the top of the picker.
  starred: integer('starred').notNull().default(0),
}, (t) => ({
  byWorkspaceUpdated: index('idx_chat_session_ws_updated').on(t.workspace, t.updatedAt),
}));

// Machine-local scheduler state for cron jobs. cron.json (a file at the
// workspace root) is the SOURCE OF TRUTH for job definitions (name / schedule /
// prompt / enabled) so the agent can edit it; this table holds only the timing
// that must NOT sync between machines: when a job is next due, when it last ran,
// its last error, and the chat that run created. One row per (workspace, job).
export const cronState = sqliteTable('cron_state', {
  // `${workspace}::${jobName}` — stable composite key.
  id: text('id').primaryKey(),
  // Absolute workspace path (matches chat_session.workspace).
  workspace: text('workspace').notNull(),
  jobName: text('job_name').notNull(),
  // Last-seen schedule string, so a schedule edit can be detected and reset.
  schedule: text('schedule').notNull(),
  // Epoch ms of the next fire; null when disabled/cleared (won't fire).
  nextRunAt: integer('next_run_at'),
  lastRunAt: integer('last_run_at'),
  // Actual error message from the last failed run (start-time or mid-run), else null.
  lastError: text('last_error'),
  // chat_session.sessionId of the last run — for the "open last run" link.
  lastSessionId: text('last_session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  byNextRun: index('idx_cron_state_next_run').on(t.nextRunAt),
}));

export const message = sqliteTable('message', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => chatSession.sessionId, { onDelete: 'cascade' }),
  // Monotonic order within a session (mirrors pi's message index). Written as
  // complete messages only — never streaming partials (hermes' flush-cursor
  // pattern): main upserts messages beyond the stored count after each turn.
  seq: integer('seq').notNull(),
  // 'user' | 'assistant' | 'tool'
  role: text('role').notNull(),
  // User/assistant text, or the tool result text. JSON string when the message
  // carries image blocks.
  content: text('content'),
  // Assistant thinking, if any (pi ThinkingContent). Null on other roles.
  reasoning: text('reasoning'),
  // JSON array of {id, name, arguments} — the tool CALLS an assistant turn made.
  // Null unless role='assistant' and it called tools.
  toolCalls: text('tool_calls'),
  // On a role='tool' row: which call (from some assistant row's tool_calls[].id)
  // this result answers.
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  bySessionSeq: index('idx_message_session_seq').on(t.sessionId, t.seq),
}));

// NOTE: the FTS5 virtual table `message_fts` + its sync triggers are NOT
// expressible in drizzle's schema DSL. They are appended as raw SQL to the
// generated migration (see drizzle/0000_*.sql, hand-edited). message_fts indexes
// message.content keyed by message.id, kept in sync by AFTER INSERT/UPDATE/DELETE
// triggers on `message`. See src/main/db/index.ts for the search query.
