// Chat-history data access (better-sqlite3 + drizzle).
//
// The DB is the source of truth for DISPLAY + SEARCH; pi's JSONL is the source of
// truth for CONTINUATION. See schema.ts. Everything here runs in the main process;
// the renderer reaches it only through the `chat:*` IPC handlers in main.ts.
//
// Opened lazily on first use, migrated once from the shipped `drizzle/` folder
// (idempotent — drizzle records applied migrations in __drizzle_migrations).

import path from 'node:path';
import { hostname } from 'node:os';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import { chatSession, message, cronState, workspace } from './schema.js';

let sqlite: Database.Database | null = null;
let db: BetterSQLite3Database | null = null;

function migrationsFolder(): string {
  // Shipped via electron-builder `extraResources` in prod; the repo folder in dev.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'drizzle')
    : path.join(app.getAppPath(), 'drizzle');
}

export function getDb(): BetterSQLite3Database {
  if (db) return db;
  const file = path.join(app.getPath('userData'), 'shockwave.db');
  sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const d = drizzle(sqlite);
  migrate(d, { migrationsFolder: migrationsFolder() });
  db = d;
  return db;
}

// Raw handle for FTS queries drizzle can't express. Assumes getDb() has run.
function raw(): Database.Database {
  if (!sqlite) getDb();
  return sqlite as Database.Database;
}

// ---- pi message → row mapping -------------------------------------------------
// pi messages (session.state.messages) are the pi-ai Message union:
//   user:       { role:'user',       content: string | (Text|Image)[] }
//   assistant:  { role:'assistant',  content: (Text|Thinking|ToolCall)[] }
//   toolResult: { role:'toolResult', toolCallId, toolName, content:(Text|Image)[], isError }
// We flatten to one row each. Image blocks degrade to omitted text (documented
// cosmetic loss — the transcript text + tool calls are preserved in full).

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  }
  return '';
}

function thinkingOf(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const t = content
    .filter((c) => c && c.type === 'thinking' && typeof c.thinking === 'string')
    .map((c) => c.thinking)
    .join('');
  return t || null;
}

function toolCallsOf(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const calls = content
    .filter((c) => c && c.type === 'toolCall')
    .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
  return calls.length ? JSON.stringify(calls) : null;
}

function piMessageToRow(m: any, now: number) {
  if (m?.role === 'assistant') {
    return {
      role: 'assistant',
      content: textOf(m.content) || null,
      reasoning: thinkingOf(m.content),
      toolCalls: toolCallsOf(m.content),
      toolCallId: null as string | null,
      toolName: null as string | null,
      createdAt: now,
    };
  }
  if (m?.role === 'toolResult') {
    return {
      role: 'tool',
      content: textOf(m.content) || null,
      reasoning: null,
      toolCalls: null,
      toolCallId: m.toolCallId ?? null,
      toolName: m.toolName ?? null,
      createdAt: now,
    };
  }
  // user (and any other single-content role)
  return {
    role: 'user',
    content: textOf(m.content) || null,
    reasoning: null,
    toolCalls: null,
    toolCallId: null as string | null,
    toolName: null as string | null,
    createdAt: now,
  };
}

// ---- session writes -----------------------------------------------------------

export function upsertSession(row: {
  sessionId: string;
  workspace: string;
  jsonlPath: string;
  systemPrompt: string | null;
  model: string | null;
  now: number;
  // Where the chat came from: 'desktop' (default) or 'cron' today; open-ended so
  // a future channel needs no migration. Set on insert only; preserved on resume.
  source?: string | null;
  // Identity within that source — the cron job name, a chat/thread id, etc.
  // Null for desktop: a person at this app has no external id to point at.
  sourceId?: string | null;
}) {
  getDb().insert(chatSession).values({
    sessionId: row.sessionId,
    workspace: row.workspace,
    jsonlPath: row.jsonlPath,
    systemPrompt: row.systemPrompt,
    model: row.model,
    source: row.source ?? 'desktop',
    sourceId: row.sourceId ?? null,
    // Which box actually ran it. Chats travel with the workspace, but a cron run
    // is machine-local, so the transcript alone can't tell you where it executed.
    machine: hostname(),
    createdAt: row.now,
    updatedAt: row.now,
  }).onConflictDoUpdate({
    target: chatSession.sessionId,
    // Keep the frozen prompt/title; just refresh the path (pi may rotate files)
    // and the recency stamp.
    set: { jsonlPath: row.jsonlPath, updatedAt: row.now },
  }).run();
}

export function setSessionTitle(sessionId: string, title: string) {
  getDb().update(chatSession).set({ title }).where(eq(chatSession.sessionId, sessionId)).run();
}

export function touchSession(sessionId: string, now: number) {
  getDb().update(chatSession).set({ updatedAt: now }).where(eq(chatSession.sessionId, sessionId)).run();
}

