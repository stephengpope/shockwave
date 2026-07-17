import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Tree } from 'react-arborist';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import { FILE_ACTIONS } from './constants.js';
import { SIDEBAR_IMAGE_MIME } from './imagePaste.js';
import { isOpenable } from './MediaView.js';
import { cn } from '@/lib/utils';

// Row visuals shared with TreePanel (same look as the file browser).
export const treeRowClass = (selected: boolean) => cn(
  // Extra left padding so the row fill / selection ring extends a few px past
  // the caret instead of hugging it.
  'flex h-6 cursor-pointer items-center gap-1.5 rounded-md pl-3 pr-2 text-[12.5px] text-foreground/85',
  'hover:bg-accent',
  selected && 'bg-accent',
);

export function TreeFileIcon() {
  return <FileText className="size-3.5 shrink-0 text-muted-2" strokeWidth={1.6} />;
}

export function TreeFolderIcon() {
  return <Folder className="size-[15px] shrink-0 fill-folder stroke-none" />;
}

const FileTree = forwardRef<any, any>(function FileTree(
  { data, onSelect, onRename, onFileAction, onFolderAction, onMoveItems, disableDrop, getIsBookmarked, conflictMode, checkRenameConflict, onRootContextMenu, contentSized, onImportFiles },
  ref,
) {
  const wrapRef = useRef<any>(null);
  const treeRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Visible row count for contentSized mode (folders closed ⇒ only their row
  // counts). Synced from react-arborist's visibleNodes after mount/data/toggle.
  const [visibleCount, setVisibleCount] = useState(() => data?.length ?? 0);
  const syncVisibleCount = useCallback(() => {
    setVisibleCount(treeRef.current?.visibleNodes?.length ?? 0);
  }, []);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (contentSized) syncVisibleCount();
  }, [contentSized, data, size.width, syncVisibleCount]);

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
    <div
      ref={wrapRef}
      className="tree-fill h-full w-full"
      // contentSized: the tree is as tall as its visible rows and the parent
      // (tree-wrap) owns the scroll, so anything below it (the quick-access
      // panel) sits directly beneath the last row and scrolls as one. Used in
      // bookmark mode and whenever the panel is shown. Otherwise the tree fills
      // its container and scrolls internally (ResizeObserver-driven height).
      style={contentSized ? { height: visibleCount * 24, flex: '0 0 auto' } : undefined}
      onContextMenu={(e) => {
        // Row Nodes stopPropagation on their own onContextMenu, so this only
        // fires on empty space below/around the tree rows.
        if (!onRootContextMenu) return;
        e.preventDefault();
        onRootContextMenu();
      }}
    >
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
          height={contentSized ? visibleCount * 24 : size.height}
          indent={16}
          rowHeight={24}
          onSelect={onSelect}
          onRename={onRename}
          onToggle={() => { if (contentSized) setTimeout(syncVisibleCount, 0); }}
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
              onImportFiles={onImportFiles}
              getIsBookmarked={getIsBookmarked}
              isBookmarked={getIsBookmarked ? getIsBookmarked(props.node.id) : false}
              conflictMode={conflictMode}
              checkRenameConflict={checkRenameConflict}
            />
          )}
        </Tree>
      )}
    </div>
  );
});

export default FileTree;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// Rename input. Files show the FULL literal name (incl. extension) — no `.md`
// hiding. Live collision check turns the field red (like the title bar) and
// blocks Enter; blur/Escape revert. Folders keep their plain behavior.
function RenameInput({ node, isFolder, checkRenameConflict }: any) {
  const [val, setVal] = useState(node.data.name);
  const conflict = !isFolder && checkRenameConflict ? checkRenameConflict(val, node.id) : false;
  return (
    <input
      autoFocus
      className={cn(
        'h-5 w-full min-w-0 rounded-sm border border-input bg-background px-1 text-[12.5px] outline-none focus:border-ring',
        conflict && 'border-destructive focus:border-destructive',
      )}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => node.reset()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') node.reset();
        if (e.key === 'Enter') {
          if (conflict) node.reset();
          else node.submit(e.currentTarget.value);
        }
      }}
    />
  );
}

function Node({ node, tree, style, dragHandle, onFileAction, onFolderAction, onImportFiles, getIsBookmarked, isBookmarked, conflictMode, checkRenameConflict }: any) {
  const isFolder = node.isInternal;
  const isImage = !isFolder && IMAGE_EXT_RE.test(node.data.name);
  const willReceiveDrop = isFolder && node.willReceiveDrop;

  // Accept OS file drags (Finder etc.) via react-dnd's NativeTypes.FILE —
  // rows render inside react-arborist's DndProvider, so this shares its
  // HTML5 backend. Folder rows import into the folder; file rows into their
  // parent folder. Copy semantics; App owns the actual import.
  const importDir = isFolder ? node.id : node.id.slice(0, node.id.lastIndexOf('/'));
  const [{ isFileOver }, fileDropRef] = useDrop(() => ({
    accept: [NativeTypes.FILE],
    canDrop: () => !!onImportFiles,
    drop: (item: any) => { onImportFiles?.(importDir, item.files); },
    collect: (m) => ({ isFileOver: m.isOver() && m.canDrop() }),
  }), [onImportFiles, importDir]);

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
      // Conflict view is review-only — folders are just grouping, no actions.
      if (conflictMode) return;
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
      // Deliberately do NOT select the row: selecting fires the tree's onSelect,
      // which opens/loads the file. A right-click should only show the menu —
      // the menu targets node.id directly, so no selection is needed.
      targetPaths = [node.id];
    }

    const allMd = targetPaths.every((p) => p.toLowerCase().endsWith('.md'));
    // "Open in new tab" is offered for any file the app can actually open
    // (.md + image/video/drawing), not just markdown.
    const allOpenable = targetPaths.every((p) => isOpenable(p));
    const allBookmarked = getIsBookmarked
      ? targetPaths.every((p) => getIsBookmarked(p))
      : !!isBookmarked;
    const action = await window.api.showFileContextMenu({
      isMd: allMd,
      isOpenable: allOpenable,
      isBookmarked: allBookmarked,
      selectionCount: targetPaths.length,
      conflictMode: !!conflictMode,
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
      ref={(el) => { dragHandle?.(el); fileDropRef(el); }}
      // react-arborist supplies the nesting indent as an inline paddingLeft,
      // which beats the class padding — fold the row's own 12px inset into it.
      style={{ ...style, paddingLeft: `${(parseFloat(style?.paddingLeft) || 0) + 12}px` }}
      className={cn(
        // Selected folders and files share the same quiet gray fill.
        treeRowClass(node.isSelected),
        (willReceiveDrop || isFileOver) && 'bg-selected',
      )}
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
      <span className="flex w-[13px] shrink-0 items-center">
        {isFolder && (node.isOpen
          ? <ChevronDown className="size-[11px] text-muted-2" strokeWidth={2.4} />
          : <ChevronRight className="size-[11px] text-muted-2" strokeWidth={2.4} />)}
      </span>
      {isFolder ? <TreeFolderIcon /> : <TreeFileIcon />}
      {node.isEditing ? (
        <RenameInput node={node} isFolder={isFolder} checkRenameConflict={checkRenameConflict} />
      ) : (
        <span className={cn('truncate', isFolder && 'font-medium')}>{node.data.name}</span>
      )}
    </div>
  );
}
