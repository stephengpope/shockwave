import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ChevronRight } from 'lucide-react';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import type { CronView } from '../../shared/api';

// CONFIG only — the master on/off + windows. The live schedule (jobs, next-run,
// Run-now) is the in-app experience: Settings links out to it, it doesn't live
// here. (See CronModal.)
export default function CronSection({ onOpenCronPanel }: { onOpenCronPanel?: () => void }) {
  const [view, setView] = useState<CronView | null>(null);

  const refresh = useCallback(async () => {
    try { setView(await window.api.cron.read()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refresh();
    return window.api.cron.onState((v) => setView(v));
  }, [refresh]);

  const setEnabled = useCallback(async (v: boolean) => { await window.api.cron.setEnabled(v); void refresh(); }, [refresh]);

  return (
    <SettingsSection
      title="Cron Settings"
      description="Run the coding agent on a schedule for the active workspace. This master switch is global (machine-local); the individual jobs live in cron.json at each workspace root, and you manage / run them from the schedule view."
    >
      <SettingsGroup>
        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
          <div>
            <div className="text-[13px] font-medium">Run scheduled tasks</div>
            <div className="text-xs text-muted-foreground">
              When on, due tasks for the active workspace run automatically.
            </div>
          </div>
          <Switch checked={!!view?.enabled} onCheckedChange={setEnabled} aria-label="Enable scheduled tasks" />
        </div>
      </SettingsGroup>

      {onOpenCronPanel && (
        <SettingsGroup>
          <button
            type="button"
            onClick={onOpenCronPanel}
            className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-left hover:bg-accent"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <CalendarClock className="size-4 text-muted-foreground" /> Scheduled Jobs
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </button>
        </SettingsGroup>
      )}

      <SettingsGroup>
        <div className="flex items-center gap-6 px-1 text-xs text-muted-foreground">
          <label className="flex items-center gap-1.5">
            Catch-up window
            <Input type="number" min={1} max={720} className="h-7 w-16"
              defaultValue={view?.maxCatchupHours ?? 36}
              onBlur={(e) => window.api.cron.setMaxCatchupHours(Number(e.currentTarget.value))} />h
          </label>
          <label className="flex items-center gap-1.5">
            Max run
            <Input type="number" min={1} max={240} className="h-7 w-16"
              defaultValue={view?.maxRunMinutes ?? 30}
              onBlur={(e) => window.api.cron.setMaxRunMinutes(Number(e.currentTarget.value))} />min
          </label>
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          Catch-up window: a missed run fires only if it's less than this many hours overdue.
          Max run: a scheduled run is aborted if it exceeds this many minutes.
        </p>
      </SettingsGroup>
    </SettingsSection>
  );
}
