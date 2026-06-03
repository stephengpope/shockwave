import React, { useEffect, useMemo, useRef, useState } from 'react';
import fuzzysort from 'fuzzysort';
import { TREE_SORT_ORDERS } from './constants.js';
import { isOpenable } from './MediaView';

const DEFAULT_LIMIT = 10;

// Flatten the (already-sorted) tree to a flat list of files. Folders are
// dropped, and so are file types the app won't open (only .md + image/video) —
// no point surfacing a result that does nothing when picked.
function flattenFiles(nodes, out: any[] = []) {
  for (const n of nodes) {
    if (n.children) flattenFiles(n.children, out);
    else if (isOpenable(n.id)) out.push(n);
  }
  return out;
}

// Apply the current sort order to a flat file list. Used only when there's no
// query — fuzzysort scoring takes over once the user starts typing.
function sortFiles(files, order) {
  const cmpName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const sorted = files.slice();
  switch (order) {
    case TREE_SORT_ORDERS.NAME_DESC: sorted.sort((a, b) => cmpName(b, a)); break;
    case TREE_SORT_ORDERS.MODIFIED_DESC: sorted.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)); break;
    case TREE_SORT_ORDERS.MODIFIED_ASC: sorted.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0)); break;
    case TREE_SORT_ORDERS.CREATED_DESC: sorted.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)); break;
    case TREE_SORT_ORDERS.CREATED_ASC: sorted.sort((a, b) => (a.ctime ?? 0) - (b.ctime ?? 0)); break;
    case TREE_SORT_ORDERS.NAME_ASC:
    default: sorted.sort(cmpName);
  }
  return sorted;
}

// Split a string into <strong>/plain segments based on fuzzysort's matched
// character indexes (which are sorted ascending). Contiguous runs of matched
// chars collapse into a single <strong>.
function segmentsFromIndexes(text, indexes) {
  if (!indexes || indexes.length === 0) return [{ match: false, value: text }];
  const segs: any[] = [];
  let cursor = 0;
  for (let i = 0; i < indexes.length;) {
    const start = indexes[i];
    if (start > cursor) segs.push({ match: false, value: text.slice(cursor, start) });
    let end = start;
    while (i < indexes.length && indexes[i] === end) { end++; i++; }
    segs.push({ match: true, value: text.slice(start, end) });
    cursor = end;
  }
  if (cursor < text.length) segs.push({ match: false, value: text.slice(cursor) });
  return segs;
}

// Quick-search dialog. Empty query → top 10 entries by the current sort order.
// With a query → fuzzysort ranks every file by relevance (characters-in-order
// matching, with bonuses for contiguous runs, word boundaries, and matches at
// the start of the basename), and all matches are scrollable.
export default function QuickSearch({ open, tree, sortOrder, workspacePath, onPick, onClose }) {
  const inputRef = useRef<any>(null);
  const listRef = useRef<any>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Pre-compute workspace-relative paths so fuzzysort matches against
  // `folder/sub/file.md` (lets users type `j/2026` to find `Journal/2026-05-24.md`).
  const indexedFiles = useMemo(() => {
    const flat = flattenFiles(tree);
    const sorted = sortFiles(flat, sortOrder);
    return sorted.map((f) => ({
      ...f,
      relPath: (workspacePath && f.id.startsWith(workspacePath + '/'))
        ? f.id.slice(workspacePath.length + 1)
        : f.id,
    }));
  }, [tree, sortOrder, workspacePath]);

  // results: [{ file, relPath, indexes }]
  // - indexes is the fuzzysort match positions on relPath, used for highlighting.
  // - For empty queries we synthesize entries with no indexes.
  const results = useMemo(() => {
    const query = q.trim();
    if (!query) {
      return indexedFiles.slice(0, DEFAULT_LIMIT).map((f) => ({ file: f, relPath: f.relPath, indexes: null }));
    }
    const ranked = fuzzysort.go(query, indexedFiles, { key: 'relPath', limit: 50 });
    return ranked.map((r) => ({ file: (r.obj as any), relPath: (r.obj as any).relPath, indexes: r.indexes }));
  }, [indexedFiles, q]);

  useEffect(() => { setActive(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const el = list.children[active];
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  // Keyboard handler is attached once per open/close, not per keystroke.
  // Dynamic state (results, active, callbacks) is read through refs inside
  // the handler so this effect doesn't tear down on every render.
  const resultsRef = useRef(results);
  useEffect(() => { resultsRef.current = results; }, [results]);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, resultsRef.current.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = resultsRef.current[activeRef.current];
        if (pick) onPickRef.current(pick.file.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop quick-search-backdrop" onMouseDown={onClose}>
      <div
        className="quick-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Quick search"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="quick-search-input"
          placeholder="Find file by name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {results.length === 0 ? (
          <div className="quick-search-empty">No matches</div>
        ) : (
          <ul ref={listRef} className={`quick-search-list ${q.trim() ? 'is-scroll' : ''}`} role="listbox">
            {results.map((r, i) => {
              const segs = segmentsFromIndexes(r.relPath, r.indexes);
              return (
                <li
                  key={r.file.id}
                  role="option"
                  aria-selected={i === active}
                  className={`quick-search-item ${i === active ? 'is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); onPick(r.file.id); }}
                >
                  <span className="quick-search-path">
                    {segs.map((s, j) => s.match ? (
                      <strong key={j} className="quick-search-match">{s.value}</strong>
                    ) : (
                      <span key={j}>{s.value}</span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
