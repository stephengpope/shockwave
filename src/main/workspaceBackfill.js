// Fills in `workspace.origin_url` for pre-0007 rows that never had it cached,
// so migration 0007 can KEEP those workspaces instead of dropping them.
//
// Why this exists as a JS step running BEFORE migrations: 0007 has to resolve
// each workspace's GitHub repo, and the only record of it is the remote in that
// folder's `.git/config`. SQL can't shell out. The old `origin_url` column was a
// write-through cache filled opportunistically by the settings UI, so it's
// populated for some workspaces and empty for others — and an empty one doesn't
// mean "no repo", it means "nobody looked".
//
// Resolving here, into a column 0007 already reads, is what lets the repo
// columns be NOT NULL from day one. The alternative — a backfill running AFTER
// migrations — forces them nullable until some later release, which is the
// deferral the whole change exists to remove.
//
// Runs once and no-ops forever after: the columns it reads are gone post-0007.

import { execFileSync } from 'node:child_process';

/** Is this DB still on the pre-0007 workspace shape? */
function isPreRepoSchema(sqlite) {
  const cols = sqlite.prepare('PRAGMA table_info(workspace)').all().map((c) => c.name);
  // `path` + `origin_url` together only ever coexisted on the old shape.
  return cols.includes('path') && cols.includes('origin_url');
}

/** `git -C <dir> remote get-url origin`, or null for anything that isn't one. */
function originOf(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    // No folder, no `.git`, no origin, or no git on PATH — all mean the same
    // thing here: nothing to resolve. 0007 drops these.
    return null;
  }
}

/**
 * Stamp this machine's hostname onto local rows the migration wrote with an
 * empty one.
 *
 * 0007 carries each workspace's path across but has no way to know the
 * hostname — SQL can't call `os.hostname()`. An empty machine therefore means
 * "written by a previous install of this app, on this box", which is the only
 * way such a row can come to exist, so claiming it here is safe and idempotent.
 */
export function claimLocalRowsForThisMachine(sqlite, machine) {
  try {
    const has = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_local'").get();
    if (!has) return;
    const res = sqlite.prepare("UPDATE workspace_local SET machine = ? WHERE machine = ''").run(machine);
    if (res.changes) console.log(`[migrate] claimed ${res.changes} workspace(s) for ${machine}`);
  } catch (err) {
    console.warn('[migrate] could not claim local workspace rows:', err?.message ?? err);
  }
}

export function backfillWorkspaceOrigins(sqlite) {
  let table;
  try {
    table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'").get();
  } catch {
    return;
  }
  if (!table || !isPreRepoSchema(sqlite)) return;

  const rows = sqlite
    .prepare("SELECT id, path FROM workspace WHERE origin_url IS NULL OR origin_url = ''")
    .all();
  if (!rows.length) return;

  const update = sqlite.prepare('UPDATE workspace SET origin_url = ? WHERE id = ?');
  let filled = 0;
  for (const row of rows) {
    if (!row.path) continue;
    const origin = originOf(row.path);
    if (!origin) continue;
    update.run(origin, row.id);
    filled++;
  }
  if (filled) console.log(`[migrate] resolved ${filled} workspace remote(s) before 0007`);
}
