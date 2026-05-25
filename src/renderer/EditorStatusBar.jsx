import React from 'react';
import { PencilIcon, CodeIcon, CheckCircleIcon, DotCircleIcon } from './Icons.jsx';
import { VIEW_MODES, SAVE_STATES } from './constants.js';

function formatNum(n) {
  return n.toLocaleString();
}

/**
 * Editor status bar. Pure presentation — all state lives in App.
 *
 * Props:
 *   backlinkCount   number
 *   words           number
 *   chars           number
 *   viewMode        'live' | 'raw'
 *   onToggleViewMode()
 *   saveState       'saved' | 'unsaved'
 */
export default function EditorStatusBar({
  backlinkCount,
  words,
  chars,
  viewMode,
  onToggleViewMode,
  saveState,
}) {
  const isLive = viewMode === VIEW_MODES.LIVE;
  const isSaved = saveState === SAVE_STATES.SAVED;
  const toggleTitle = isLive ? 'Switch to raw markdown' : 'Switch to live preview';
  const toggleLabel = isLive ? 'Live preview' : 'Raw markdown';
  const saveTitle = isSaved ? 'All changes saved' : 'Saving…';

  return (
    <div className="editor-status-bar" role="status" aria-live="polite">
      <span className="status-item status-backlinks">
        {formatNum(backlinkCount)} {backlinkCount === 1 ? 'backlink' : 'backlinks'}
      </span>

      <button
        type="button"
        className="status-toggle"
        onClick={onToggleViewMode}
        title={toggleTitle}
        aria-label={toggleLabel}
        aria-pressed={isLive}
      >
        {isLive ? <PencilIcon size={12} /> : <CodeIcon size={12} />}
      </button>

      <span className="status-item">{formatNum(words)} words</span>
      <span className="status-item">{formatNum(chars)} characters</span>

      <span
        className={`status-icon status-sync ${isSaved ? 'status-sync-saved' : 'status-sync-pending'}`}
        title={saveTitle}
        aria-label={saveTitle}
      >
        {isSaved ? <CheckCircleIcon size={12} /> : <DotCircleIcon size={12} />}
      </span>
    </div>
  );
}
