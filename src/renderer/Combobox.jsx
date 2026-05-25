import React, { useEffect, useMemo, useRef, useState } from 'react';

// Generic combobox: text input + filtered dropdown of suggestions.
//
//   options:    array of strings to show in the dropdown
//   value:      the currently committed value (string)
//   onChange:   called with the new committed value
//   freeForm:   true  → any typed value is valid and committed on blur/Enter
//               false → blur/Escape revert to last committed value; Enter
//                       commits only if the draft matches an option exactly.
//
// Filtering is case-insensitive substring match against the input. Arrow
// keys move the highlight; Enter picks; Escape closes.
export default function Combobox({
  options,
  value,
  onChange,
  freeForm = false,
  placeholder = '',
  id,
  className = '',
}) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [highlight, setHighlight] = useState(0);

  useEffect(() => { setDraft(value ?? ''); }, [value]);

  const filtered = useMemo(() => {
    const q = (draft ?? '').trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [draft, options]);

  useEffect(() => { setHighlight(0); }, [draft, open]);

  const commit = (next) => {
    if (next === (value ?? '')) return;
    onChange(next);
  };

  // Revert to the last committed value (used when freeForm is false and
  // the user blurs/Escapes without picking a valid option).
  const revert = () => setDraft(value ?? '');

  // Close on outside click. Same commit semantics as blur.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        if (freeForm) commit(draft);
        else revert();
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, draft, value, freeForm]);

  const pick = (option) => {
    commit(option);
    setDraft(option);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = filtered[highlight];
      if (hit) pick(hit);
      else if (freeForm) { commit(draft); setOpen(false); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revert();
      setOpen(false);
    }
  };

  return (
    <div className={`combobox ${className}`} ref={rootRef}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        className="settings-input"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setDraft(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {open && filtered.length > 0 && (
        <ul className="combobox-menu" role="listbox">
          {filtered.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={o === value}
              className={`combobox-item ${i === highlight ? 'is-active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
