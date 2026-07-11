import React, { useState } from 'react';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Button } from '@/components/ui/button';

// Maintenance actions that don't belong to any one feature section.
//
// "Rebuild link cache" is the UI for the `fs:rebuildLinkCache` escape hatch:
// it discards the persisted parse cache (userData/link-cache/<hash>.json) and
// re-parses every .md in the active workspace from scratch, then rebuilds the
// in-memory link index. Normally unnecessary — the cache self-validates on
// mtime + size — but it's the recovery path if the index ever drifts from disk
// (e.g. after an external tool rewrites files in ways the watcher missed).
export default function AdvancedSection({ hasWorkspace, onRebuildCache }) {
  const [state, setState] = useState('idle'); // 'idle' | 'running' | 'done' | 'error'
  const [count, setCount] = useState(0);

  const onClick = async () => {
    if (state === 'running') return;
    setState('running');
    try {
      const res = await onRebuildCache?.();
      if (res?.ok) {
        setCount(res.count ?? 0);
        setState('done');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  };

  return (
    <SettingsSection
      title="Advanced"
      description="Maintenance actions for this workspace. You shouldn't normally need these."
    >
      <SettingsGroup title="Link cache">
        <p className="text-xs text-muted-foreground">
          The link index (wiki-links, backlinks, graph) is cached per file and
          re-parses only what changed on each launch. Rebuild it if links,
          backlinks, or the graph ever look out of sync with your files.
        </p>

        <Button
          size="sm"
          className="w-fit"
          onClick={onClick}
          disabled={!hasWorkspace || state === 'running'}
        >
          {state === 'running' ? 'Rebuilding…' : 'Rebuild link cache'}
        </Button>
        {!hasWorkspace && (
          <p className="text-xs text-muted-foreground">Open a workspace first.</p>
        )}
        {state === 'done' && (
          <p className="text-xs text-primary">
            Rebuilt — re-parsed {count} file{count === 1 ? '' : 's'}.
          </p>
        )}
        {state === 'error' && (
          <p className="text-xs text-destructive">
            Rebuild failed. Check the logs.
          </p>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
