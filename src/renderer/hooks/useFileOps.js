import { useCallback } from 'react';
import { FILE_ACTIONS } from '../constants.js';
import { renameWithReferences } from '../renameOps.js';

export function useFileOps({
  workspacePath,
  pageIndex,
  linkIndex,        // from useLinkIndex
  tabs,             // from useTabs
  writeNow,
  openInActiveTab,
  openInNewTab,
  closeTabsForPath,
  renameTabsPath,
  showError,
  refreshTree,
}) {
  const treeAndIndexChanged = useCallback(async () => {
    await refreshTree();
    linkIndex.bump();
  }, [refreshTree, linkIndex]);

  const performRename = useCallback(async (oldPath, newName) => {
    try {
      await writeNow();
      const newPath = await renameWithReferences({
        api: window.api,
        linkIndex: linkIndex.linkIndexRef.current,
        oldPath,
        newName,
      });
      renameTabsPath(oldPath, newPath);
      await treeAndIndexChanged();
    } catch (err) {
      showError(err.message ?? String(err));
    }
  }, [writeNow, linkIndex, renameTabsPath, treeAndIndexChanged, showError]);

  const onLinkClick = useCallback(async (rawName) => {
    if (!workspacePath) return;
    const name = rawName.replace(/\.md$/i, '');
    const key = name.toLowerCase();
    const existing = pageIndex.get(key);
    if (existing) {
      await openInActiveTab(existing);
      return;
    }
    const newPath = await window.api.createFile(workspacePath, `${name}.md`, '');
    linkIndex.updateFile(newPath, '');
    await treeAndIndexChanged();
    await openInActiveTab(newPath);
  }, [workspacePath, pageIndex, openInActiveTab, linkIndex, treeAndIndexChanged]);

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
      } else if (action === FILE_ACTIONS.DELETE) {
        const confirmed = await window.api.trashFile(filePath);
        if (!confirmed) return;
        closeTabsForPath(filePath);
        linkIndex.removeFile(filePath);
        await treeAndIndexChanged();
      }
    } catch (err) {
      showError(err.message ?? String(err));
    }
  }, [openInNewTab, closeTabsForPath, linkIndex, treeAndIndexChanged, showError]);

  return {
    performRename,
    onLinkClick,
    onFileAction,
    treeAndIndexChanged,
  };
}
