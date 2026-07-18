// PURE patch-diffing for settings saves. Plain `.js` (no React, no window) so
// `node --test` can exercise it directly — same split as linkResolver.js.
//
// Settings are stored one row per leaf key. Per-field setters necessarily build
// whole sub-objects (`{...current.sync, pullIntervalSeconds}`), which means they
// read every sibling — including credentials — out of the local cache and hand
// them back to the store. Sending that verbatim republishes the cached copy of
// `sync.pat` on every slider nudge: needless re-encryption at best, and a
// stale-cache overwrite at worst.
//
// Diffing against the cache means an untouched field compares equal and is never
// sent. The cache stops being a SOURCE of writes — only a field the user
// actually edited leaves the renderer.

export function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Collections reconcile as a whole in the store (membership is the point, and
// they route to entity tables), so callers pass them through undiffed.
export const COLLECTION_KEYS = ['workspaces', 'agentSecrets'];

// Top-level keys main owns. The renderer holds hydrated copies (they arrive on
// read) but must never author them.
export const MAIN_OWNED_KEYS = ['windowBounds', 'cron'];

// Open-ended MAPS whose keys can be added AND removed. They must travel whole so
// the store can reconcile removals: a per-leaf diff only walks what's present,
// so a deleted entry is simply never mentioned and its row survives — which for
// providerKeys meant a deleted API key stayed encrypted in the DB and
// reappeared on the next read.
//
// Everything else in settings has fixed keys (appearance, sync, cron, …) or
// reconciles as a collection (workspaces, agentSecrets).
export const MAP_KEYS = ['codingAgent.providerKeys'];

/**
 * Walks `next` against `prev`, writing dotted leaf keys that differ into `out`.
 * Arrays and scalars are leaves (compared structurally); plain objects recurse.
 */
export function changedLeaves(prefix, next, prev, out) {
  // Maps travel whole (see MAP_KEYS) — compared structurally so an unchanged one
  // still costs nothing, but sent intact so removals are visible to the store.
  if (MAP_KEYS.includes(prefix)) {
    if (JSON.stringify(next) !== JSON.stringify(prev)) out[prefix] = next;
    return;
  }
  if (!isPlainObj(next)) {
    if (JSON.stringify(next) !== JSON.stringify(prev)) out[prefix] = next;
    return;
  }
  for (const [k, v] of Object.entries(next)) {
    changedLeaves(prefix ? `${prefix}.${k}` : k, v, isPlainObj(prev) ? prev[k] : undefined, out);
  }
}

/**
 * Full patch → the minimal set of dotted leaf keys to write.
 * Drops main-owned keys, passes collections through whole, diffs the rest.
 */
export function buildPatch(next, prev) {
  const out = {};
  for (const [k, v] of Object.entries(next ?? {})) {
    if (MAIN_OWNED_KEYS.includes(k)) continue;
    if (COLLECTION_KEYS.includes(k)) { out[k] = v; continue; }
    changedLeaves(k, v, (prev ?? {})[k], out);
  }
  return out;
}
