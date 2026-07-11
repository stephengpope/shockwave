import React, { useState } from 'react';
import { TREE_SORT_ORDERS, TREE_SORT_LABELS } from './constants.js';
import { SearchIcon, SortIcon, CollapseAllIcon, BookmarkIcon, CloudAlertIcon } from './Icons.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const ORDER = [
  TREE_SORT_ORDERS.NAME_ASC,
  TREE_SORT_ORDERS.NAME_DESC,
  TREE_SORT_ORDERS.MODIFIED_DESC,
  TREE_SORT_ORDERS.MODIFIED_ASC,
  TREE_SORT_ORDERS.CREATED_DESC,
  TREE_SORT_ORDERS.CREATED_ASC,
];

// Group separators: a divider between Name/Modified/Created clusters.
const SEPARATOR_BEFORE = new Set([
  TREE_SORT_ORDERS.MODIFIED_DESC,
  TREE_SORT_ORDERS.CREATED_DESC,
]);

// 26px icon buttons with a shared hover chip (polish spec §4/§8).
const barBtn = cn(
  'flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground',
  'hover:bg-accent hover:text-foreground',
  'disabled:pointer-events-none disabled:opacity-40',
);
const barBtnActive = 'bg-selected text-primary hover:bg-selected hover:text-primary';

// Icon row pinned directly above the file tree, aligned with the tree's left
// edge. Icons only — search opens quick-search; sort opens a small menu where
// folders stay A→Z and the user picks how files within them are ordered.
export default function SortBar({
  value,
  onChange,
  onOpenQuickSearch,
  onCollapseAll,
  bookmarkFilterActive,
  onToggleBookmarkFilter,
  bookmarkItems,
  onPickBookmark,
  hasConflicts,
  conflictCount,
  conflictFilterActive,
  onToggleConflictFilter,
  onConflictCloudMenu,
  disabled,
}) {
  // The bookmark picker opens on RIGHT-click while left-click toggles the
  // filter, so it can't be a DropdownMenuTrigger (which owns left-click) —
  // a controlled Popover anchored to the button keeps both gestures.
  const [bmPickerOpen, setBmPickerOpen] = useState(false);

  // Picker rows come pre-resolved from App ({ name, dir, path }), already sorted
  // by name. The folder renders below the basename for context.
  const bookmarkRows = bookmarkItems ?? [];

  return (
    <div className="flex items-center gap-0.5 px-2.5 pb-2 pt-2.5">
      <Popover open={bmPickerOpen && !disabled} onOpenChange={setBmPickerOpen}>
        <PopoverAnchor asChild>
          <button
            type="button"
            className={cn(barBtn, bookmarkFilterActive && barBtnActive)}
            onClick={onToggleBookmarkFilter}
            onContextMenu={(e) => {
              e.preventDefault();
              if (disabled) return;
              setBmPickerOpen((v) => !v);
            }}
            disabled={disabled}
            title={bookmarkFilterActive ? 'Show all files (right-click to pick)' : 'Show bookmarks only (right-click to pick)'}
            aria-label="Toggle bookmark filter"
            aria-pressed={bookmarkFilterActive}
          >
            <BookmarkIcon size={15} filled={bookmarkFilterActive} />
          </button>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-64 p-1">
          {bookmarkRows.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No bookmarks</div>
          ) : (
            bookmarkRows.map((row) => (
              <button
                key={row.path}
                type="button"
                className="flex w-full flex-col items-start gap-0 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  setBmPickerOpen(false);
                  onPickBookmark?.(row.path);
                }}
              >
                <span className="text-[12.5px] text-foreground">{row.name}</span>
                {row.dir && <span className="text-[11px] text-muted-2">{row.dir}</span>}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        className={barBtn}
        onClick={onOpenQuickSearch}
        disabled={disabled}
        title="Quick search"
        aria-label="Quick search"
      >
        <SearchIcon size={15} />
      </button>
      {/* Sort stays available in bookmark mode — the bookmark list is flat but
          still honors the tree sort order. Collapse-all is folder-only, so it's
          hidden when the list is flattened to bookmarks. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(barBtn, 'data-[state=open]:bg-selected data-[state=open]:text-primary')}
            disabled={disabled}
            title={`Sort: ${TREE_SORT_LABELS[value] || TREE_SORT_LABELS[TREE_SORT_ORDERS.NAME_ASC]}`}
            aria-label="Sort files"
          >
            <SortIcon size={15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {ORDER.map((id) => (
              <React.Fragment key={id}>
                {SEPARATOR_BEFORE.has(id as any) && <DropdownMenuSeparator />}
                <DropdownMenuRadioItem value={id}>
                  {TREE_SORT_LABELS[id]}
                </DropdownMenuRadioItem>
              </React.Fragment>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {!bookmarkFilterActive && (
        <button
          type="button"
          className={barBtn}
          onClick={onCollapseAll}
          disabled={disabled}
          title="Collapse all"
          aria-label="Collapse all folders"
        >
          <CollapseAllIcon size={15} />
        </button>
      )}
      {/* Conflict view toggle — pinned to the far right (rarely used). */}
      {hasConflicts && (
        <button
          type="button"
          className={cn(
            barBtn,
            'ml-auto w-auto gap-1 px-1.5 text-destructive hover:text-destructive',
            conflictFilterActive && 'bg-destructive/10',
          )}
          onClick={onToggleConflictFilter}
          onContextMenu={(e) => { e.preventDefault(); onConflictCloudMenu?.(); }}
          title={conflictFilterActive
            ? 'Show all files (right-click for whole-tree actions)'
            : `${conflictCount} sync conflict${conflictCount === 1 ? '' : 's'} — click to resolve, right-click for whole-tree`}
          aria-label="Toggle conflict view"
          aria-pressed={conflictFilterActive}
        >
          <CloudAlertIcon size={15} />
          <span className="text-[11px] font-semibold">{conflictCount}</span>
        </button>
      )}
    </div>
  );
}
