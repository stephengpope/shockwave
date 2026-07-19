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
-- EXISTING WORKSPACES ARE CARRIED OVER, not wiped. `origin_url` was only a
-- best-effort cache, so `backfillWorkspaceOrigins` (a JS pass that runs just
-- BEFORE this migration — see src/main/workspaceBackfill.js) resolves the real
-- remote for any row that never had one cached. By the time this runs, every
-- workspace that has a GitHub remote on disk has it recorded here.
--
-- What's dropped is only what can't exist under the new model: a workspace
-- whose folder has no GitHub remote at all. There's nothing to migrate it to —
-- the repo columns are NOT NULL because a workspace without a repo is the
-- state this whole change removes.
--
-- Nothing on disk is touched. Removing a workspace has never deleted files, so
-- a dropped row leaves its folder exactly where it was.
--
-- Nothing cascades either: `chat_session.workspace` and `cron_state.workspace`
-- are absolute PATHS with no foreign key to this table, so chats and cron timing
-- survive and re-attach on their own.
CREATE TABLE `workspace_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`sort_order` real NOT NULL
);
--> statement-breakpoint
-- Parse `owner/repo` out of the remote URL. Handles both forms git stores:
--   https://github.com/owner/repo(.git)
--   git@github.com:owner/repo(.git)
-- by taking everything after the host separator, then stripping a trailing
-- `.git`. A repo name may legitimately contain dots (`kontentengine.io`), so
-- only that exact suffix is removed. Rows whose URL doesn't yield exactly one
-- `owner/repo` pair fall out of the WHERE and are dropped.
INSERT INTO `workspace_new` (`id`, `name`, `repo_owner`, `repo_name`, `default_branch`, `sort_order`)
SELECT id, name,
       substr(slug, 1, instr(slug, '/') - 1),
       substr(slug, instr(slug, '/') + 1),
       'main',
       sort_order
  FROM (
    SELECT id, name, sort_order,
           CASE WHEN lower(substr(tail, -4)) = '.git'
                THEN substr(tail, 1, length(tail) - 4)
                ELSE tail END AS slug
      FROM (
        SELECT id, name, sort_order,
               CASE
                 WHEN instr(origin_url, 'github.com/') > 0
                   THEN substr(origin_url, instr(origin_url, 'github.com/') + 11)
                 WHEN instr(origin_url, 'github.com:') > 0
                   THEN substr(origin_url, instr(origin_url, 'github.com:') + 11)
                 ELSE NULL
               END AS tail
          FROM `workspace`
         WHERE origin_url IS NOT NULL AND origin_url <> ''
      )
     WHERE tail IS NOT NULL AND tail <> ''
  )
 WHERE instr(slug, '/') > 1
   AND length(substr(slug, instr(slug, '/') + 1)) > 0
   -- exactly one separator: a trailing path segment means this isn't a repo URL
   AND instr(substr(slug, instr(slug, '/') + 1), '/') = 0;
--> statement-breakpoint
-- Stash the local half before the old table goes. `workspace_local` can't be
-- created yet: its foreign key has to name `workspace`, and that name still
-- belongs to the old table until the rename below. Creating it first and
-- pointing it at `workspace_new` looks fine and silently breaks — SQLite
-- rewrites the reference to follow the rename, leaving the FK aimed at a table
-- that no longer exists, so ON DELETE CASCADE never fires.
CREATE TABLE `workspace_local_stage` (
	`workspace_id` text NOT NULL,
	`path` text NOT NULL,
	`active` integer,
	`sync_disabled` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `workspace_local_stage` (`workspace_id`, `path`, `active`, `sync_disabled`)
SELECT w.id, old.path,
       CASE WHEN s.value = w.id THEN 1 ELSE NULL END,
       old.sync_disabled
  FROM `workspace_new` w
  JOIN `workspace` old ON old.id = w.id
  LEFT JOIN `setting` s ON s.key = 'activeWorkspaceId';
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_workspace_sort`;
--> statement-breakpoint
DROP TABLE `workspace`;
--> statement-breakpoint
ALTER TABLE `workspace_new` RENAME TO `workspace`;
--> statement-breakpoint
-- Now that `workspace` is the real name, the foreign key can point at it.
CREATE TABLE `workspace_local` (
	`workspace_id` text NOT NULL REFERENCES `workspace`(`id`) ON DELETE CASCADE,
	`machine` text NOT NULL,
	`path` text NOT NULL,
	`active` integer,
	`sync_disabled` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`workspace_id`, `machine`)
);
--> statement-breakpoint
-- `os.hostname()` isn't available to SQL, so the machine is left empty and
-- stamped by `claimLocalRowsForThisMachine` on first run — an empty machine can
-- only mean "written by a prior install of this app, on this box".
INSERT INTO `workspace_local` (`workspace_id`, `machine`, `path`, `active`, `sync_disabled`)
SELECT `workspace_id`, '', `path`, `active`, `sync_disabled` FROM `workspace_local_stage`;
--> statement-breakpoint
DROP TABLE `workspace_local_stage`;
--> statement-breakpoint
CREATE INDEX `idx_workspace_sort` ON `workspace` (`sort_order`);
--> statement-breakpoint
CREATE INDEX `idx_workspace_repo` ON `workspace` (`repo_owner`,`repo_name`);
--> statement-breakpoint
CREATE INDEX `idx_workspace_local_path` ON `workspace_local` (`machine`,`path`);
--> statement-breakpoint
-- The single-active rule, enforced structurally and PER MACHINE. A partial
-- unique index over `active = 1` works because SQLite treats NULLs as distinct:
-- any number of rows may be NULL (not active), but a second active row on the
-- same machine is a constraint violation rather than a silently split state.
CREATE UNIQUE INDEX `idx_workspace_local_active` ON `workspace_local` (`machine`,`active`) WHERE `active` = 1;
--> statement-breakpoint
-- Superseded by workspace_local.active.
DELETE FROM `setting` WHERE `key` = 'activeWorkspaceId';
