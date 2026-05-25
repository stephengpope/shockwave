import React from 'react';

export default function EditorNav({ onBack, onForward, canGoBack, canGoForward }) {
  return (
    <div className="editor-nav">
      <button
        type="button"
        className="editor-nav-btn"
        onClick={onBack}
        disabled={!canGoBack}
        title="Back"
        aria-label="Back"
      >
        <span aria-hidden="true">←</span>
      </button>
      <button
        type="button"
        className="editor-nav-btn"
        onClick={onForward}
        disabled={!canGoForward}
        title="Forward"
        aria-label="Forward"
      >
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
