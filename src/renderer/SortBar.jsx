import React, { useEffect, useRef, useState } from 'react';
import { TREE_SORT_ORDERS, TREE_SORT_LABELS } from './constants.js';
import { SearchIcon, SortIcon, CollapseAllIcon, BookmarkIcon } from './Icons.jsx';

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
  bookmarks,
  workspacePath,
  onPickBookmark,
  disabled,
}) {
  const rootRef = useRef(null);
  const bookmarkBtnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [bmPickerOpen, setBmPickerOpen] = useState(false);

  useEffect(() => {
    if (!open && !bmPickerOpen) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        setBmPickerOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setBmPickerOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, bmPickerOpen]);

  // Compose [{abs, rel, name}] sorted by name for the picker. Workspace-
  // relative path renders below the basename so users can disambiguate two
  // files of the same name in different folders.
  const bookmarkRows = (() => {
    const arr = bookmarks ? Array.from(bookmarks) : [];
    return arr
      .map((abs) => {
        const rel = (workspacePath && abs.startsWith(workspacePath + '/'))
          ? abs.slice(workspacePath.length + 1)
          : abs;
        const slash = rel.lastIndexOf('/');
        const name = slash >= 0 ? rel.slice(slash + 1) : rel;
        const dir = slash >= 0 ? rel.slice(0, slash) : '';
        return { abs, rel, name, dir };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  })();

  return (
    <div className="sort-bar" ref={rootRef}>
      <button
        ref={bookmarkBtnRef}
        type="button"
        className={`sort-bar-icon-btn ${bookmarkFilterActive ? 'is-active' : ''}`}
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
        <BookmarkIcon size={16} filled={bookmarkFilterActive} />
      </button>
      {bmPickerOpen && !disabled && (
        <ul className="bookmark-picker" role="listbox">
          {bookmarkRows.length === 0 ? (
            <li className="bookmark-picker-empty">No bookmarks</li>
          ) : (
            bookmarkRows.map((row) => (
              <li
                key={row.abs}
                role="option"
                className="bookmark-picker-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setBmPickerOpen(false);
                  onPickBookmark?.(row.abs);
                }}
              >
                <span className="bookmark-picker-name">{row.name}</span>
                {row.dir && <span className="bookmark-picker-dir">{row.dir}</span>}
              </li>
            ))
          )}
        </ul>
      )}
      <button
        type="button"
        className="sort-bar-icon-btn"
        onClick={onOpenQuickSearch}
        disabled={disabled}
        title="Quick search"
        aria-label="Quick search"
      >
        <SearchIcon size={16} />
      </button>
      {!bookmarkFilterActive && (
        <>
          <button
            type="button"
            className="sort-bar-icon-btn"
            onClick={() => setOpen((o) => !o)}
            disabled={disabled}
            title={`Sort: ${TREE_SORT_LABELS[value] || TREE_SORT_LABELS[TREE_SORT_ORDERS.NAME_ASC]}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Sort files"
          >
            <SortIcon size={16} />
          </button>
          <button
            type="button"
            className="sort-bar-icon-btn"
            onClick={onCollapseAll}
            disabled={disabled}
            title="Collapse all"
            aria-label="Collapse all folders"
          >
            <CollapseAllIcon size={16} />
          </button>
        </>
      )}
      {open && !disabled && (
        <ul className="sort-bar-menu" role="listbox">
          {ORDER.map((id) => (
            <React.Fragment key={id}>
              {SEPARATOR_BEFORE.has(id) && <li className="sort-bar-divider" role="separator" />}
              <li
                role="option"
                aria-selected={id === value}
                className={`sort-bar-item ${id === value ? 'is-active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onChange(id); setOpen(false); }}
              >
                {TREE_SORT_LABELS[id]}
              </li>
            </React.Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
