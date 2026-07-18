CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`sort_order` real NOT NULL,
	`origin_url` text,
	`checked_at` integer,
	`sync_disabled` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_sort` ON `workspace` (`sort_order`);
--> statement-breakpoint
-- Carry across the `workspaces` JSON row written by the 0003-era settings store.
-- json_each preserves array position in `key`, so sort_order reproduces exactly
-- the order the user already sees (0-based → 1.0, 2.0, …).
--
-- No-op on installs that never held that row: a fresh install has no settings
-- rows at this point, and an upgrade from settings.json imports at RUNTIME
-- (after migrations), where writeSettings routes `workspaces` straight to this
-- table. This statement only matters for machines already running a 0003 build.
INSERT OR IGNORE INTO `workspace` (`id`, `name`, `path`, `sort_order`)
SELECT json_extract(e.value, '$.id'),
       json_extract(e.value, '$.name'),
       json_extract(e.value, '$.path'),
       e.key + 1.0
  FROM `setting` s, json_each(s.value) e
 WHERE s.key = 'workspaces'
   AND json_extract(e.value, '$.id') IS NOT NULL;
--> statement-breakpoint
-- `sync.disabledWorkspaceIds` was an array of workspace ids in the settings
-- blob. Fold it into the owning row so it can't outlive the workspace.
UPDATE `workspace` SET `sync_disabled` = 1
 WHERE `id` IN (
   SELECT json_each.value FROM `setting`, json_each(`setting`.`value`)
    WHERE `setting`.`key` = 'sync.disabledWorkspaceIds'
 );
--> statement-breakpoint
DELETE FROM `setting` WHERE `key` IN ('workspaces', 'sync.disabledWorkspaceIds');
