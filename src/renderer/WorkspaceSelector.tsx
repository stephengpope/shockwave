import React from 'react';
import { Check } from 'lucide-react';
import { GearIcon, ChevronDownIcon } from './Icons.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export default function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onManage,
  onOpenSettings,
}) {
  const active = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const badgeLetter = (active?.name ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="flex items-center justify-between border-t border-border px-2.5 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-foreground',
              'hover:bg-accent data-[state=open]:bg-accent',
            )}
            title={active?.path ?? 'No workspace open'}
          >
            {/* Square accent workspace badge (polish spec §4). */}
            <span className="flex size-[18px] items-center justify-center rounded-[5px] bg-primary text-[9px] font-bold text-primary-foreground">
              {badgeLetter}
            </span>
            <span className="max-w-40 truncate text-[12.5px] font-medium">
              {active ? active.name : 'No workspace'}
            </span>
            <ChevronDownIcon size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          {workspaces.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No workspaces yet</div>
          ) : (
            workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onSelect={() => onSwitch(w.id)} title={w.path}>
                <span className="truncate">{w.name}</span>
                {w.id === activeWorkspaceId && <Check className="ml-auto" />}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onManage}>Manage workspaces…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        className="flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Open settings"
      >
        <GearIcon size={15} />
      </button>
    </div>
  );
}
