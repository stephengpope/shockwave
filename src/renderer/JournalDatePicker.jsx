import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';

// Anchored popover wrapping react-day-picker. Lets the underlying lib handle
// all the calendar math (timezones, DST, locale-first-day-of-week, etc).
// Closes on Esc or outside click. `anchor` is a {x, y} client-coords point.
export default function JournalDatePicker({ open, anchor, initialDate, onPick, onClose }) {
  const ref = useRef(null);
  const [month, setMonth] = useState(() => initialDate ?? new Date());
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!open) return;
    setMonth(initialDate ?? new Date());
  }, [open, initialDate]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !anchor) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width + margin > window.innerWidth) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = window.innerHeight - rect.height - margin;
    }
    left = Math.max(margin, left);
    top = Math.max(margin, top);
    setPos({ left, top });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="journal-popover"
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label="Pick a journal date"
    >
      <DayPicker
        mode="single"
        month={month}
        onMonthChange={setMonth}
        selected={initialDate ?? new Date()}
        onSelect={(d) => { if (d) onPick(d); }}
        showOutsideDays
        captionLayout="label"
      />
    </div>
  );
}
