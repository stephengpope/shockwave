import React from 'react';
import type { TreeNode } from '../shared/api';
import { treeRowClass, TreeFileIcon } from './FileTree.jsx';

interface TreePanelProps {
  title: string;
  items: TreeNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
}

// One section of the quick-access panel pinned below the file tree ("Recent
// Files" / "Daily Notes", per the Appearance → treePanel setting). Rendered as
// plain file rows (the same row look as the file browser above it) so
// navigating feels identical — just preceded by a section header. Items are
// pre-filtered, pre-sorted (modified desc), and pre-capped in App; this
// component is presentation only.
export default function TreePanel({ title, items, activePath, onOpen }: TreePanelProps) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-2">{title}</div>
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
