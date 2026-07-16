import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import ConfirmDialog from '../ConfirmDialog.jsx';
import WorkspaceSyncDialog from './WorkspaceSyncDialog.jsx';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Button } from '@/components/ui/button';

export default function WorkspacesSection({
  workspaces,
  activeWorkspaceId,
  onAdd,
  onSwitch,
  onRemove,
  syncPat,
  pullIntervalSeconds,
  disabledWorkspaceIds,
  onSyncDisabledChange,
}) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<any>(null);
  const [syncWorkspaceId, setSyncWorkspaceId] = useState<any>(null);
  const target = workspaces.find((w) => w.id === confirmRemoveId) ?? null;
  const syncTarget = workspaces.find((w) => w.id === syncWorkspaceId) ?? null;

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const otherWorkspaces = workspaces.filter((w) => w.id !== activeWorkspaceId);

  const renderRow = (ws: any) => (
    <li
      key={ws.id}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{ws.name}</div>
        <div className="truncate font-mono text-xs text-muted-2" title={ws.path}>{ws.path}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSyncWorkspaceId(ws.id)}
          title={syncPat ? `Configure sync for ${ws.name}` : 'Set a PAT in GitHub Sync settings first'}
        >
          Sync…
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onSwitch(ws.id)}
          disabled={ws.id === activeWorkspaceId}
        >
          Open
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmRemoveId(ws.id)}
          title={`Remove ${ws.name}`}
          aria-label={`Remove ${ws.name}`}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );

  return (
    <SettingsSection
      wide
      title="Workspaces"
      description="Workspaces let you switch between different folders of files. Each workspace keeps its own files and link graph. The folder on disk is never modified by adding or removing a workspace from this list."
    >
      <SettingsGroup>
        <div>
          {/* The page's single primary action — row actions stay outline/ghost. */}
          <Button size="sm" onClick={onAdd}>
            <Plus /> Add workspace
          </Button>
        </div>
      </SettingsGroup>

      {workspaces.length === 0 ? (
        <SettingsGroup>
          <p className="text-[13px] text-muted-foreground">No workspaces yet.</p>
        </SettingsGroup>
      ) : (
        <>
          {activeWorkspace && (
            <SettingsGroup title="Active workspace">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{renderRow(activeWorkspace)}</ul>
            </SettingsGroup>
          )}
          {otherWorkspaces.length > 0 && (
            <SettingsGroup title="Other workspaces">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{otherWorkspaces.map(renderRow)}</ul>
            </SettingsGroup>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!target}
        title="Remove workspace"
        message={target ? `Remove "${target.name}" from this list? The folder on disk is not deleted.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { onRemove(confirmRemoveId); setConfirmRemoveId(null); }}
        onClose={() => setConfirmRemoveId(null)}
      />

      <WorkspaceSyncDialog
        open={!!syncTarget}
        workspace={syncTarget}
        syncPat={syncPat}
        activeWorkspaceId={activeWorkspaceId}
        pullIntervalSeconds={pullIntervalSeconds}
        disabledWorkspaceIds={disabledWorkspaceIds}
        onSyncDisabledChange={onSyncDisabledChange}
        onClose={() => setSyncWorkspaceId(null)}
      />
    </SettingsSection>
  );
}
