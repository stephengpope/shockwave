import { defineConfig } from 'drizzle-kit';

// Chat-history store. Schema lives in the main process (renderer reaches it only
// via window.api.*). Migrations are generated here and shipped via electron-builder
// `extraResources` (see package.json `build.extraResources`), then applied at app
// launch with drizzle's better-sqlite3 migrator — see src/main/db/index.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './drizzle',
});
