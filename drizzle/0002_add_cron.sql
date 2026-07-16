ALTER TABLE `chat_session` ADD `source` text;--> statement-breakpoint
CREATE TABLE `cron_state` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`job_name` text NOT NULL,
	`schedule` text NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_error` text,
	`last_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cron_state_next_run` ON `cron_state` (`next_run_at`);
