// In-memory metadata cache — modeled on (and named after) Obsidian's.
//
// Holds the workspace's wiki-link graph and resolves links eagerly, the way
// Obsidian does: when a file's links are parsed, each is resolved to a concrete
// destination file *now* and stored, rather than re-resolved on every read.
//
// Public surface (mirrors Obsidian):
//   resolvedLinks    : Map<sourcePath, Map<destPath, count>>     — the forward graph
//   unresolvedLinks  : Map<sourcePath, Map<linkText, count>>     — links with no target
//   getFirstLinkpathDest(parsed, sourcePath) → destPath | null   — resolve one link
//   getBacklinksForFile(path) → [{ fromPath, lineNumber, lineText, contextLines }]
//                                                                — reverse of resolvedLinks
//
// The name→files table ("phone book") is PRIVATE (`byBasename`), maintained
// incrementally as files are added/removed/renamed and hidden behind
// getFirstLinkpathDest — exactly like Obsidian, where plugins never see it.

import { parseLinks } from './linkIndex.js';
import { resolveLinkTarget, shortestUniqueLinkFor as shortestUnique } from './linkResolver.js';

function baseKey(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '').toLowerCase();
}

export function createMetadataCache() {
  let workspacePath = null;

  const byBasename = new Map();     // basenameLower → Set<absPath>   (private phone book)
  const parsedByFile = new Map();   // path → parseLinks() output (kept so links can be re-resolved)
  const mtimes = new Map();

  const resolvedLinks = new Map();   // sourcePath → Map<destPath, count>
  const unresolvedLinks = new Map(); // sourcePath → Map<linkText, count>
  const backlinks = new Map();       // destPath → [{ fromPath, lineNumber, lineText, contextLines }]

  function setWorkspacePath(wp) { workspacePath = wp; }

  // --- private phone book ---------------------------------------------------
  function indexPath(path) {
    const b = baseKey(path);
    let s = byBasename.get(b);
    if (!s) { s = new Set(); byBasename.set(b, s); }
    s.add(path);
  }
  function deindexPath(path) {
    const b = baseKey(path);
    const s = byBasename.get(b);
    if (s) { s.delete(path); if (s.size === 0) byBasename.delete(b); }
  }

  // candidatesFor(basename) → the phone-book entry (array of paths). Passed to
  // the shared resolver so the resolution rules live in one tested place.
  function candidatesFor(basename) {
    const s = byBasename.get(basename);
    return s ? [...s] : [];
  }

  // Obsidian's getFirstLinkpathDest: resolve one parsed link ({segments,
  // basename}) from its source file to a destination path (or null).
  function getFirstLinkpathDest(parsed, sourcePath) {
    return resolveLinkTarget(parsed, sourcePath, candidatesFor, workspacePath);
  }

  // --- resolve a source file's links into the forward + reverse graphs ------
  function clearSourceGraph(path) {
    const oldRes = resolvedLinks.get(path);
    if (oldRes) {
      for (const dest of oldRes.keys()) {
        const arr = backlinks.get(dest);
        if (arr) {
          const filtered = arr.filter((e) => e.fromPath !== path);
          if (filtered.length === 0) backlinks.delete(dest);
          else backlinks.set(dest, filtered);
        }
      }
    }
    resolvedLinks.delete(path);
    unresolvedLinks.delete(path);
  }

  function resolveSource(path) {
    clearSourceGraph(path);
    const parsed = parsedByFile.get(path);
    if (!parsed || parsed.length === 0) return;
    const res = new Map();
    const unres = new Map();
    for (const link of parsed) {
      const dest = getFirstLinkpathDest(link.targetParsed, path);
      if (dest) {
        res.set(dest, (res.get(dest) || 0) + 1);
        let arr = backlinks.get(dest);
        if (!arr) { arr = []; backlinks.set(dest, arr); }
        arr.push({ fromPath: path, lineNumber: link.lineNumber, lineText: link.lineText, contextLines: link.contextLines });
      } else {
        const key = link.target; // basename key for the unresolved bucket
        unres.set(key, (unres.get(key) || 0) + 1);
      }
    }
    if (res.size) resolvedLinks.set(path, res);
    if (unres.size) unresolvedLinks.set(path, unres);
  }

  // Every source that references `basename` (resolved OR unresolved) — used to
  // re-resolve links whose destination may have changed when a file with that
  // basename was added/removed/renamed (Obsidian's scoped `resolved` pass).
  function sourcesReferencing(basename) {
    const out = new Set();
    for (const [src, parsed] of parsedByFile) {
      if (parsed.some((l) => l.target === basename)) out.add(src);
    }
    return out;
  }
  function reresolveReferrers(basename) {
    for (const src of sourcesReferencing(basename)) resolveSource(src);
  }

  // --- mutators -------------------------------------------------------------
  function setParsed(path, parsed, mtime) {
    const isNew = !parsedByFile.has(path);
    parsedByFile.set(path, parsed);
    if (mtime !== undefined) mtimes.set(path, mtime);
    if (isNew) indexPath(path);
    resolveSource(path);
    if (isNew) reresolveReferrers(baseKey(path)); // a new file may satisfy others' links
  }

  function updateFile(path, content, mtime) {
    setParsed(path, parseLinks(content), mtime);
  }
  function applyParsedLinks(path, parsed, mtime) {
    setParsed(path, parsed, mtime);
  }

  function removeFile(path) {
    const b = baseKey(path);
    clearSourceGraph(path);
    parsedByFile.delete(path);
    mtimes.delete(path);
    deindexPath(path);
    reresolveReferrers(b); // links that resolved here may now resolve elsewhere / go unresolved
  }

  function renameFile(oldPath, newPath) {
    if (!parsedByFile.has(oldPath)) {
      if (mtimes.has(oldPath)) { mtimes.set(newPath, mtimes.get(oldPath)); mtimes.delete(oldPath); }
      return;
    }
    const parsed = parsedByFile.get(oldPath);
    const mtime = mtimes.get(oldPath);
    const oldBase = baseKey(oldPath);
    // Remove the old path everywhere, add the new one, then re-resolve both the
    // moved file and everyone who referenced either basename.
    clearSourceGraph(oldPath);
    parsedByFile.delete(oldPath);
    mtimes.delete(oldPath);
    deindexPath(oldPath);
    parsedByFile.set(newPath, parsed);
    if (mtime !== undefined) mtimes.set(newPath, mtime);
    indexPath(newPath);
    resolveSource(newPath);
    reresolveReferrers(oldBase);
    const newBase = baseKey(newPath);
    if (newBase !== oldBase) reresolveReferrers(newBase);
  }

  function rebuild(files) {
    byBasename.clear();
    parsedByFile.clear();
    mtimes.clear();
    resolvedLinks.clear();
    unresolvedLinks.clear();
    backlinks.clear();
    // Two passes: index every file first so resolution sees the whole set,
    // then resolve. (Avoids O(files²) re-resolution during the initial build.)
    for (const file of files) {
      const parsed = Array.isArray(file.outgoingLinks) ? file.outgoingLinks : parseLinks(file.content);
      parsedByFile.set(file.path, parsed);
      if (file.mtime !== undefined) mtimes.set(file.path, file.mtime);
      indexPath(file.path);
    }
    for (const path of parsedByFile.keys()) resolveSource(path);
  }

  // --- readers --------------------------------------------------------------
  function getBacklinksForFile(path) {
    const entries = backlinks.get(path);
    if (!entries || entries.length === 0) return [];
    const byPath = new Map();
    for (const e of entries) {
      if (e.fromPath === path) continue;
      let group = byPath.get(e.fromPath);
      if (!group) { group = { fromPath: e.fromPath, mtime: mtimes.get(e.fromPath) ?? 0, matches: [] }; byPath.set(e.fromPath, group); }
      group.matches.push({ lineNumber: e.lineNumber, lineText: e.lineText, contextLines: e.contextLines });
    }
    const groups = [...byPath.values()];
    for (const g of groups) g.matches.sort((a, b) => a.lineNumber - b.lineNumber);
    groups.sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : a.fromPath.localeCompare(b.fromPath)));
    return groups;
  }

  // Distinct source files that link TO `path` — the reverse of resolvedLinks,
  // used by the rename/move rewriters to find which files to touch.
  function getBacklinkSources(path) {
    const entries = backlinks.get(path);
    if (!entries) return [];
    return [...new Set(entries.map((e) => e.fromPath))];
  }

  // Every known file path (for autocomplete + folder-scoped sweeps).
  function allPaths() { return [...parsedByFile.keys()]; }

  // The [[…]] body to write for a link to `targetPath` (bare when unique, else
  // the shortest disambiguating path prefix). Uses the private phone book.
  function shortestUniqueLinkFor(targetPath) {
    return shortestUnique(targetPath, candidatesFor, workspacePath);
  }

  function getMtime(path) { return mtimes.get(path); }
  function getResolvedLinks() { return resolvedLinks; }
  function getUnresolvedLinks() { return unresolvedLinks; }

  return {
    setWorkspacePath,
    candidatesFor,
    pathsForBasename: candidatesFor,
    allPaths,
    getBacklinkSources,
    updateFile,
    applyParsedLinks,
    removeFile,
    renameFile,
    rebuild,
    getFirstLinkpathDest,
    getBacklinksForFile,
    shortestUniqueLinkFor,
    getMtime,
    resolvedLinks,
    unresolvedLinks,
    getResolvedLinks,
    getUnresolvedLinks,
  };
}