// Persist COMPLETE messages only, flush-cursor style: insert every pi message at
// index >= the count already stored. Called after a successful turn (agent_end).
// If pi's array is shorter than what we stored (compaction/splice), we no-op the
// insert rather than corrupt ordering — the stored transcript stays intact.
export function persistMessages(sessionId: string, piMessages: any[], now: number): number {
  const d = getDb();
  const storedCountRow = raw()
    .prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?')
    .get(sessionId) as { n: number };
  const stored = storedCountRow?.n ?? 0;
  if (!Array.isArray(piMessages) || piMessages.length <= stored) return 0;

  const rows: any[] = [];
  for (let i = stored; i < piMessages.length; i++) {
    rows.push({ sessionId, seq: i, ...piMessageToRow(piMessages[i], now) });
  }
  if (rows.length) {
    d.insert(message).values(rows).run();
    touchSession(sessionId, now);
  }
  return rows.length;
}

export function deleteSession(sessionId: string) {
  // FK cascade removes messages; FTS triggers clean message_fts.
  getDb().delete(chatSession).where(eq(chatSession.sessionId, sessionId)).run();
}

// ---- reads --------------------------------------------------------------------

export function getSession(sessionId: string) {
  const rows = getDb().select().from(chatSession).where(eq(chatSession.sessionId, sessionId)).all();
  return rows[0] ?? null;
}

export function getMessages(sessionId: string) {
  return getDb().select().from(message)
    .where(eq(message.sessionId, sessionId))
    .orderBy(message.seq)
    .all();
}

// Recent (non-starred) chats for the picker. Keyset pagination on updatedAt
// (pass the last row's updatedAt as `before` to page). Starred chats are shown
// in their own section (listStarred) so they're excluded here to avoid dupes.
export function listSessions(workspace: string, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const conds = [eq(chatSession.workspace, workspace), eq(chatSession.archived, 0), eq(chatSession.starred, 0)];
  if (typeof opts.before === 'number') conds.push(lt(chatSession.updatedAt, opts.before));
  return getDb().select().from(chatSession)
    .where(and(...conds))
    .orderBy(desc(chatSession.updatedAt))
    .limit(limit)
    .all();
}

// Starred chats (the pinned section at the top of the picker), most-recent first.
export function listStarred(workspace: string) {
  return getDb().select().from(chatSession)
    .where(and(eq(chatSession.workspace, workspace), eq(chatSession.archived, 0), eq(chatSession.starred, 1)))
    .orderBy(desc(chatSession.updatedAt))
    .all();
}

export function setSessionStarred(sessionId: string, starred: boolean) {
  getDb().update(chatSession).set({ starred: starred ? 1 : 0 }).where(eq(chatSession.sessionId, sessionId)).run();
}

// Cross-chat full-text search. Returns matching sessions (most-recent first) with
// a short content snippet from a matching message. FTS query is sanitized to a
// prefix match so partial words work and MATCH-syntax chars can't throw.
//
// NOTE: FTS5's snippet()/rank auxiliary functions can't be used across a JOIN
// (SQLite flattens the subquery and loses the match context), so we filter
// sessions via an IN-subquery on the FTS match and pull a matching message's
// content as the raw snippet — trimmed in JS below.
export function searchSessions(workspace: string, query: string, opts: { limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const cleaned = String(query).replace(/["*]/g, ' ').trim();
  if (!cleaned) return [];
  const match = cleaned.split(/\s+/).map((t) => `"${t}"*`).join(' ');
  const rows = raw().prepare(
    `SELECT s.session_id AS sessionId, s.title AS title, s.updated_at AS updatedAt,
            (SELECT m2.content FROM message m2 JOIN message_fts f2 ON f2.rowid = m2.id
               WHERE m2.session_id = s.session_id AND f2.message_fts MATCH ? LIMIT 1) AS matched
       FROM chat_session s
      WHERE s.workspace = ? AND s.archived = 0
        AND s.session_id IN (
          SELECT m.session_id FROM message_fts JOIN message m ON m.id = message_fts.rowid
           WHERE message_fts MATCH ?)
      ORDER BY s.updated_at DESC
      LIMIT ?`,
  ).all(match, workspace, match, limit) as any[];
  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title,
    updatedAt: r.updatedAt,
    snippet: snippetOf(r.matched, cleaned),
  }));
}

// ---- cron scheduler state -----------------------------------------------------
// Machine-local timing for cron jobs (see schema.ts). cron.json owns the job
// DEFINITIONS; this table owns nextRunAt/lastRunAt/lastError/lastSessionId. The
// stateful controller in cron.ts orchestrates these; the reconcile logic there
// decides which of ensureCronRow / updateCronState / pruneCronState to call.

function cronId(workspace: string, jobName: string): string {
  return `${workspace}::${jobName}`;
}

export function listCronState(workspace: string) {
  return getDb().select().from(cronState).where(eq(cronState.workspace, workspace)).all();
}

export function getCronState(workspace: string, jobName: string) {
  const rows = getDb().select().from(cronState)
    .where(eq(cronState.id, cronId(workspace, jobName))).all();
  return rows[0] ?? null;
}

