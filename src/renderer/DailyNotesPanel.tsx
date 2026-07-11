import React from 'react';
import type { TreeNode } from '../shared/api';
import { treeRowClass, TreeFileIcon } from './FileTree.jsx';

interface DailyNotesPanelProps {
  items: TreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
}

// The workspace's daily notes, listed below the bookmarks when bookmark-filter
// mode is on and the Appearance toggle is enabled. Rendered as plain file rows
// (the same row look as the file browser above it) so navigating feels
// identical — just preceded by a section header. Items are pre-filtered (by the
// daily-note format/folder) and pre-sorted (by the active tree sort order) in
// App; this component is presentation only.
export default function DailyNotesPanel({ items, activePath, onOpen }: DailyNotesPanelProps) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="sidebar-list-header">Daily Notes</div>
      {items.map((it) => (
        <div
          key={it.id}
          className={treeRowClass(it.id === activePath)}
          title={it.id}
          onClick={() => onOpen(it.id)}
        >
          <span className="flex w-[13px] shrink-0 items-center" />
          <TreeFileIcon />
          <span className="truncate">{it.name}</span>
        </div>
      ))}
    </div>
  );
}
