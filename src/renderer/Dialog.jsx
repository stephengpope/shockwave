import React, { useEffect, useRef } from 'react';

// Reusable dialog primitive.
//
// Behaviour:
//   - Esc closes (via onClose)
//   - Click on the backdrop (outside the panel) closes
//   - On open, focus moves into the panel (the first focusable element,
//     typically the primary button). On close, focus returns to whatever
//     element was focused before the dialog opened.
//
// Props:
//   open         — boolean, controls whether the dialog renders
//   onClose      — called when the user dismisses (Esc / backdrop)
//   title        — optional heading at the top of the panel
//   children     — body content
//   footer       — buttons / actions row at the bottom (typically <button>s)
//   labelledBy   — optional id of the element that labels the dialog (overrides title)

export default function Dialog({ open, onClose, title, children, footer, labelledBy }) {
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    // Move focus into the panel — prefer the first focusable element.
    const panel = panelRef.current;
    if (panel) {
      const focusable = panel.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? panel).focus({ preventScroll: true });
    }

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      previousFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  const titleId = title ? 'dialog-title' : undefined;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && <h2 id={titleId} className="dialog-title">{title}</h2>}
        {children !== undefined && <div className="dialog-body">{children}</div>}
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
