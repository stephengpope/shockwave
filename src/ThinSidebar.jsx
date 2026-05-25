import React from 'react';
import { PageIcon, FolderIcon, GraphIcon, CalendarIcon } from './Icons.jsx';

export default function ThinSidebar({
  onNewFile,
  onNewFolder,
  onOpenJournal,
  onJournalContextMenu,
  onToggleGraph,
  graphMode,
  disabled,
}) {
  // Day-of-month is read on render — no timer. The icon refreshes whenever the
  // parent re-renders (which happens constantly during user activity). If the
  // app sits fully idle across midnight, the day stays stale until any
  // interaction triggers a render. Acceptable for a glyph.
  const todayDay = new Date().getDate();

  return (
    <div className="thin-sidebar">
      <button
        className="thin-sidebar-btn"
        onClick={onNewFile}
        disabled={disabled}
        title="New file"
        aria-label="New file"
      >
        <PageIcon />
      </button>
      <button
        className="thin-sidebar-btn"
        onClick={onOpenJournal}
        onContextMenu={(e) => {
          e.preventDefault();
          if (disabled) return;
          onJournalContextMenu?.(e.clientX, e.clientY);
        }}
        disabled={disabled}
        title="Today's journal (right-click to pick a date)"
        aria-label="Today's journal"
      >
        <CalendarIcon day={todayDay} />
      </button>
      <button
        className="thin-sidebar-btn"
        onClick={onNewFolder}
        disabled={disabled}
        title="New folder"
        aria-label="New folder"
      >
        <FolderIcon />
      </button>
      <button
        className={`thin-sidebar-btn ${graphMode ? 'active' : ''}`}
        onClick={onToggleGraph}
        disabled={disabled}
        title={graphMode ? 'Back to editor' : 'Graph view'}
        aria-label="Toggle graph view"
      >
        <GraphIcon />
      </button>
    </div>
  );
}
