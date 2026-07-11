import React from 'react';
import { basenameOf, toRelPath } from './pathUtils';
import { XIcon, PlusIcon } from './Icons.jsx';
import { cn } from '@/lib/utils';

// Show the full filename incl. extension (Meeting.md, Notes.txt), matching the
// sidebar. prettyName (which strips .md) stays for wiki-link display only.
function shortLabel(path) {
  if (!path) return 'Untitled';
  return basenameOf(path);
}

export default function TabStrip({
  tabs,
  activeTabId,
  vaultPath,
  activeOverrideLabel,
  onSwitch,
  onClose,
  onAdd,
}) {
  return (
    <div className="flex items-end gap-1.5 border-b border-border bg-background px-3 pt-2">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = isActive && activeOverrideLabel
          ? activeOverrideLabel
          : shortLabel(tab.path);
        const tooltip = tab.path ? (toRelPath(tab.path, vaultPath) || basenameOf(tab.path)) : 'New tab';
        return (
          <div
            key={tab.id}
            className={cn(
              'group -mb-px flex cursor-pointer items-center gap-2 rounded-t-lg px-2.5 pb-2 pt-[7px] text-[12.5px]',
              isActive
                // "Folder tab": top-rounded, attached to the toolbar seam (§5).
                ? 'border border-b-0 border-border bg-background font-medium text-foreground'
                : 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => onSwitch(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            title={tooltip}
          >
            <span className="max-w-44 truncate">{label}</span>
            <button
              className={cn(
                'flex size-4 items-center justify-center rounded-sm text-muted-2',
                'hover:bg-accent hover:text-foreground',
                !isActive && 'opacity-0 group-hover:opacity-100',
              )}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              aria-label="Close tab"
            >
              <XIcon size={12} />
            </button>
          </div>
        );
      })}
      <button
        className="mb-1 flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onAdd}
        aria-label="New tab"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  );
}
