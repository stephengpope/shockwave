import React, { useEffect, useRef, useState } from 'react';

// Modal for "Add external link" / "Edit external link".
//
// Add mode:  initialUrl / initialText omitted → only URL field, submits string.
// Edit mode: initialUrl + initialText provided → both fields, submits
//            { url, text }.
//
// The caller's onSubmit always receives an object so the call site can
// destructure cleanly; in Add mode `text` is undefined.
export default function UrlPromptModal({ onSubmit, onCancel, initialUrl, initialText }) {
  const isEdit = initialText !== undefined;
  const [url, setUrl] = useState(initialUrl ?? '');
  const [text, setText] = useState(initialText ?? '');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (isEdit) {
      // Pre-fill from props; select the URL so users can quickly retype.
      requestAnimationFrame(() => inputRef.current?.select());
      return;
    }
    // Pre-fill from clipboard for the Add case — saves the user a paste.
    if (navigator.clipboard?.readText) {
      navigator.clipboard.readText().then((clip) => {
        const trimmed = (clip ?? '').trim();
        if (/^https?:\/\/\S+$/i.test(trimmed)) {
          setUrl(trimmed);
          requestAnimationFrame(() => inputRef.current?.select());
        }
      }).catch(() => { /* clipboard access denied — fine */ });
    }
  }, [isEdit]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = (e) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    onSubmit({ url: trimmedUrl, text: isEdit ? text : undefined });
  };

  return (
    <div className="url-prompt-backdrop" onClick={onCancel}>
      <div className="url-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          {isEdit && (
            <>
              <label className="url-prompt-label" htmlFor="url-prompt-text">Link text</label>
              <input
                id="url-prompt-text"
                className="url-prompt-input"
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
          <label className="url-prompt-label" htmlFor="url-prompt-input">External link URL</label>
          <input
            id="url-prompt-input"
            ref={inputRef}
            className="url-prompt-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            autoComplete="off"
            spellCheck={false}
          />
          <div className="url-prompt-actions">
            <button type="button" className="url-prompt-cancel" onClick={onCancel}>Cancel</button>
            <button type="submit" className="url-prompt-ok" disabled={!url.trim()}>
              {isEdit ? 'Save' : 'Add link'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
