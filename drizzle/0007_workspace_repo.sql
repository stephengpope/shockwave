-- A workspace IS a GitHub repo, and the two facts about it split by scope:
--
--   workspace         which repo — the same answer on any machine
--   workspace_local   per (workspace, machine): where the clone is, whether
--                     it's open, whether it syncs
--
-- The remote becomes NOT NULL columns instead of a fact discovered by shelling
-- out to `.git/config` on every sync decision, which retires the
-- `origin_url`/`checked_at` write-through cache along with it. And
-- `activeWorkspaceId` stops being a `setting` row — a foreign key hiding in a
-- key-value store, free to name a workspace that no longer exists — and becomes
-- a column that dies with its row.
--
-- Existing rows are DROPPED, not migrated. Backfilling them would mean reading
-- each workspace's git remote one row at a time — something SQL can't do — so a
-- backfill has to be JS running after migrations, which in turn means the repo
-- columns can't be NOT NULL until a *later* release. That deferral is the whole
-- thing this change exists to remove: it would leave repo-less workspaces legal
-- in the schema indefinitely. Wiping instead keeps the constraint real from day
-- one. The cost is that users re-add their workspaces once.
--
-- Nothing on disk is touched. Removing a workspace has never deleted files, and
-- this is no different — the folders and their `.git/` are all still there, so
-- re-adding is picking the same repo again.
--
-- Nothing cascades either: `chat_session.workspace` and `cron_state.workspace`
-- are absolute PATHS with no foreign key to this table, so chats and cron timing
-- survive the wipe and re-attach on their own when the same folder is re-added.
DROP INDEX IF EXISTS `idx_workspace_sort`;
--> statement-breakpoint
DROP TABLE `workspace`;
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`sort_order` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_sort` ON `workspace` (`sort_order`);
--> statement-breakpoint
CREATE INDEX `idx_workspace_repo` ON `workspace` (`repo_owner`,`repo_name`);
--> statement-breakpoint
CREATE TABLE `workspace_local` (
	`workspace_id` text NOT NULL REFERENCES `workspace`(`id`) ON DELETE CASCADE,
	`machine` text NOT NULL,
	`path` text NOT NULL,
	`active` integer,
	`sync_disabled` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`workspace_id`, `machine`)
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_local_path` ON `workspace_local` (`machine`,`path`);
--> statement-breakpoint
-- The single-active rule, enforced structurally and PER MACHINE. A partial
-- unique index over `active = 1` works because SQLite treats NULLs as distinct:
-- any number of rows may be NULL (not active), but a second active row on the
-- same machine is a constraint violation rather than a silently split state.
CREATE UNIQUE INDEX `idx_workspace_local_active` ON `workspace_local` (`machine`,`active`) WHERE `active` = 1;
--> statement-breakpoint
-- Superseded by workspace_local.active. Left behind it would resolve to nothing
-- on launch and strand the app on a workspace it can't load.
DELETE FROM `setting` WHERE `key` = 'activeWorkspaceId';
