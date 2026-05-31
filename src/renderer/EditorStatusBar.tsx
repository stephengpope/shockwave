import React from 'react';
import { PencilIcon, CodeIcon, CheckCircleIcon, DotCircleIcon, RotateCcwIcon, RotateCwIcon, CloudCheckIcon, RefreshIcon, CloudAlertIcon } from './Icons.jsx';
import { VIEW_MODES, SAVE_STATES } from './constants.js';

function formatNum(n) {
  return n.toLocaleString();
}

// Map sync engine status → icon + color + animation + tooltip.
// 'disabled' returns null so the icon vanishes when the active workspace
// isn't sync-configured. When the engine knows the GitHub web URL we
// render the icon as a button that opens the repo via shell.openExternal.
function renderSyncIcon(syncStatus) {
  if (!syncStatus || syncStatus.status === 'disabled') return null;
  const { status, detail, lastSyncAt, repoUrl } = syncStatus;
  let icon = <CloudCheckIcon size={12} />;
  let cls = 'status-cloud-idle';
  let baseTitle = lastSyncAt
    ? `Synced ${Math.max(1, Math.round((Date.now() - lastSyncAt) / 1000))}s ago`
    : 'Synced';
  if (status === 'syncing') {
    icon = <RefreshIcon size={12} />;
    cls = 'status-cloud-syncing';
    baseTitle = detail || 'Syncing…';
  } else if (status === 'paused' || status === 'error') {
    icon = <CloudAlertIcon size={12} />;
    cls = 'status-cloud-error';
    baseTitle = detail || (status === 'paused' ? 'Sync paused' : 'Sync error');
  }
  if (repoUrl) {
    const title = `${baseTitle} — click to open ${repoUrl}`;
    return (
      <button
        type="button"
        className={`status-icon status-cloud ${cls} status-cloud-link`}
        title={title}
        aria-label={title}
        onClick={() => window.api.openExternal(repoUrl)}
      >
        {icon}
      </button>
    );
  }
  return (
    <span className={`status-icon status-cloud ${cls}`} title={baseTitle} aria-label={baseTitle}>
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
      {renderSyncIcon(syncStatus)}
    </div>
  );
}
