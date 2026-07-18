-- `source_id` + `machine` are new; existing `source` rows get backfilled.
--
-- Deliberately ADDITIVE ONLY. The tempting version rebuilds chat_session to put
-- a `NOT NULL DEFAULT 'desktop'` on `source` — but `message` has an ON DELETE
-- CASCADE foreign key to it, and drizzle runs migrations inside a transaction
-- where `PRAGMA foreign_keys` is a no-op. The DROP TABLE in that rebuild would
-- cascade every message away. A column default isn't worth risking the
-- transcripts; `upsertSession` always writes an explicit source instead.
ALTER TABLE `chat_session` ADD `source_id` text;
--> statement-breakpoint
ALTER TABLE `chat_session` ADD `machine` text;
--> statement-breakpoint
-- Pre-existing interactive chats predate the value; they were all desktop.
UPDATE `chat_session` SET `source` = 'desktop' WHERE `source` IS NULL;
