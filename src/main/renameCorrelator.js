// Rename correlator.
//
// The file watcher sees a rename as two unrelated events:
//   unlink(oldPath) + add(newPath)
// This module pairs them deterministically using inode (primary) and content
// hash (fallback for filesystems where ino is unreliable, e.g. FAT/SMB).
//
// Contract:
//   - `onPathSeen(path, ino, hash)` must be called whenever the index learns
//     about a path (initial scan, add events, change events). This populates
//     the path -> {ino, hash} map so unlink can find the prior identity.
//   - `onPathGone(path)` must be called when an unlink is observed. The
//     correlator will look up the path's prior {ino, hash}, buffer it, and
//     either pair it with a later add (-> emit 'rename') or, after the grace
//     window, emit 'unlink'.
//   - `onPathAppeared(path, ino, hash)` is called when an add is observed.
//     The correlator looks for a buffered unlink matching ino (or hash) and,
//     if found, emits 'rename'; otherwise emits 'add'.
//
// The caller provides `emit(event)` to receive normalized events:
//   { type: 'rename', oldPath, newPath }
//   { type: 'add',    path }
//   { type: 'unlink', path }
//
// `change` events are NOT routed through here — they're independent of
// rename detection (see scratch/02-atomic-save.js for why).

export function createRenameCorrelator({ emit, graceMs = 800, now = Date.now }) {
  // path -> { ino, hash } : known identity for every path the index has seen.
  const identityByPath = new Map();

  // Pending unlinks awaiting a possible rename pair.
  // Keyed by oldPath (unique). Each entry also indexed in lookup tables below.
  // entry: { oldPath, ino, hash, expiresAt, timer }
  const pendingByPath = new Map();
  const pendingByIno = new Map();   // inoString -> oldPath
  const pendingByHash = new Map();  // hash      -> Set<oldPath>

  function indexAdd(entry) {
    pendingByPath.set(entry.oldPath, entry);
    if (entry.ino) pendingByIno.set(entry.ino, entry.oldPath);
    if (entry.hash) {
      let set = pendingByHash.get(entry.hash);
      if (!set) { set = new Set(); pendingByHash.set(entry.hash, set); }
      set.add(entry.oldPath);
    }
  }

  function indexRemove(entry) {
    pendingByPath.delete(entry.oldPath);
    if (entry.ino && pendingByIno.get(entry.ino) === entry.oldPath) {
      pendingByIno.delete(entry.ino);
    }
    if (entry.hash) {
      const set = pendingByHash.get(entry.hash);
      if (set) {
        set.delete(entry.oldPath);
        if (set.size === 0) pendingByHash.delete(entry.hash);
      }
    }
  }

  function commitDelete(oldPath) {
    const entry = pendingByPath.get(oldPath);
    if (!entry) return;
    indexRemove(entry);
    emit({ type: 'unlink', path: oldPath });
  }

  return {
    onPathSeen(path, ino, hash) {
      identityByPath.set(path, {
        ino: ino != null ? String(ino) : null,
        hash: hash ?? null,
      });
    },

    // Whether we already hold an identity for this path. Used to tell a
    // brand-new file from an overwrite: @parcel/watcher reports an atomic save
    // (write-temp + rename-over-existing) as a `create` of the destination,
    // which — for a path we already know — is a modification, not a new file.
    isKnown(path) {
      return identityByPath.has(path);
    },

    // Every known path beginning with `prefix`. Used to expand a directory
    // delete into its nested files: @parcel/watcher reports a folder rename as
    // a single delete(oldDir) + create(newDir), with no per-file events, so we
    // synthesize the unlinks (which then pair by inode against the new dir's
    // adds and surface as per-file renames).
    knownUnder(prefix) {
      const out = [];
      for (const p of identityByPath.keys()) {
        if (p.startsWith(prefix)) out.push(p);
      }
      return out;
    },

    onPathGone(path) {
      const id = identityByPath.get(path);
      identityByPath.delete(path);
      if (!id || (!id.ino && !id.hash)) {
        // We never learned this path's identity — can't correlate.
        emit({ type: 'unlink', path });
        return;
      }
      const entry = {
        oldPath: path,
        ino: id.ino,
        hash: id.hash,
        expiresAt: now() + graceMs,
        timer: null,
      };
      entry.timer = setTimeout(() => commitDelete(path), graceMs);
      indexAdd(entry);
    },

    onPathAppeared(path, ino, hash) {
      const inoKey = ino != null ? String(ino) : null;

      // 1) Try inode match.
      if (inoKey && pendingByIno.has(inoKey)) {
        const oldPath = pendingByIno.get(inoKey);
        const entry = pendingByPath.get(oldPath);
        clearTimeout(entry.timer);
        indexRemove(entry);
        identityByPath.set(path, { ino: inoKey, hash: hash ?? entry.hash });
        emit({ type: 'rename', oldPath, newPath: path });
        return;
      }

      // 2) Inode missing or no match -> try hash match (oldest pending wins).
      if (hash && pendingByHash.has(hash)) {
        const candidatePaths = pendingByHash.get(hash);
        let bestPath = null;
        let bestExpires = Infinity;
        for (const op of candidatePaths) {
          const e = pendingByPath.get(op);
          if (!e) continue;
          if (e.expiresAt < bestExpires) {
            bestExpires = e.expiresAt;
            bestPath = op;
          }
        }
        if (bestPath) {
          const entry = pendingByPath.get(bestPath);
          clearTimeout(entry.timer);
          indexRemove(entry);
          identityByPath.set(path, { ino: inoKey, hash });
          emit({ type: 'rename', oldPath: bestPath, newPath: path });
          return;
        }
      }

      // 3) No match -> real add.
      identityByPath.set(path, { ino: inoKey, hash: hash ?? null });
      emit({ type: 'add', path });
    },

    // For tests/debugging.
    _state() {
      return {
        identityByPath: new Map(identityByPath),
        pendingByPath: new Map(pendingByPath),
        pendingByIno: new Map(pendingByIno),
        pendingByHash: new Map([...pendingByHash].map(([k, v]) => [k, new Set(v)])),
      };
    },
  };
}
