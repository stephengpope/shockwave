import React, { useEffect, useRef } from 'react';

export default function EditorTitle({ value, onChange, onCommit, conflict }) {
  const inputRef = useRef<any>(null);
  const lastCommittedRef = useRef(value);

  // Only refresh the baseline when the value changes externally — e.g. the
  // active file switched, or the file was renamed. While the input is focused
  // (user typing), keep the baseline stable so commit() can detect changes.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      lastCommittedRef.current = value;
    }
  }, [value]);

  const commit = () => {
    // If there's a name conflict, blurring should revert (matches Obsidian).
    if (conflict) {
      onChange(lastCommittedRef.current);
      return;
    }
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      onChange(lastCommittedRef.current);
      return;
    }
    if (trimmed === lastCommittedRef.current) return;
    onCommit(trimmed);
  };

  const cancel = () => {
    onChange(lastCommittedRef.current);
    inputRef.current?.blur();
  };

  return (
    <input
      ref={inputRef}
      className={`block w-full shrink-0 border-none bg-transparent px-(--text-col-left) pb-5 pt-4 text-[30px] font-bold leading-[1.2] text-foreground outline-none focus:bg-primary/5 ${conflict ? 'text-destructive' : ''}`}
      value={value}
      placeholder="Untitled"
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => { lastCommittedRef.current = value; }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // With a conflict, keep focus and let the user fix it.
          if (conflict) return;
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      spellCheck={false}
    />
  );
}
