import { useState, useCallback } from 'react';
import { useSyncRef } from './useSyncRef';
import { toRelPath, toAbsPath } from '../pathUtils';
import type { TreeNode } from '../../shared/api';

// Collect every bookmarked file from the tree as a flat list (no folders).
// Bookmark filter mode renders bookmarks as a single sorted list rather than
// preserving the folder hierarchy.
export function flattenBookmarkedFiles(nodes: TreeNode[], bookmarkedSet: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.children) walk(n.children);
      else if (bookmarkedSet.has(n.id)) out.push(n);
    }
  };
  walk(nodes);
  return out;
}

interface UseBookmarksOpts {
  workspacePath: string | null;
  showError: (msg: string) => void;
}

// Per-workspace bookmark set (absolute paths in memory; workspace-relative
// POSIX paths on disk in `<workspace>/.shockwave/bookmarks.json`). Owns the
// bookmark state, the filter-mode toggle, and all mutation/persist logic that
// used to live in App.jsx.
export function useBookmarks({ workspacePath, showError }: UseBookmarksOpts) {
  const [bookmarks, setBookmarks] = useState<Set<string>>(() => new Set());
  const bookmarksRef = useSyncRef(bookmarks);
  const [bookmarkFilterActive, setBookmarkFilterActive] = useState(false);

  // Clear in-memory state (called at the start of a workspace switch).
  const resetBookmarks = useCallback(() => {
    setBookmarks(new Set());
    bookmarksRef.current = new Set();
    setBookmarkFilterActive(false);
  }, [bookmarksRef]);

  // Seed from disk: convert stored rel paths to abs, prune entries whose files
  // no longer exist, and rewrite the on-disk file if anything was pruned.
  const seedBookmarks = useCallback((wsPath: string, relPaths: string[], existingPaths: Set<string>) => {
    const absSet = new Set<string>();
    let needsRewrite = false;
    for (const rel of relPaths) {
      const abs = toAbsPath(rel, wsPath);
      if (abs && existingPaths.has(abs)) absSet.add(abs);
      else needsRewrite = true;
    }
    setBookmarks(absSet);
    bookmarksRef.current = absSet;
    if (needsRewrite) {
      const cleaned = Array.from(absSet).map((p) => toRelPath(p, wsPath)).filter((p): p is string => p !== null);
      window.api.bookmarks.write(wsPath, cleaned).catch(() => {});
    }
  }, [bookmarksRef]);

  // Toggle one path; writes the new set to disk.
  const toggleBookmark = useCallback(async (absPath: string) => {
    if (!workspacePath || !absPath) return;
    const next = new Set(bookmarksRef.current);
    if (next.has(absPath)) next.delete(absPath);
    else next.add(absPath);
    setBookmarks(next);
    bookmarksRef.current = next;
    const rels = Array.from(next).map((p) => toRelPath(p, workspacePath)).filter((p): p is string => p !== null);
    try {
      await window.api.bookmarks.write(workspacePath, rels);
    } catch (err: any) {
      showError(`Failed to save bookmarks: ${err.message ?? err}`);
    }
  }, [workspacePath, showError, bookmarksRef]);

  // Force every path in `paths` to bookmarked === `desired`. One disk write.
  const setBookmarksForPaths = useCallback(async (paths: string[], desired: boolean) => {
    if (!workspacePath || !paths || paths.length === 0) return;
    const next = new Set(bookmarksRef.current);
    for (const p of paths) {
      if (desired) next.add(p);
      else next.delete(p);
    }
    setBookmarks(next);
    bookmarksRef.current = next;
    const rels = Array.from(next).map((p) => toRelPath(p, workspacePath)).filter((p): p is string => p !== null);
    try {
      await window.api.bookmarks.write(workspacePath, rels);
    } catch (err: any) {
      showError(`Failed to save bookmarks: ${err.message ?? err}`);
    }
  }, [workspacePath, showError, bookmarksRef]);

  // Rewrite a single path (rename flows). No write — caller batches + persists.
  const renameBookmarkPath = useCallback((oldPath: string, newPath: string) => {
    const cur = bookmarksRef.current;
    if (!cur.has(oldPath)) return false;
    const next = new Set(cur);
    next.delete(oldPath);
    next.add(newPath);
    setBookmarks(next);
    bookmarksRef.current = next;
    return true;
  }, [bookmarksRef]);

  // Drop a path (delete flows). No write — caller batches + persists.
  const removeBookmarkPath = useCallback((absPath: string) => {
    const cur = bookmarksRef.current;
    if (!cur.has(absPath)) return false;
    const next = new Set(cur);
    next.delete(absPath);
    setBookmarks(next);
    bookmarksRef.current = next;
    return true;
  }, [bookmarksRef]);

  // Persist the current set to disk (after batched rename/delete edits).
  const persistBookmarks = useCallback(async () => {
    if (!workspacePath) return;
    const rels = Array.from(bookmarksRef.current).map((p) => toRelPath(p, workspacePath)).filter((p): p is string => p !== null);
    try {
      await window.api.bookmarks.write(workspacePath, rels);
    } catch (err) {
      console.warn('[bookmarks] persist failed:', err);
    }
  }, [workspacePath, bookmarksRef]);

  return {
    bookmarks,
    bookmarksRef,
    bookmarkFilterActive,
    setBookmarkFilterActive,
    resetBookmarks,
    seedBookmarks,
    toggleBookmark,
    setBookmarksForPaths,
    renameBookmarkPath,
    removeBookmarkPath,
    persistBookmarks,
  };
}
