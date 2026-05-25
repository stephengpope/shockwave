import { normalizeTarget } from './linkIndex.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rewrite every `[[oldName]]` (case-insensitive, with optional #heading or
// |alias suffixes preserved) to `[[newName]]` across all files that reference
// `oldName` according to the link index. Returns the list of files that were
// actually changed so callers can decide what else to do (refresh tree, etc.).
//
// NOTE: this rewrites the target name only. If the file containing the link
// has been moved, the link still resolves by basename in the page index.
//
// `selfPath` is the file that's about to be renamed. We rewrite its self-
// references too — if Foo.md contains `[[Foo]]` and is being renamed to
// Bar.md, we want the in-file link to become `[[Bar]]`. Pass it so we know
// which path is the file being renamed (for index updates after writing).
export async function rewriteReferences({ api, linkIndex, oldBaseName, newBaseName, selfPath = null }) {
  const targetKey = normalizeTarget(oldBaseName);
  const backlinks = linkIndex.getBacklinks(targetKey);
  const uniqueSources = new Set();
  for (const e of backlinks) uniqueSources.add(e.fromPath);

  const targetEsc = escapeRegex(oldBaseName);
  const linkPattern = new RegExp(
    `\\[\\[(${targetEsc})((?:#[^\\]\\n|]*)?(?:\\|[^\\]\\n]*)?)\\]\\]`,
    'gi'
  );

  const rewritten = [];
  for (const src of uniqueSources) {
    const content = await api.readFile(src);
    const next = content.replace(linkPattern, `[[${newBaseName}$2]]`);
    if (next !== content) {
      await api.writeFile(src, next);
      // For the file being renamed (selfPath), don't update the link index
      // here — the caller will rename it, which will re-key everything.
      // For other files, refresh their outgoing links now.
      if (src !== selfPath) linkIndex.updateFile(src, next);
      rewritten.push(src);
    }
  }
  return rewritten;
}

// In-app rename. Rewrites references first (so they point at the new name)
// then renames the file on disk. The IPC handler auto-disambiguates the name
// if it collides with another .md anywhere in the workspace, returning the
// final path used. We rewrite references AGAIN under the final name in case
// the user-typed name was disambiguated (otherwise refs would point to a
// nonexistent name).
export async function renameWithReferences({ api, linkIndex, oldPath, newName }) {
  const slash = oldPath.lastIndexOf('/');
  const dir = slash >= 0 ? oldPath.slice(0, slash) : '';
  const userBaseName = newName.replace(/\.md$/i, '').trim();
  if (!userBaseName) throw new Error('Name cannot be empty');
  if (`${dir}/${userBaseName}.md` === oldPath) return oldPath;

  const oldBaseName = (slash >= 0 ? oldPath.slice(slash + 1) : oldPath).replace(/\.md$/i, '');

  // Rename on disk first so we know the actual final name (the IPC may have
  // auto-disambiguated). Then rewrite references to match.
  let finalNewPath;
  try {
    finalNewPath = await api.renameFile(oldPath, userBaseName);
  } catch (err) {
    throw new Error(`Rename failed: ${err.message ?? err}`);
  }

  const finalBaseName = finalNewPath.slice(finalNewPath.lastIndexOf('/') + 1).replace(/\.md$/i, '');

  // Re-key the index BEFORE rewriting references. Otherwise rewriteReferences
  // would call updateFile on the renamed file with its old path.
  linkIndex.renameFile(oldPath, finalNewPath);

  // Rewrite using the FINAL name (may differ from user input due to disambiguation).
  await rewriteReferences({
    api,
    linkIndex,
    oldBaseName,
    newBaseName: finalBaseName,
    selfPath: finalNewPath,
  });

  // Refresh the renamed file's own outgoing links (its self-references were rewritten).
  try {
    const updatedContent = await api.readFile(finalNewPath);
    linkIndex.updateFile(finalNewPath, updatedContent);
  } catch {
    // File may have been moved/deleted by a concurrent op — index update is best-effort.
  }

  return finalNewPath;
}
