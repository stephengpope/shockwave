import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Tree } from 'react-arborist';
import { FILE_ACTIONS } from './constants.js';
import { SIDEBAR_IMAGE_MIME } from './imagePaste.js';

const FileTree = forwardRef<any, any>(function FileTree(
  { data, onSelect, onRename, onFileAction, onFolderAction, onMoveItems, disableDrop, getIsBookmarked, bookmarkedPaths },
  ref,
) {
  const wrapRef = useRef<any>(null);
  const treeRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    // Put a node into rename-edit mode. Retries briefly because the node may not be
    // present in the Tree's internal model yet (data prop just updated).
    editNode(id) {
      const tryEdit = (attempt = 0) => {
        const tree = treeRef.current;
        if (tree && tree.get?.(id)) {
          tree.edit(id);
          return;
        }
        if (attempt < 10) requestAnimationFrame(() => tryEdit(attempt + 1));
      };
      tryEdit();
    },
    // Collapse every folder in the tree.
    closeAll() {
      treeRef.current?.closeAll?.();
    },
  }), []);

  return (
    <div ref={wrapRef} className="tree-fill">
      {size.width > 0 && (
        <Tree
          ref={treeRef}
          data={data}
          openByDefault={false}
          // Confine react-arborist's react-dnd backend to the tree element so
          // it stops owning window-wide drag events (the editor/chat handle
          // their own native drops). wrapRef is mounted before size>0 gates the
          // Tree in, so it's non-null here.
          dndRootElement={wrapRef.current}
          width={size.width}
          height={size.height}
          indent={16}
          rowHeight={24}
          onSelect={onSelect}
          onRename={onRename}
          onMove={({ dragIds, parentId }) => {
            if (onMoveItems) onMoveItems(dragIds, parentId);
          }}
          disableDrop={disableDrop}
        >
          {(props) => (
            <Node
              {...props}
              onFileAction={onFileAction}
              onFolderAction={onFolderAction}
              getIsBookmarked={getIsBookmarked}
              isBookmarked={bookmarkedPaths?.has(props.node.id)}
            />
          )}
        </Tree>
      )}
    </div>
  );
});

export default FileTree;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function Node({ node, tree, style, dragHandle, onFileAction, onFolderAction, getIsBookmarked, isBookmarked }: any) {
  const isFolder = node.isInternal;
  const isImage = !isFolder && IMAGE_EXT_RE.test(node.data.name);
  const willReceiveDrop = isFolder && node.willReceiveDrop;

  const handleDragStart = (e) => {
    if (!isImage) return;
    // Native dataTransfer payload, read back by the editor/chat drop handler.
    e.dataTransfer.setData(SIDEBAR_IMAGE_MIME, node.id);
    e.dataTransfer.effectAllowed = 'copy';

    // Custom drag image — a small chip with the filename. Browser snapshots
    // the element at this moment, so we add off-screen, snapshot, then
    // remove on the next frame.
    const ghost = document.createElement('div');
    ghost.className = 'image-drag-ghost';
    ghost.textContent = node.data.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 8, 8);
    requestAnimationFrame(() => ghost.remove());

    // Stop react-arborist's react-dnd drag source (for image rows we want a
    // drag-to-embed, not a tree reorder) so it doesn't override our drag image
    // with getEmptyImage().
    e.stopPropagation();
  };

  const handleContextMenu = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isFolder) {
      // Folder context menus stay single-selection — mixed folder/file
      // multi-select adds more UX confusion than it's worth here.
      const action = await window.api.showFolderContextMenu();
      if (!action) return;
      if (onFolderAction) onFolderAction(action, node.id);
      return;
    }

    // File context. Finder semantics: if the right-clicked row is part of an
    // existing multi-selection, the action operates on the whole selection.
    // Otherwise the selection collapses to just this row.
    const selectedIds = tree?.selectedIds ?? new Set();
    let targetPaths;
    if (selectedIds.has(node.id) && selectedIds.size > 1) {
      // Drop folders from the multi-selection — bulk file ops only act on files.
      targetPaths = [];
      for (const id of selectedIds) {
        const n = tree.get(id);
        if (n && !n.isInternal) targetPaths.push(id);
      }
      if (targetPaths.length === 0) targetPaths = [node.id];
    } else {
      tree.select(node.id);
      targetPaths = [node.id];
    }

    const allMd = targetPaths.every((p) => p.toLowerCase().endsWith('.md'));
    const allBookmarked = getIsBookmarked
      ? targetPaths.every((p) => getIsBookmarked(p))
      : !!isBookmarked;
    const action = await window.api.showFileContextMenu({
      isMd: allMd,
      isBookmarked: allBookmarked,
      selectionCount: targetPaths.length,
    });
    if (!action) return;
    if (action === FILE_ACTIONS.RENAME) {
      // Rename is single-only (the menu template hides it when multi).
      node.edit();
    } else if (onFileAction) {
      onFileAction(action, targetPaths);
    }
  };

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`tree-row ${node.isSelected ? 'selected' : ''} ${willReceiveDrop ? 'drop-target' : ''}`}
      onClick={(e) => {
        // react-arborist's default Row wrapper around this Node also binds
        // onClick={node.handleClick}. If we don't stop propagation, the click
        // bubbles up and handleClick runs TWICE — for a Cmd+click that means
        // the second call sees isSelected=true (we just added it) and
        // immediately deselects, undoing the multi-select. So we stop the
        // event here and own the click logic ourselves.
        e.stopPropagation();
        // Delegate to react-arborist's modifier-aware handler so Cmd+click
        // toggles a multi-selection and Shift+click extends a range.
        node.handleClick(e);
        // Folder expand-collapse only on a plain click — if the user is
        // Cmd/Shift-clicking to build a selection, leave folder state alone.
        if (isFolder && !e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          node.toggle();
        }
      }}
      onDoubleClick={() => !isFolder && node.edit()}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
    >
      <span className="tree-caret">
        {isFolder ? (node.isOpen ? '▾' : '▸') : ''}
      </span>
      <span className="tree-icon">{isFolder ? '📁' : '📄'}</span>
      {node.isEditing ? (
        <input
          autoFocus
          defaultValue={node.data.name.replace(/\.md$/i, '')}
          onBlur={() => node.reset()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') node.reset();
            if (e.key === 'Enter') node.submit(e.currentTarget.value);
          }}
          className="tree-rename-input"
        />
      ) : (
        <span className="tree-name">{node.data.name}</span>
      )}
    </div>
  );
}
