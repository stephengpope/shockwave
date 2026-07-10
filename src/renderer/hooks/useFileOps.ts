import { useCallback } from 'react';
import { FILE_ACTIONS } from '../constants.js';
import { parseTarget } from '../linkIndex.js';

export function useFileOps({
  workspacePath,
  linkIndex,        // from useLinkIndex
  writeNow,
  openInActiveTab,
  openInNewTab,
  renameTabsPath,
  showError,
  refreshTree,
}: any): any {
  const treeAndIndexChanged = useCallback(async () => {
    await refreshTree();
    linkIndex.bump();
  }, [refreshTree, linkIndex]);

  const onLinkClick = useCallback(async (rawName, sourcePath) => {
    if (!workspacePath) return;
    const parsed = parseTarget(rawName);
    if (!parsed.basename) return;
    const existing = linkIndex.cache.getFirstLinkpathDest(parsed, sourcePath);
    if (existing) {
      await openInActiveTab(existing);
      return;
    }
    // Unresolved → create the target. Honor a path prefix (folder/Foo →
    // folder/Foo.md) using the raw link's original case; a bare name lands in
    // the workspace root.
    const rawParts = rawName.replace(/\.md$/i, '').split('/').filter(Boolean);
    const displayBase = rawParts[rawParts.length - 1];
    const segs = rawParts.slice(0, -1);
    const dir = segs.length ? `${workspacePath}/${segs.join('/')}` : workspacePath;
    if (segs.length) await window.api.ensureDir(dir);
    const { path: newPath, mtime } = await window.api.createFile(dir, `${displayBase}.md`, '');
    linkIndex.updateFile(newPath, '', mtime);
    await treeAndIndexChanged();
    await openInActiveTab(newPath);
  }, [workspacePath, openInActiveTab, linkIndex, treeAndIndexChanged]);

  const onFileAction = useCallback(async (action, filePath) => {
    try {
      if (action === FILE_ACTIONS.NEW_TAB) {
        await openInNewTab(filePath);
      } else if (action === FILE_ACTIONS.DUPLICATE) {
        const newPath = await window.api.duplicateFile(filePath);
        const newContent = await window.api.readFile(newPath);
        linkIndex.updateFile(newPath, newContent);
        await treeAndIndexChanged();
      } else if (action === FILE_ACTIONS.REVEAL) {
        await window.api.revealInFolder(filePath);
      }
      // DELETE is handled in App (ConfirmDialog → trashFiles), not here.
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [openInNewTab, linkIndex, treeAndIndexChanged, showError]);

  return {
    onLinkClick,
    onFileAction,
    treeAndIndexChanged,
  };
}
