import React from 'react';
import { ArrowLeftIcon, ArrowRightIcon } from './Icons.jsx';

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
        <ArrowLeftIcon size={16} />
      </button>
      <button
        type="button"
        className="editor-nav-btn"
        onClick={onForward}
        disabled={!canGoForward}
        title="Forward"
        aria-label="Forward"
      >
        <ArrowRightIcon size={16} />
      </button>
    </div>
  );
}
