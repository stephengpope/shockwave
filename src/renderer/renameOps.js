import { LINK_RE, parseTarget } from './linkIndex.js';
import { resolveLinkTarget, shortestUniqueLinkFor } from './linkResolver.js';

function baseKeyOf(p) {
  const name = p.slice(p.lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '').toLowerCase();
}

function splitInner(inner) {
  const pipeAt = inner.indexOf('|');
  const beforePipe = pipeAt >= 0 ? inner.slice(0, pipeAt) : inner;
  const aliasTail = pipeAt >= 0 ? inner.slice(pipeAt) : '';
  const hashAt = beforePipe.indexOf('#');
  const pathPart = hashAt >= 0 ? beforePipe.slice(0, hashAt) : beforePipe;
  const headingTail = hashAt >= 0 ? beforePipe.slice(hashAt) : '';
  return { pathPart, suffix: headingTail + aliasTail };
}

function swapBaseSegment(pathPart, newBaseName) {
  const slash = pathPart.lastIndexOf('/');
  return slash >= 0 ? pathPart.slice(0, slash + 1) + newBaseName : newBaseName;
}

// Both rewriters are order-independent w.r.t. the cache re-key: the caller passes
// `sources` (files that linked to oldPath) and `candidatesFor` (a name→paths
// snapshot in which oldPath is still present under its basename), both captured
// BEFORE any cache mutation. Resolution runs against that snapshot, so it doesn't
// matter whether cache.renameFile has already run. `cache` is used only to
// re-index the source files whose content we rewrite.

// RENAME (basename changes old→new). Rewrites links resolving to oldPath — the
// basename segment swapped, folder prefix + #heading/|alias preserved. Only
// links that actually resolve to oldPath are touched (a `[[Meeting]]` pointing
// at a different duplicate is left alone). Self-refs in the renamed file (now at
// finalPath) are handled via `resolveSrc`.
export async function rewriteReferences({ api, cache, sources, candidatesFor, workspacePath, oldPath, finalPath, oldBaseName, newBaseName }) {
  const oldBaseLower = oldBaseName.toLowerCase();
  const srcSet = new Set(sources);
  srcSet.add(finalPath);
  const rewritten = [];
  for (const src of srcSet) {
    let content;
    try { content = await api.readFile(src); } catch { continue; }
    const resolveSrc = src === finalPath ? oldPath : src;
    const next = content.replace(LINK_RE, (whole, inner) => {
      const parsed = parseTarget(inner);
      if (parsed.basename !== oldBaseLower) return whole;
      if (resolveLinkTarget(parsed, resolveSrc, candidatesFor, workspacePath) !== oldPath) return whole;
      const { pathPart, suffix } = splitInner(inner);
      return `[[${swapBaseSegment(pathPart, newBaseName)}${suffix}]]`;
    });
    if (next !== content) {
      const mtime = await api.writeFile(src, next);
      if (src !== finalPath) cache.updateFile(src, next, mtime); // renamed file re-indexed via cache.renameFile
      rewritten.push(src);
    }
  }
  return rewritten;
}

// MOVE (folder changes, basename same). Re-qualifies path-links so they point at
// the new location. A no-op unless the basename is duplicated (bare links resolve
// by name and self-heal). `candidatesFor` is the PRE-move snapshot; the new link
// body is computed against the POST-move candidate set (oldPath swapped to newPath).
export async function rewriteReferencesForMove({ api, cache, sources, candidatesFor, workspacePath, oldPath, newPath }) {
  const base = baseKeyOf(oldPath);
  const bucket = candidatesFor(base) || [];
  if (bucket.length <= 1) return [];
  const postCandidatesFor = (b) => (b === base ? bucket.map((p) => (p === oldPath ? newPath : p)) : candidatesFor(b));

  const rewritten = [];
  for (const src of new Set(sources)) {
    if (src === oldPath || src === newPath) continue;
    let content;
    try { content = await api.readFile(src); } catch { continue; }
    const next = content.replace(LINK_RE, (whole, inner) => {
      const parsed = parseTarget(inner);
      if (parsed.basename !== base) return whole;
      if (resolveLinkTarget(parsed, src, candidatesFor, workspacePath) !== oldPath) return whole;
      const { suffix } = splitInner(inner);
      return `[[${shortestUniqueLinkFor(newPath, postCandidatesFor, workspacePath)}${suffix}]]`;
    });
    if (next !== content) {
      const mtime = await api.writeFile(src, next);
      cache.updateFile(src, next, mtime);
      rewritten.push(src);
    }
  }
  return rewritten;
}

// Capture the (sources, candidatesFor snapshot) a rewriter needs, BEFORE any
// cache mutation. The snapshot pins the current name→paths for `basename` (which
// still includes the file being renamed/moved) so resolution stays correct even
// after cache.renameFile runs.
export function captureRewriteContext(cache, oldPath) {
  const base = baseKeyOf(oldPath);
  const snapshot = cache.candidatesFor(base).slice();
  const candidatesFor = (b) => (b === base ? snapshot : cache.candidatesFor(b));
  return { sources: cache.getBacklinkSources(oldPath), candidatesFor };
}
