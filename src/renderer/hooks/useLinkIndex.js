import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLinkIndex, normalizeTarget } from '../linkIndex.js';

function flattenTree(nodes, out = []) {
  for (const n of nodes) {
    if (n.children) flattenTree(n.children, out);
    else out.push(n);
  }
  return out;
}

function buildPageIndex(treeData) {
  const map = new Map();
  for (const file of flattenTree(treeData)) {
    if (!file.name.toLowerCase().endsWith('.md')) continue;
    const key = file.name.slice(0, -3).toLowerCase();
    const existing = map.get(key);
    if (!existing || file.id.length < existing.length) {
      map.set(key, file.id);
    }
  }
  return map;
}

export function useLinkIndex(tree) {
  const linkIndexRef = useRef(null);
  if (linkIndexRef.current === null) {
    linkIndexRef.current = createLinkIndex();
  }
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const pageIndex = useMemo(() => buildPageIndex(tree), [tree]);
  const pageIndexRef = useRef(pageIndex);
  useEffect(() => { pageIndexRef.current = pageIndex; }, [pageIndex]);

  const updateFile = useCallback((path, content) => {
    linkIndexRef.current.updateFile(path, content);
    bump();
  }, [bump]);

  const applyParsedLinks = useCallback((path, outgoingLinks, mtime) => {
    linkIndexRef.current.applyParsedLinks(path, outgoingLinks, mtime);
    bump();
  }, [bump]);

  const removeFile = useCallback((path) => {
    linkIndexRef.current.removeFile(path);
    bump();
  }, [bump]);

  const renameFile = useCallback((oldPath, newPath) => {
    linkIndexRef.current.renameFile(oldPath, newPath);
    bump();
  }, [bump]);

  const rebuild = useCallback((files) => {
    linkIndexRef.current.rebuild(files);
    bump();
  }, [bump]);

  const getBacklinksForFile = useCallback((filePath) => {
    if (!filePath) return [];
    const fileName = filePath.split('/').pop();
    const key = normalizeTarget(fileName);
    const resolved = pageIndex.get(key);
    if (resolved !== filePath) return [];
    const groups = linkIndexRef.current.getEntriesGroupedBySource(key);
    return groups.filter((g) => g.fromPath !== filePath);
  }, [pageIndex]);

  return {
    linkIndexRef,
    pageIndex,
    pageIndexRef,
    version,
    bump,
    updateFile,
    applyParsedLinks,
    removeFile,
    renameFile,
    rebuild,
    getBacklinksForFile,
  };
}