// Insert a row only if one doesn't exist for this (workspace, job). Existing
// rows keep their persisted timing (that's how catch-up survives restarts).
export function ensureCronRow(row: {
  workspace: string; jobName: string; schedule: string; nextRunAt: number | null; now: number;
}) {
  getDb().insert(cronState).values({
    id: cronId(row.workspace, row.jobName),
    workspace: row.workspace,
    jobName: row.jobName,
    schedule: row.schedule,
    nextRunAt: row.nextRunAt,
    lastRunAt: null,
    lastError: null,
    lastSessionId: null,
    createdAt: row.now,
    updatedAt: row.now,
  }).onConflictDoNothing().run();
}

export function updateCronState(
  workspace: string,
  jobName: string,
  patch: Partial<{ schedule: string; nextRunAt: number | null; lastRunAt: number | null; lastError: string | null; lastSessionId: string | null }>,
  now: number,
) {
  getDb().update(cronState)
    .set({ ...patch, updatedAt: now })
    .where(eq(cronState.id, cronId(workspace, jobName)))
    .run();
}

// Drop rows for jobs no longer present in cron.json. Empty keep list → clear all
// rows for the workspace.
export function pruneCronState(workspace: string, keepJobNames: string[]) {
  const conds = [eq(cronState.workspace, workspace)];
  if (keepJobNames.length) conds.push(notInArray(cronState.jobName, keepJobNames));
  getDb().delete(cronState).where(and(...conds)).run();
}

export function deleteCronStateForWorkspace(workspace: string) {
  getDb().delete(cronState).where(eq(cronState.workspace, workspace)).run();
}

// ---- workspaces ---------------------------------------------------------------
// A workspace is an entity, not a setting, so it gets a real table (see
// schema.ts). settingsStore's readSettings/writeSettings route `workspaces`
// here, which is why the renderer still sees it as a plain field on Settings.

export function listWorkspaces() {
  return getDb().select().from(workspace).orderBy(workspace.sortOrder).all();
}

// Reconciles the table against the full list the renderer sent: drops workspaces
// no longer present, upserts the rest, and renumbers sort_order from array
// position.
//
// Deliberately does NOT touch origin_url / checked_at — those are main-authored
// (workspaceStatus fills them) and the renderer never sends them. Listing them
// in the upsert's `set` would wipe the cache on every settings save, the same
// clobber that OAUTH_OWNED_RE prevents for tokens.
export function replaceWorkspaces(list: Array<{ id: string; name: string; path: string }>) {
  const db = getDb();
  db.transaction((tx: any) => {
    const keep = list.filter((w) => w?.id).map((w) => w.id);
    if (keep.length) tx.delete(workspace).where(notInArray(workspace.id, keep)).run();
    else tx.delete(workspace).run();

    list.forEach((w, i) => {
      if (!w?.id) return;
      const row = { id: w.id, name: w.name ?? '', path: w.path ?? '', sortOrder: i + 1 };
      tx.insert(workspace).values(row).onConflictDoUpdate({
        target: workspace.id,
        set: { name: row.name, path: row.path, sortOrder: row.sortOrder },
      }).run();
    });
  });
}

// Sync on/off for ONE workspace — the shape of the actual user action ("disable
// sync for this workspace"), and the only writer of this column.
//
// It was briefly a set-replacement taking the whole id array, which rewrote
// every workspace row to flip one flag — the same all-at-once write this schema
// exists to avoid. `sync.disabledWorkspaceIds` is an array only because a JSON
// blob had no better option; it's now derived on read (listSyncDisabledIds) and
// ignored on write, like workspace.origin_url.
export function setWorkspaceSyncDisabled(workspaceId: string, disabled: boolean) {
  getDb().update(workspace)
    .set({ syncDisabled: disabled ? 1 : 0 })
    .where(eq(workspace.id, workspaceId))
    .run();
}

export function listSyncDisabledIds(): string[] {
  return getDb().select({ id: workspace.id }).from(workspace)
    .where(eq(workspace.syncDisabled, 1)).all().map((r: any) => r.id);
}

export function findWorkspaceIdByPath(workspacePath: string): string | null {
  const rows = getDb().select({ id: workspace.id }).from(workspace)
    .where(eq(workspace.path, workspacePath)).all() as any[];
  return rows[0]?.id ?? null;
}

// Write-through cache for `git remote get-url origin`, called by workspaceStatus
// as it shells out. Matches on path (unique per workspace) and no-ops when the
// folder isn't a known workspace — the sync setup flows call workspaceStatus for
// folders that aren't in the list yet.
export function cacheWorkspaceOrigin(workspacePath: string, originUrl: string | null, now: number) {
  getDb().update(workspace)
    .set({ originUrl, checkedAt: now })
    .where(eq(workspace.path, workspacePath))
    .run();
}

// Trim a message body to a ~120-char window around the first query term.
function snippetOf(content: string | null, query: string): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const term = query.split(/\s+/)[0]?.toLowerCase() ?? '';
  const idx = term ? text.toLowerCase().indexOf(term) : -1;
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + 120) + (text.length > start + 120 ? '…' : '');
}
