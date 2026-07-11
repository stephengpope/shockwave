import React from 'react';
import { Link as LinkIcon } from 'lucide-react';
import { PencilIcon, CodeIcon, CheckCircleIcon, DotCircleIcon, RotateCcwIcon, RotateCwIcon, CloudCheckIcon, CloudIcon, RefreshIcon, CloudAlertIcon, AlertTriangleIcon, StopIcon } from './Icons.jsx';
import { VIEW_MODES, SAVE_STATES } from './constants.js';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

function formatNum(n) {
  return n.toLocaleString();
}

// Shared 11.5px status-row icon button (polish spec §5: one quiet muted row).
const statusBtn = cn(
  'flex size-5 items-center justify-center rounded-sm text-muted-foreground',
  'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
);

// Sync status → one of six icons. `unconfigured` renders nothing (sync isn't
// set up). Disabled opens a click-popover (reason + Enable); conflicts open the
// resolve view; the rest open the repo when the URL is known.
//   not synced yet → gray cloud · idle → cloud-check · syncing → spinner
//   offline → cloud-alert (retrying) · conflicts → yellow triangle · disabled → stop
function SyncStatusIcon({ syncStatus, onOpenConflicts, onEnableSync }) {
  if (!syncStatus || syncStatus.status === 'unconfigured') return null;
  const { status, detail, lastSyncAt, repoUrl } = syncStatus;
  const conflictCount = syncStatus.conflicts?.length ?? 0;

  // Disabled (turned off, or a terminal error stopped it) → stop icon + popover.
  if (status === 'disabled') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(statusBtn, 'text-muted-2')}
            title="Sync disabled — click"
            aria-label="Sync disabled"
          >
            <StopIcon size={13} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-60 p-3">
          <div className="mb-2 text-xs text-muted-foreground">{detail || 'Sync is off'}</div>
          <Button size="xs" onClick={() => onEnableSync?.()}>Enable</Button>
        </PopoverContent>
      </Popover>
    );
  }

  // Conflicts → yellow triangle, click opens the resolve view.
  if (status === 'paused' && conflictCount > 0) {
    const title = `${conflictCount} conflict${conflictCount === 1 ? '' : 's'} — click to resolve`;
    return (
      <button
        type="button"
        className={cn(statusBtn, 'text-amber-600 hover:text-amber-600 dark:text-amber-400')}
        title={title}
        aria-label={title}
        onClick={onOpenConflicts}
      >
        <AlertTriangleIcon size={13} />
      </button>
    );
  }

  // idle (synced or not-synced-yet) / syncing / offline
  let icon, cls, title;
  if (status === 'syncing') {
    icon = <RefreshIcon size={13} />; cls = 'animate-spin text-muted-foreground'; title = detail || 'Syncing…';
  } else if (status === 'offline') {
    icon = <CloudAlertIcon size={13} />; cls = 'text-amber-600 dark:text-amber-400'; title = detail || "Can't reach GitHub — retrying";
  } else if (!lastSyncAt) {
    icon = <CloudIcon size={13} />; cls = 'text-muted-2'; title = 'Not synced yet';
  } else {
    icon = <CloudCheckIcon size={13} />; cls = 'text-success';
    title = `Synced ${Math.max(1, Math.round((Date.now() - lastSyncAt) / 1000))}s ago`;
  }
  if (repoUrl) {
    return (
      <button
        type="button"
        className={cn(statusBtn, cls)}
        title={`${title} — click to open ${repoUrl}`}
        aria-label={title}
        onClick={() => window.api.openExternal(repoUrl)}
      >
        {icon}
      </button>
    );
  }
  return (
    <span className={cn('flex size-5 items-center justify-center', cls)} title={title} aria-label={title}>
      {icon}
    </span>
  );
}

/**
 * Editor status bar. Pure presentation — all state lives in App.
 * One muted 11.5px row (polish spec §5): edit-history + view toggle icons,
 * divider, backlinks · words · characters, then save/sync state right-aligned.
 */
export default function EditorStatusBar({
  backlinkCount,
  showBacklinks,
  words,
  chars,
  viewMode,
  onToggleViewMode,
  showViewToggle,
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
    <div
      className="flex items-center gap-4 border-t border-border px-4 py-[5px] text-[11.5px] text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1">
        <button type="button" className={statusBtn} onClick={onUndo} disabled={!canUndo} title="Undo" aria-label="Undo">
          <RotateCcwIcon size={13} />
        </button>
        <button type="button" className={statusBtn} onClick={onRedo} disabled={!canRedo} title="Redo" aria-label="Redo">
          <RotateCwIcon size={13} />
        </button>
        {showViewToggle && (
          <button
            type="button"
            className={statusBtn}
            onClick={onToggleViewMode}
            title={toggleTitle}
            aria-label={toggleLabel}
            aria-pressed={isLive}
          >
            {isLive ? <PencilIcon size={13} /> : <CodeIcon size={13} />}
          </button>
        )}
      </div>

      <div className="h-3.5 w-px bg-border" />

      {showBacklinks && (
        <span className="flex items-center gap-1.5">
          <LinkIcon size={12} />
          {formatNum(backlinkCount)} {backlinkCount === 1 ? 'backlink' : 'backlinks'}
        </span>
      )}

      <span>{formatNum(words)} words</span>
      <span>{formatNum(chars)} characters</span>

      <span className="ml-auto flex items-center gap-2">
        <span
          className={cn('flex size-5 items-center justify-center', isSaved ? 'text-success' : 'text-muted-2')}
          title={saveTitle}
          aria-label={saveTitle}
        >
          {isSaved ? <CheckCircleIcon size={13} /> : <DotCircleIcon size={13} />}
        </span>
        <SyncStatusIcon syncStatus={syncStatus} onOpenConflicts={onOpenConflicts} onEnableSync={onEnableSync} />
      </span>
    </div>
  );
}
