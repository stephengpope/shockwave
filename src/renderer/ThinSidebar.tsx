import React from 'react';
import { Clock } from 'lucide-react';
import { PageIcon, FolderIcon, GraphIcon, CalendarIcon, TemplateIcon } from './Icons.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// 34px icon buttons on the chrome-colored rail (polish spec §4/§8).
const railBtn = cn(
  'flex size-[34px] items-center justify-center rounded-lg text-muted-foreground',
  'hover:bg-accent hover:text-foreground',
  'disabled:pointer-events-none disabled:opacity-40',
);
const railBtnActive = 'bg-selected text-primary hover:bg-selected hover:text-primary';

export default function ThinSidebar({
  onNewFile,
  onNewFolder,
  onOpenJournal,
  onJournalContextMenu,
  onToggleGraph,
  graphMode,
  templates = [] as Array<{ name: string; path: string }>,
  onPickTemplate,
  onOpenCron,
  cronBadge = 'none' as 'none' | 'on' | 'error',
  disabled,
}) {
  // Day-of-month is read on render — no timer. The icon refreshes whenever the
  // parent re-renders (which happens constantly during user activity). If the
  // app sits fully idle across midnight, the day stays stale until any
  // interaction triggers a render. Acceptable for a glyph.
  const todayDay = new Date().getDate();

  return (
    <div className="flex flex-col items-center gap-[3px] border-r border-border bg-chrome pt-3">
      <button
        className={railBtn}
        onClick={onNewFile}
        disabled={disabled}
        title="New file"
        aria-label="New file"
      >
        <PageIcon />
      </button>
      <button
        className={railBtn}
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
        className={railBtn}
        onClick={onNewFolder}
        disabled={disabled}
        title="New folder"
        aria-label="New folder"
      >
        <FolderIcon />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(railBtn, 'data-[state=open]:bg-selected data-[state=open]:text-primary')}
            disabled={disabled}
            title="Insert template"
            aria-label="Insert template"
          >
            <TemplateIcon />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          {templates.length === 0 ? (
            <div className="max-w-56 px-2 py-1.5 text-xs text-muted-foreground">
              No templates — set a folder in Settings → Templates
            </div>
          ) : (
            templates.map((t) => (
              <DropdownMenuItem key={t.path} onSelect={() => onPickTemplate?.(t.path)}>
                {t.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        className={cn(railBtn, graphMode && railBtnActive)}
        onClick={onToggleGraph}
        disabled={disabled}
        title={graphMode ? 'Back to editor' : 'Graph view'}
        aria-label="Toggle graph view"
      >
        <GraphIcon />
      </button>
      <button
        className={cn(railBtn, 'relative')}
        onClick={onOpenCron}
        disabled={disabled}
        title="Scheduled Jobs"
        aria-label="Scheduled Jobs"
      >
        <Clock className="size-[18px]" />
        {cronBadge !== 'none' && (
          <span
            className={cn(
              'absolute right-1.5 top-1.5 size-2 rounded-full ring-2 ring-chrome',
              cronBadge === 'error' ? 'bg-amber-500' : 'bg-primary',
            )}
          />
        )}
      </button>
    </div>
  );
}
