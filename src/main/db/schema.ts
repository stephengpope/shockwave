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

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

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
  // How this chat was started: null (interactive) or 'cron' (a scheduled or
  // manual cron run). Lets the picker badge cron runs and skips auto-titling in
  // favor of the job name.
  source: text('source'),
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
