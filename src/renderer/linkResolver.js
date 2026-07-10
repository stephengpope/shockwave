// Pure wiki-link resolution rules. Self-contained (no imports) so it's unit-
// testable and cheap to call. The caller supplies `candidatesFor(basename)` →
// array of absolute paths that share that basename (the metadata cache's private
// phone book), so this module never holds workspace state itself.
//
//   resolveLinkTarget(parsed, sourcePath, candidatesFor, workspacePath) → absPath|null
//     Obsidian's getFirstLinkpathDest: path-qualified links match by path (with a
//     basename fallback if stale); bare links use same-folder → shortest tiebreaker.
//
//   shortestUniqueLinkFor(targetPath, candidatesFor, workspacePath) → string
//     The [[…]] body to write: bare basename when unique, else the shortest path
//     suffix that disambiguates it.

function dirOf(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; }

function relOf(absPath, workspacePath) {
  if (!workspacePath) return absPath;
  const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function relNoExtLower(absPath, workspacePath) {
  return relOf(absPath, workspacePath).replace(/\.md$/i, '').toLowerCase();
}

function pickShortest(paths) {
  let best = null;
  for (const p of paths) {
    if (best === null) { best = p; continue; }
    const dp = p.split('/').length, db = best.split('/').length;
    if (dp < db || (dp === db && (p.length < best.length || (p.length === best.length && p < best)))) best = p;
  }
  return best;
}

function bareResolve(candidates, sourcePath) {
  if (candidates.length === 1) return candidates[0];
  const srcDir = dirOf(sourcePath || '');
  const sameFolder = candidates.filter((p) => dirOf(p) === srcDir);
  if (sameFolder.length === 1) return sameFolder[0];
  if (sameFolder.length > 1) return pickShortest(sameFolder);
  return pickShortest(candidates);
}

export function resolveLinkTarget(parsed, sourcePath, candidatesFor, workspacePath) {
  if (!parsed || !parsed.basename) return null;
  const candidates = candidatesFor(parsed.basename) || [];
  if (candidates.length === 0) return null;

  if (parsed.segments.length > 0) {
    const suffix = [...parsed.segments, parsed.basename].join('/');
    const matches = candidates.filter((p) => {
      const rel = relNoExtLower(p, workspacePath);
      return rel === suffix || rel.endsWith('/' + suffix);
    });
    if (matches.length === 0) return bareResolve(candidates, sourcePath); // stale path → basename fallback
    const exact = matches.find((p) => relNoExtLower(p, workspacePath) === suffix);
    return exact || pickShortest(matches);
  }
  return bareResolve(candidates, sourcePath);
}

export function shortestUniqueLinkFor(targetPath, candidatesFor, workspacePath) {
  const rel = relOf(targetPath, workspacePath).replace(/\.md$/i, '');
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  const candidates = candidatesFor(base.toLowerCase()) || [];
  if (candidates.length <= 1) return base; // basename is unique → bare link

  const others = candidates
    .filter((p) => p !== targetPath)
    .map((p) => relOf(p, workspacePath).replace(/\.md$/i, '').toLowerCase());
  for (let take = 1; take <= parts.length; take++) {
    const suffix = parts.slice(parts.length - take).join('/');
    const suffixLower = suffix.toLowerCase();
    const collides = others.some((o) => o === suffixLower || o.endsWith('/' + suffixLower));
    if (!collides) return suffix; // original case preserved
  }
  return rel;
}
