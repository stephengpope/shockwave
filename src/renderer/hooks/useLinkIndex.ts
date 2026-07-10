import { useCallback, useMemo, useRef, useState } from 'react';
import { createMetadataCache } from '../metadataCache.js';

// Thin React wrapper around the metadata cache (createMetadataCache). The cache
// owns the link graph + the private name index and resolves links itself; this
// hook just bumps a `version` after each mutation so the UI/graph re-render, and
// keeps the cache's workspace path current.
export function useLinkIndex(tree: any, workspacePath?: string | null): any {
  const cacheRef = useRef<any>(null);
  if (cacheRef.current === null) cacheRef.current = createMetadataCache();
  // Resolution needs the workspace root (for path-qualified links). Setting a
  // ref value in render is idempotent and runs before any event handler that
  // would rebuild/resolve.
  cacheRef.current.setWorkspacePath(workspacePath ?? null);

  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const updateFile = useCallback((path, content, mtime) => { cacheRef.current.updateFile(path, content, mtime); bump(); }, [bump]);
  const applyParsedLinks = useCallback((path, links, mtime) => { cacheRef.current.applyParsedLinks(path, links, mtime); bump(); }, [bump]);
  const removeFile = useCallback((path) => { cacheRef.current.removeFile(path); bump(); }, [bump]);
  const renameFile = useCallback((oldPath, newPath) => { cacheRef.current.renameFile(oldPath, newPath); bump(); }, [bump]);
  const rebuild = useCallback((files) => { cacheRef.current.rebuild(files); bump(); }, [bump]);

  // Batch several mutations then bump once (folder move/trash loops).
  const mutate = useCallback((fn) => { fn(cacheRef.current); bump(); }, [bump]);

  const getBacklinksForFile = useCallback((filePath) => (filePath ? cacheRef.current.getBacklinksForFile(filePath) : []), []);
  const getMtime = useCallback((p) => cacheRef.current.getMtime(p), []);

  // Stable identity except when the cache version changes — so linkIndex-keyed
  // memos (e.g. activeBacklinks) only recompute when the graph actually changed.
  return useMemo(() => ({
    cache: cacheRef.current,
    cacheRef,
    linkIndexRef: cacheRef,   // back-compat alias — callers read `.current` for the cache
    version,
    bump,
    updateFile,
    applyParsedLinks,
    removeFile,
    renameFile,
    rebuild,
    mutate,
    getBacklinksForFile,
    getMtime,
  }), [version, bump, updateFile, applyParsedLinks, removeFile, renameFile, rebuild, mutate, getBacklinksForFile, getMtime]);
}
