import { useState, useCallback } from 'react';
import { useSyncRef } from './useSyncRef';
import type { TreeNode } from '../../shared/api';

// Bookmarks are identified by **basename**, not path — only `.md` files can be
// bookmarked, and the link index already guarantees `.md` basenames are unique
// workspace-wide. Tracking the name means moving a file between folders needs
// zero bookmark bookkeeping (the basename is unchanged); only a rename (which
// changes the basename) has to be re-keyed, and that rides along with the
// existing wiki-link rename rewrite. The location is resolved on click via the
// link index's basename→path map (`pageIndex`).
//
// In memory: a Set of lowercased basenames (the same key shape `pageIndex`
// uses). On disk: `<workspace>/.shockwave/bookmarks.json` as
// `{ version: 1, names: ["recipes", ...] }`. The `.shockwave` dotfile segment
// is ignored by the watcher, so our writes don't echo back.

// Basename without folder or `.md`, lowercased — the canonical bookmark key
// and the key `pageIndex` is keyed by.
export function bookmarkKey(path: string): string {
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return base.replace(/\.md$/i, '').toLowerCase();
}

// Collect every bookmarked file from the tree as a flat list (no folders).
// Bookmark filter mode renders bookmarks as a single sorted list rather than
// preserving the folder hierarchy.
export function flattenBookmarkedFiles(nodes: TreeNode[], bookmarkedKeys: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.children) walk(n.children);
      else if (!n.id.endsWith('/') && bookmarkedKeys.has(bookmarkKey(n.id))) out.push(n);
    }
  };
  walk(nodes);
  return out;
}

interface UseBookmarksOpts {
  workspacePath: string | null;
  showError: (msg: string) => void;
}

export function useBookmarks({ workspacePath, showError }: UseBookmarksOpts) {
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const bookmarksRef = useSyncRef(bookmarks);

  // Clear in-memory state (called at the start of a workspace switch). The
  // bookmark-filter view mode is NOT reset here — it's persisted globally in
  // useSettings so the view survives workspace switches and restarts.
  const resetBookmarks = useCallback(() => {
    setBookmarks(new Set());
    bookmarksRef.current = new Set();
  }, [bookmarksRef]);

  const writeNames = useCallback((names: Set<string>) => {
    if (!workspacePath) return Promise.resolve();
    return window.api.bookmarks.write(workspacePath, Array.from(names));
  }, [workspacePath]);

  // Seed from disk: keep only names that still resolve to a file in the
  // workspace (`resolvableKeys`), and rewrite the file if anything was pruned.
  const seedBookmarks = useCallback((names: string[], resolvableKeys: Set<string>) => {
    const next = new Set<string>();
    let needsRewrite = false;
    for (const raw of names) {
      const key = raw.toLowerCase();
      if (resolvableKeys.has(key)) next.add(key);
      else needsRewrite = true;
    }
    setBookmarks(next);
    bookmarksRef.current = next;
    if (needsRewrite) writeNames(next).catch(() => {});
  }, [bookmarksRef, writeNames]);

  // Replace the in-memory set from an external update (sync pull / hand edit),
  // WITHOUT pruning or writing back. Pruning here is unsafe: the tree may not
  // yet reflect files that arrived in the same merge, so a just-synced bookmark
  // would be dropped and the pruned set pushed back, deleting it everywhere.
  // Unresolvable names are harmless — they're resolved lazily on click and get
  // cleaned up by the next full workspace load (which prunes against fresh data).
  const replaceBookmarks = useCallback((names: string[]) => {
    const next = new Set(names.map((n) => n.toLowerCase()));
    setBookmarks(next);
    bookmarksRef.current = next;
  }, [bookmarksRef]);

  // Toggle one file's bookmark; writes the new set to disk.
  const toggleBookmark = useCallback(async (absPath: string) => {
    if (!workspacePath || !absPath) return;
    const key = bookmarkKey(absPath);
    const next = new Set(bookmarksRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setBookmarks(next);
    bookmarksRef.current = next;
    try {
      await writeNames(next);
    } catch (err: any) {
      showError(`Failed to save bookmarks: ${err.message ?? err}`);
    }
  }, [workspacePath, showError, bookmarksRef, writeNames]);

  // Force every file in `paths` to bookmarked === `desired`. One disk write.
  const setBookmarksForPaths = useCallback(async (paths: string[], desired: boolean) => {
    if (!workspacePath || !paths || paths.length === 0) return;
    const next = new Set(bookmarksRef.current);
    for (const p of paths) {
      const key = bookmarkKey(p);
      if (desired) next.add(key);
      else next.delete(key);
    }
    setBookmarks(next);
    bookmarksRef.current = next;
    try {
      await writeNames(next);
    } catch (err: any) {
      showError(`Failed to save bookmarks: ${err.message ?? err}`);
    }
  }, [workspacePath, showError, bookmarksRef, writeNames]);

  // Is this file bookmarked? (path → basename key lookup, reads live ref.)
  const isBookmarked = useCallback((absPath: string) => {
    return !!absPath && bookmarksRef.current.has(bookmarkKey(absPath));
  }, [bookmarksRef]);

  // Re-key on rename (oldName → newName, both basename keys). No write — the
  // caller batches and calls persistBookmarks. No-op (returns false) when the
  // old key isn't bookmarked, which is also how moves stay free: a move keeps
  // the basename, so old===new and there's nothing to do.
  const renameBookmarkName = useCallback((oldKey: string, newKey: string) => {
    const cur = bookmarksRef.current;
    if (oldKey === newKey || !cur.has(oldKey)) return false;
    const next = new Set(cur);
    next.delete(oldKey);
    next.add(newKey);
    setBookmarks(next);
    bookmarksRef.current = next;
    return true;
  }, [bookmarksRef]);

  // Drop a name (delete / left-markdown rename). No write — caller persists.
  const removeBookmarkName = useCallback((key: string) => {
    const cur = bookmarksRef.current;
    if (!cur.has(key)) return false;
    const next = new Set(cur);
    next.delete(key);
    setBookmarks(next);
    bookmarksRef.current = next;
    return true;
  }, [bookmarksRef]);

  // Persist the current set to disk (after batched rename/delete edits).
  const persistBookmarks = useCallback(async () => {
    try {
      await writeNames(bookmarksRef.current);
    } catch (err) {
      console.warn('[bookmarks] persist failed:', err);
    }
  }, [bookmarksRef, writeNames]);

  return {
    bookmarks,
    resetBookmarks,
    seedBookmarks,
    replaceBookmarks,
    toggleBookmark,
    setBookmarksForPaths,
    isBookmarked,
    renameBookmarkName,
    removeBookmarkName,
    persistBookmarks,
  };
}
