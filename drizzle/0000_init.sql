CREATE TABLE `chat_session` (
	`session_id` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`jsonl_path` text NOT NULL,
	`title` text,
	`system_prompt` text,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_session_ws_updated` ON `chat_session` (`workspace`,`updated_at`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`reasoning` text,
	`tool_calls` text,
	`tool_call_id` text,
	`tool_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_session`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_session_seq` ON `message` (`session_id`,`seq`);--> statement-breakpoint
-- Full-text search over message content (hand-added; drizzle can't express FTS5).
-- rowid is kept equal to message.id by the triggers below so search results map
-- straight back to message rows. content is coalesced to '' so NULL-content rows
-- (e.g. a tool-call-only assistant row) don't break the triggers.
CREATE VIRTUAL TABLE `message_fts` USING fts5(content);--> statement-breakpoint
CREATE TRIGGER `message_fts_ai` AFTER INSERT ON `message` BEGIN
  INSERT INTO `message_fts`(rowid, content) VALUES (new.id, coalesce(new.content, ''));
END;--> statement-breakpoint
CREATE TRIGGER `message_fts_ad` AFTER DELETE ON `message` BEGIN
  DELETE FROM `message_fts` WHERE rowid = old.id;
END;--> statement-breakpoint
CREATE TRIGGER `message_fts_au` AFTER UPDATE ON `message` BEGIN
  DELETE FROM `message_fts` WHERE rowid = old.id;
  INSERT INTO `message_fts`(rowid, content) VALUES (new.id, coalesce(new.content, ''));
END;