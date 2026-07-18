CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`secret` integer DEFAULT 0 NOT NULL,
	`iv` blob,
	`tag` blob,
	`updated_at` integer NOT NULL,
	CHECK (`secret` = 0 OR (`iv` IS NOT NULL AND `tag` IS NOT NULL))
);
