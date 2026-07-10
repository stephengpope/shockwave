// Shared @parcel/watcher event mapping.
//
// @parcel/watcher hands the callback a *batch* of `{type: 'create'|'update'|
// 'delete', path}` events with no stat and no file/directory discriminator, and
// it represents renames — including folder renames — as delete+create pairs.
// This module turns that stream into rename-correlator calls + coalescing-sink
// updates. main.ts wires it to the real watcher and the real pending/tree
// state; the correlator tests wire it to a tmp dir. BOTH import this module so
// main and the tests exercise identical logic — same parity discipline as
// `linkParser.js`. Keep it pure: reads only, no writes.
//
// Behaviors that differ from the old chokidar path and are handled here:
//   - Atomic save (temp-write + rename-over-existing) arrives as `create` of an
//     already-known destination path → treated as a modification, not a new
//     file (see correlator.isKnown).
//   - Folder rename/move arrives as delete(oldDir) + create(newDir) with no
//     per-file events → the delete is expanded to unlinks of every known .md
//     under it, and the create is expanded by walking the new dir; paired by
//     inode, these surface as per-file renames.
//   - Deletes in a batch are dispatched before creates so every unlink is
//     buffered before a matching add is correlated (parcel doesn't guarantee
//     intra-batch order).

import path from 'node:path';

export function createWatcherDispatch({
  correlator,
  isMdFile,
  isDrawingFile,
  statPath,      // async (p) => Stats({bigint:true}) | null
  hashFile,      // async (p) => hex hash | null
  walkMarkdown,  // async (dir) => [absolute .md paths under dir]
  isIgnored,     // (p) => boolean
  getPending,    // (p) => 'add' | 'change' | 'unlink' | undefined
  setPending,    // (p, type) => void   — also schedules a flush
  markTreeOnly,  // () => void          — also schedules a flush
}) {
  function pendDrawingUpsert(kind, p) {
    if (kind === 'add') setPending(p, getPending(p) === 'unlink' ? 'change' : 'add');
    else setPending(p, getPending(p) === 'add' ? 'add' : 'change');
  }

  async function upsert(kind, p) {
    if (isDrawingFile(p)) { pendDrawingUpsert(kind, p); return; }
    const st = await statPath(p);
    if (st && st.isDirectory()) {
      // A folder appeared (mkdir / move / rename destination). parcel emits no
      // per-file events for its contents, so enumerate .md inside and feed each
      // through — paired by inode against buffered unlinks from a folder
      // rename, they surface as per-file renames.
      const nested = await walkMarkdown(p);
      for (const np of nested) await upsert('add', np);
      markTreeOnly();
      return;
    }
    if (!isMdFile(p)) { markTreeOnly(); return; }
    if (!st) { markTreeOnly(); return; }   // vanished between event and stat
    const ino = st.ino.toString();
    const hash = await hashFile(p);
    if (kind === 'add' && !correlator.isKnown(p)) {
      // Genuinely new file, or the destination half of a rename (the correlator
      // pairs it with a buffered unlink by inode/hash).
      correlator.onPathAppeared(p, ino, hash);
    } else {
      // update, or a create of a known path (parcel's atomic-save shape). Both
      // are modifications: refresh identity so a future unlink can correlate.
      correlator.onPathSeen(p, ino, hash);
      setPending(p, getPending(p) === 'add' ? 'add' : 'change');
    }
  }

  function del(p) {
    if (isDrawingFile(p)) { setPending(p, 'unlink'); return; }
    if (isMdFile(p)) { correlator.onPathGone(p); return; }
    // Non-.md file, OR a deleted directory (parcel can't tell them apart and a
    // dir path has no .md extension). If we know .md files under it, it was a
    // folder → emit their unlinks (which pair by inode with the new dir's adds).
    const under = correlator.knownUnder(p + path.sep);
    for (const kp of under) correlator.onPathGone(kp);
    markTreeOnly();
  }

  // Deletes first, then creates/updates — see header note on batch ordering.
  async function handleBatch(events) {
    for (const e of events) {
      if (e.type === 'delete' && !isIgnored(e.path)) del(e.path);
    }
    for (const e of events) {
      if (e.type !== 'delete' && !isIgnored(e.path)) {
        await upsert(e.type === 'create' ? 'add' : 'change', e.path);
      }
    }
  }

  return { handleBatch };
}
