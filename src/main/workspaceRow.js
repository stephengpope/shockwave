// The renderer-facing shape of a workspace (see `WorkspaceEntry` in
// src/shared/settings.ts).
//
// Plain `.js` with no electron import, so `node --test` can pin the one thing
// here that's easy to get silently backwards: the sync flag's polarity.
//
// Its own module rather than living in `workspaceFolder.js` — that file answers
// "what IS this folder on disk", this one shapes a database row for the
// renderer. They were together only because the tests could reach it there.

/**
 * The column is `sync_disabled` (0 / absent = syncing, because a zero row should
 * mean normal behaviour) while everything above this sees `syncEnabled`. That
 * negation happens exactly ONCE, here — it used to leak into the renderer and
 * get negated three more times inside the single switch that renders it.
 */
export function projectWorkspaceRow(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path ?? null,
    repo: `${row.repoOwner}/${row.repoName}`,
    syncEnabled: !row.syncDisabled,
  };
}
