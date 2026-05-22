import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';

// Prompt window for the inline AI feature.
//
// Props:
//   open                      — controls visibility
//   action                    — 'ask' | 'rewrite' (drives the title + submit label)
//   defaultIncludeContext     — initial state of the "Include document" checkbox
//   onSubmit({ prompt, includeContext })  — fires on Submit / Cmd+Enter
//   onCancel                  — fires on Esc / backdrop / Cancel button
//
// Keyboard:
//   Esc       — cancel
//   Cmd+Enter — submit (Enter alone makes a newline, since the box is multi-line)

const TITLES = {
  insert: 'Insert AI Response',
  rewrite: 'Rewrite with AI',
};

const SUBMIT_LABELS = {
  insert: 'Insert',
  rewrite: 'Rewrite',
};

export default function InlineAiModal({
  open,
  action,
  defaultIncludeContext,
  onSubmit,
  onCancel,
}) {
  const [prompt, setPrompt] = useState('');
  const [includeContext, setIncludeContext] = useState(!!defaultIncludeContext);
  const textareaRef = useRef(null);

  // Reset state every time we open. Capture defaultIncludeContext at open time
  // so the user can toggle freely without their pick getting clobbered by re-renders.
  useEffect(() => {
    if (!open) return;
    setPrompt('');
    setIncludeContext(!!defaultIncludeContext);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open, defaultIncludeContext]);

  const submit = () => {
    const text = prompt.trim();
    if (!text) return;
    onSubmit({ prompt: text, includeContext });
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  if (!open) return null;

  const title = TITLES[action] ?? 'AI';
  const submitLabel = SUBMIT_LABELS[action] ?? 'Submit';

  const placeholder = action === 'rewrite'
    ? 'How should this passage be rewritten?'
    : 'What would you like inserted here?';

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="dialog-button" onClick={onCancel}>Cancel</button>
          <button
            className="dialog-button dialog-button-primary"
            onClick={submit}
            disabled={!prompt.trim()}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <textarea
        ref={textareaRef}
        className="inline-ai-textarea"
        value={prompt}
        placeholder={placeholder}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        rows={4}
        spellCheck
      />
      <label className="inline-ai-checkbox-row">
        <input
          type="checkbox"
          checked={includeContext}
          onChange={(e) => setIncludeContext(e.target.checked)}
        />
        <span>Include the rest of the document as context</span>
      </label>
      <div className="inline-ai-hint">⌘ + Enter to submit · Esc to cancel</div>
    </Dialog>
  );
}
