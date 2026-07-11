import React, { useEffect, useMemo, useState } from 'react';
import fuzzysort from 'fuzzysort';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

// Quick-search dialog on cmdk (shadcn Command). Empty query → top 10 entries
// by the current sort order. With a query → fuzzysort ranks every file by
// relevance; cmdk's own filtering is disabled (shouldFilter={false}) so
// fuzzysort stays the single ranking authority and match highlighting keeps
// working. Keyboard nav (arrows/Enter/Esc) comes from cmdk.
export default function QuickSearch({ open, tree, sortOrder, workspacePath, onPick, onClose }) {
  const [q, setQ] = useState('');

  useEffect(() => {
    if (open) setQ('');
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

  // results: [{ file, relPath, indexes }] — indexes are fuzzysort match
  // positions on relPath, used for highlighting; null for empty queries.
  const results = useMemo(() => {
    const query = q.trim();
    if (!query) {
      return indexedFiles.slice(0, DEFAULT_LIMIT).map((f) => ({ file: f, relPath: f.relPath, indexes: null }));
    }
    const ranked = fuzzysort.go(query, indexedFiles, { key: 'relPath', limit: 50 });
    return ranked.map((r) => ({ file: (r.obj as any), relPath: (r.obj as any).relPath, indexes: r.indexes }));
  }, [indexedFiles, q]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="top-[20%] translate-y-0 overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Quick search</DialogTitle>
          <DialogDescription>Find file by name</DialogDescription>
        </DialogHeader>
        {/* cmdk filtering off — fuzzysort is the single ranking authority. */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Find file by name…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList>
            <CommandEmpty>No matches</CommandEmpty>
            {results.map((r) => {
              const segs = segmentsFromIndexes(r.relPath, r.indexes);
              return (
                <CommandItem
                  key={r.file.id}
                  value={r.file.id}
                  onSelect={() => onPick(r.file.id)}
                >
                  <span className="truncate">
                    {segs.map((s, j) => s.match ? (
                      <strong key={j} className="font-semibold text-primary">{s.value}</strong>
                    ) : (
                      <span key={j}>{s.value}</span>
                    ))}
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
