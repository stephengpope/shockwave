CREATE TABLE `agent_secret` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text,
	`kind` text,
	`oauth_provider` text,
	`oauth_client_id` text,
	`oauth_auth_url` text,
	`oauth_token_url` text,
	`oauth_scopes` text,
	`oauth_expires_at` integer,
	`oauth_status` text,
	`oauth_account_email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_value` (
	`owner` text NOT NULL,
	`field` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` blob NOT NULL,
	`tag` blob NOT NULL,
	`key_version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`owner`, `field`)
);
--> statement-breakpoint
-- ── Carry data across from the 0003-era `setting` table ─────────────────────
--
-- Only machines that already ran a 0003/0004 build have these rows. A fresh
-- install has an empty `setting` table here, and an upgrade from settings.json
-- imports at RUNTIME (after migrations) straight into the new shape — so every
-- statement below is a harmless no-op in those cases.
--
-- Ciphertext/iv/tag are moved VERBATIM. Nothing is decrypted or re-encrypted,
-- so the master key is not needed and no secret can be lost in transit.
--
-- Agent-secret keys look like `agentSecrets.<name>.<field>`. The name segment is
-- percent-encoded by encName(); SQL can't decode it, but the encoding only
-- escapes characters that can't appear in a plain identifier, so any name that
-- round-trips unchanged (all realistic ones) migrates correctly. A name needing
-- escapes would arrive percent-encoded and can be renamed in the UI.

-- 1. Entity rows for each agent secret, keyed off its `.name` row.
INSERT OR IGNORE INTO `agent_secret` (`name`, `created_at`, `updated_at`)
SELECT s.value, 0, 0
  FROM `setting` s
 WHERE s.key LIKE 'agentSecrets.%.name'
   AND s.key NOT LIKE 'agentSecrets.%.%.%';
--> statement-breakpoint
-- 2. Scalar fields onto those rows.
UPDATE `agent_secret` SET
  `description` = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.description'),
  `kind`        = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.kind'),
  `created_at`  = COALESCE((SELECT CAST(s.value AS INTEGER) FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.createdAt'), 0),
  `updated_at`  = COALESCE((SELECT CAST(s.value AS INTEGER) FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.updatedAt'), 0),
  `oauth_provider`      = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.provider'),
  `oauth_client_id`     = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.clientId'),
  `oauth_auth_url`      = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.authUrl'),
  `oauth_token_url`     = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.tokenUrl'),
  `oauth_scopes`        = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.scopes'),
  `oauth_expires_at`    = (SELECT CAST(s.value AS INTEGER) FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.expiresAt'),
  `oauth_status`        = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.status'),
  `oauth_account_email` = (SELECT s.value FROM `setting` s WHERE s.key = 'agentSecrets.'||`agent_secret`.`name`||'.oauth.accountEmail');
--> statement-breakpoint
-- 3. Agent-secret credentials → secret_value, owned by the secret's name.
INSERT OR IGNORE INTO `secret_value` (`owner`, `field`, `ciphertext`, `iv`, `tag`, `key_version`, `updated_at`)
SELECT a.`name`,
       substr(s.key, length('agentSecrets.'||a.`name`||'.') + 1),
       s.value, s.iv, s.tag, 1, s.updated_at
  FROM `setting` s
  JOIN `agent_secret` a ON s.key LIKE 'agentSecrets.'||a.`name`||'.%'
 WHERE s.secret = 1 AND s.iv IS NOT NULL AND s.tag IS NOT NULL;
--> statement-breakpoint
-- 4. Standalone credentials → secret_value, owned by 'settings'. The key IS the
--    field (sync.pat, transcription.apiKey, codingAgent.providerKeys.<slug>).
INSERT OR IGNORE INTO `secret_value` (`owner`, `field`, `ciphertext`, `iv`, `tag`, `key_version`, `updated_at`)
SELECT 'settings', s.key, s.value, s.iv, s.tag, 1, s.updated_at
  FROM `setting` s
 WHERE s.secret = 1 AND s.iv IS NOT NULL AND s.tag IS NOT NULL
   AND s.key NOT LIKE 'agentSecrets.%';
--> statement-breakpoint
-- 5. Rebuild `setting` without secret/iv/tag, dropping every migrated row.
--    SQLite can't drop columns in place on older versions — create/copy/swap is
--    the portable form, and it's what drizzle-kit would emit anyway.
CREATE TABLE `__new_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_setting` (`key`, `value`, `type`, `updated_at`)
SELECT `key`, `value`, `type`, `updated_at`
  FROM `setting`
 WHERE `secret` = 0
   AND `key` NOT LIKE 'agentSecrets.%';
--> statement-breakpoint
DROP TABLE `setting`;
--> statement-breakpoint
ALTER TABLE `__new_setting` RENAME TO `setting`;
