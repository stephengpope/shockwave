import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Tree } from 'react-arborist';
import { FILE_ACTIONS } from './constants.js';
import { beginSidebarImageDrag, endSidebarImageDrag } from './imagePaste.js';

const FileTree = forwardRef(function FileTree(
  { data, onSelect, onRename, onFileAction, onFolderAction, onMoveItems, disableDrop, getIsBookmarked, bookmarkedPaths },
  ref,
) {
  const wrapRef = useRef(null);
  const treeRef = useRef(null);
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

function Node({ node, style, dragHandle, onFileAction, onFolderAction, getIsBookmarked, isBookmarked }) {
  const isFolder = node.isInternal;
  const isMd = !isFolder && node.data.name.toLowerCase().endsWith('.md');
  const isImage = !isFolder && IMAGE_EXT_RE.test(node.data.name);
  const willReceiveDrop = isFolder && node.willReceiveDrop;

  const handleDragStart = (e) => {
    if (!isImage) return;
    beginSidebarImageDrag(node.id);
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

    // Block react-dnd's window-level dragstart handler from running. It
    // would otherwise override our drag image with getEmptyImage(), which
    // on macOS Electron falls back to dragging the source row — the
    // "stuck at the sidebar boundary" effect.
    e.stopPropagation();
  };
  const handleDragEnd = () => {
    if (isImage) endSidebarImageDrag();
  };

  const handleContextMenu = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isFolder) {
      const action = await window.api.showFolderContextMenu();
      if (!action) return;
      if (onFolderAction) onFolderAction(action, node.id);
      return;
    }

    const bookmarked = getIsBookmarked ? getIsBookmarked(node.id) : !!isBookmarked;
    const action = await window.api.showFileContextMenu({ isMd, isBookmarked: bookmarked });
    if (!action) return;
    if (action === FILE_ACTIONS.RENAME) {
      node.edit();
    } else if (onFileAction) {
      onFileAction(action, node.id);
    }
  };

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`tree-row ${node.isSelected ? 'selected' : ''} ${willReceiveDrop ? 'drop-target' : ''}`}
      onClick={() => {
        node.select();
        if (isFolder) node.toggle();
      }}
      onDoubleClick={() => !isFolder && node.edit()}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
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
