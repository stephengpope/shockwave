import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// Collect every folder path relative to the workspace root, sorted.
// '/' (root) is included as the first option.
function collectFolders(tree) {
  const out = ['/'];
  const walk = (nodes, prefix) => {
    for (const n of nodes) {
      if (!n.children) continue;
      const rel = (prefix ? `${prefix}/` : '') + n.name;
      out.push(rel);
      walk(n.children, rel);
    }
  };
  if (Array.isArray(tree)) walk(tree, '');
  // dedupe while preserving order
  return Array.from(new Set(out));
}

// Stored value '' means workspace root; UI shows it as '/'.
const ROOT_DISPLAY = '/';
const toDisplay = (v) => ((v ?? '') === '' ? ROOT_DISPLAY : v);
const toStored = (v) => (v === ROOT_DISPLAY ? '' : v);

// Combobox: freeform text input with a dropdown of existing workspace folders.
// `value` is workspace-relative ('' = root, otherwise a folder path). The
// input always displays '/' for root so the field is never visually blank.
export default function FolderCombobox({
  value,
  onChange,
  tree,
  workspacePath,
  placeholder = 'Example: folder 1/folder',
  id,
}) {
  const rootRef = useRef<any>(null);
  const inputRef = useRef<any>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => toDisplay(value));

  useEffect(() => { setDraft(toDisplay(value)); }, [value]);

  // Close on outside click. Commit the draft as a side effect.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        const stored = toStored(draft);
        if (stored !== (value ?? '')) onChange(stored);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, draft, value, onChange]);

  const folders = useMemo(() => collectFolders(tree), [tree, workspacePath]);
  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q || q === ROOT_DISPLAY) return folders;
    return folders.filter((f) => f.toLowerCase().includes(q));
  }, [draft, folders]);

  const pick = (folder) => {
    const stored = toStored(folder);
    onChange(stored);
    setDraft(toDisplay(stored));
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onChange(toStored(draft));
      setOpen(false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(toDisplay(value));
      setOpen(false);
    }
  };

  const activeOption = toDisplay(value);

  return (
    <div className="relative" ref={rootRef}>
      <Input
        ref={inputRef}
        id={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setDraft(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {open && filtered.length > 0 && (
        <ul
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          role="listbox"
        >
          {filtered.map((f) => (
            <li
              key={f}
              role="option"
              aria-selected={f === activeOption}
              className={cn(
                'cursor-pointer rounded-sm px-2 py-1.5 text-[13px] hover:bg-accent',
                f === activeOption && 'bg-accent font-medium'
              )}
              onMouseDown={(e) => { e.preventDefault(); pick(f); }}
            >
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
