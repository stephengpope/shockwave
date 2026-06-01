import React, { useEffect, useRef, useState } from 'react';
import { PencilIcon, CodeIcon, CheckCircleIcon, DotCircleIcon, RotateCcwIcon, RotateCwIcon, CloudCheckIcon, CloudIcon, RefreshIcon, CloudAlertIcon, AlertTriangleIcon, StopIcon } from './Icons.jsx';
import { VIEW_MODES, SAVE_STATES } from './constants.js';

function formatNum(n) {
  return n.toLocaleString();
}

// Sync status → one of six icons. `unconfigured` renders nothing (sync isn't
// set up). Disabled opens a click-popover (reason + Enable); conflicts open the
// resolve view; the rest open the repo when the URL is known.
//   not synced yet → gray cloud · idle → cloud-check · syncing → spinner
//   offline → cloud-alert (retrying) · conflicts → yellow triangle · disabled → stop
function SyncStatusIcon({ syncStatus, onOpenConflicts, onEnableSync }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const anchorRef = useRef<any>(null);
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e) => { if (anchorRef.current && !anchorRef.current.contains(e.target)) setPopoverOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [popoverOpen]);

  if (!syncStatus || syncStatus.status === 'unconfigured') return null;
  const { status, detail, lastSyncAt, repoUrl } = syncStatus;
  const conflictCount = syncStatus.conflicts?.length ?? 0;

  // Disabled (turned off, or a terminal error stopped it) → stop icon + popover.
  if (status === 'disabled') {
    return (
      <span className="sync-icon-anchor" ref={anchorRef}>
        <button
          type="button"
          className="status-icon status-cloud status-cloud-disabled status-cloud-link"
          title="Sync disabled — click"
          aria-label="Sync disabled"
          onClick={() => setPopoverOpen((v) => !v)}
        >
          <StopIcon size={12} />
        </button>
        {popoverOpen && (
          <div className="sync-disabled-popover" role="dialog">
            <div className="sync-disabled-reason">{detail || 'Sync is off'}</div>
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => { setPopoverOpen(false); onEnableSync?.(); }}
            >
              Enable
            </button>
          </div>
        )}
      </span>
    );
  }

  // Conflicts → yellow triangle, click opens the resolve view.
  if (status === 'paused' && conflictCount > 0) {
    const title = `${conflictCount} conflict${conflictCount === 1 ? '' : 's'} — click to resolve`;
    return (
      <button
        type="button"
        className="status-icon status-cloud status-cloud-conflict status-cloud-link"
        title={title}
        aria-label={title}
        onClick={onOpenConflicts}
      >
        <AlertTriangleIcon size={12} />
      </button>
    );
  }

  // idle (synced or not-synced-yet) / syncing / offline
  let icon, cls, title;
  if (status === 'syncing') {
    icon = <RefreshIcon size={12} />; cls = 'status-cloud-syncing'; title = detail || 'Syncing…';
  } else if (status === 'offline') {
    icon = <CloudAlertIcon size={12} />; cls = 'status-cloud-offline'; title = detail || "Can't reach GitHub — retrying";
  } else if (!lastSyncAt) {
    icon = <CloudIcon size={12} />; cls = 'status-cloud-pending'; title = 'Not synced yet';
  } else {
    icon = <CloudCheckIcon size={12} />; cls = 'status-cloud-idle';
    title = `Synced ${Math.max(1, Math.round((Date.now() - lastSyncAt) / 1000))}s ago`;
  }
  if (repoUrl) {
    return (
      <button
        type="button"
        className={`status-icon status-cloud ${cls} status-cloud-link`}
        title={`${title} — click to open ${repoUrl}`}
        aria-label={title}
        onClick={() => window.api.openExternal(repoUrl)}
      >
        {icon}
      </button>
    );
  }
  return (
    <span className={`status-icon status-cloud ${cls}`} title={title} aria-label={title}>
      {icon}
    </span>
  );
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
 *   canUndo / canRedo / onUndo / onRedo  — edit-history controls
 */
export default function EditorStatusBar({
  backlinkCount,
  words,
  chars,
  viewMode,
  onToggleViewMode,
  saveState,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  syncStatus,
  onOpenConflicts,
  onEnableSync,
}) {
  const isLive = viewMode === VIEW_MODES.LIVE;
  const isSaved = saveState === SAVE_STATES.SAVED;
  const toggleTitle = isLive ? 'Switch to raw markdown' : 'Switch to live preview';
  const toggleLabel = isLive ? 'Live preview' : 'Raw markdown';
  const saveTitle = isSaved ? 'All changes saved' : 'Saving…';

  return (
    <div className="editor-status-bar" role="status" aria-live="polite">
      <button
        type="button"
        className="status-toggle"
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo"
        aria-label="Undo"
      >
        <RotateCcwIcon size={12} />
      </button>
      <button
        type="button"
        className="status-toggle"
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo"
        aria-label="Redo"
      >
        <RotateCwIcon size={12} />
      </button>

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

      <span className="status-item status-backlinks">
        {formatNum(backlinkCount)} {backlinkCount === 1 ? 'backlink' : 'backlinks'}
      </span>

      <span className="status-item">{formatNum(words)} words</span>
      <span className="status-item">{formatNum(chars)} characters</span>

      <span
        className={`status-icon status-sync ${isSaved ? 'status-sync-saved' : 'status-sync-pending'}`}
        title={saveTitle}
        aria-label={saveTitle}
      >
        {isSaved ? <CheckCircleIcon size={12} /> : <DotCircleIcon size={12} />}
      </span>
      <SyncStatusIcon syncStatus={syncStatus} onOpenConflicts={onOpenConflicts} onEnableSync={onEnableSync} />
    </div>
  );
}
