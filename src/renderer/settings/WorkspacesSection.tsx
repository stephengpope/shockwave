import React, { useEffect, useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import ConfirmDialog from '../ConfirmDialog.jsx';
import AddWorkspaceDialog from './AddWorkspaceDialog';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import ErrorMessage from '../ErrorMessage.jsx';

// Workspaces — just the list and the ways in and out of it. The account, the
// sync interval, and the git check live in GitHubSection: none of them is per
// workspace, and stacking three global controls above the list pushed the
// workspaces themselves below the fold.
//
// The PAT is still required to add one. What the old split got wrong wasn't
// that the token lived elsewhere — it's that this page left you to find it on
// your own. The add dialog links straight there now.

export default function WorkspacesSection({
  workspaces,
  activeWorkspaceId,
  onWorkspaceAdded,
  onSwitch,
  onRemove,
  onRename,
  syncPat,
  onOpenGitHubSettings,
  disabledWorkspaceIds,
  onSyncDisabledChange,
}) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<any>(null);
  const [renamingId, setRenamingId] = useState<any>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [settingUpId, setSettingUpId] = useState<any>(null);
  const [setupError, setSetupError] = useState<any>(null);
  const [addOpen, setAddOpen] = useState(false);

  const target = workspaces.find((w) => w.id === confirmRemoveId) ?? null;

  // Renames go through the normal settings save — `updateWorkspaces` applies
  // name + order and can't create or delete, so sending the list is safe.
  const commitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    const next = renameDraft.trim();
    if (!id || !next) return;
    const cur = workspaces.find((w) => w.id === id);
    if (!cur || cur.name === next) return;
    onRename?.(workspaces.map((w) => (w.id === id ? { ...w, name: next } : w)));
  };

  // Main owns the column and reconciles the engine (only if this is the active
  // workspace); the callback just mirrors the change into the renderer's copy
  // of `sync` so a later settings save doesn't write a stale disabled list.
  const toggleSync = async (ws: any, disabled: boolean) => {
    const res = await window.api.sync.setWorkspaceDisabled({ workspacePath: ws.path, disabled });
    if (res?.ok) onSyncDisabledChange?.(ws.id, disabled);
  };

  // Clone (or attach) a workspace that exists but has no folder on this box.
  const setUpHere = async (ws: any) => {
    const dir = await window.api.openFolder();
    if (!dir) return;
    setSettingUpId(ws.id);
    const res = await window.api.workspace.setUpHere({ id: ws.id, workspacePath: dir });
    setSettingUpId(null);
    if (!res.ok) { setSetupError({ id: ws.id, error: res.error }); return; }
    setSetupError(null);
    await onWorkspaceAdded(ws.id, res.path, ws.name);
  };

  const renderRow = (ws: any) => {
    const syncOff = (disabledWorkspaceIds ?? []).includes(ws.id);
    // No path = the workspace exists but isn't checked out on this machine
    // (a DB from another machine, or a folder that went missing). It stays in
    // the list — hiding it would lose a repo you still own.
    const here = !!ws.path;
    return (
      <li
        key={ws.id}
        className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          {/* Name is the only editable field. The repo is the workspace's
              identity and the path is where it was cloned — neither is a
              rename, they'd be a different workspace. */}
          {renamingId === ws.id ? (
            <Input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
              className="h-7 text-[13px]"
            />
          ) : (
            <button
              type="button"
              className="block max-w-full truncate rounded px-1 -mx-1 text-left text-[13px] font-medium hover:bg-accent"
              onClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
              title="Rename"
            >
              {ws.name}
            </button>
          )}
          <div className="truncate font-mono text-xs text-muted-2" title={ws.path || ws.repo}>
            {here ? ws.path : `${ws.repo} — not on this machine`}
          </div>
          {setupError?.id === ws.id && (
            <p className="mt-1 text-xs text-destructive">{setupError.error}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {/* The engine is a singleton bound to the ACTIVE workspace, so a
              switch left on does nothing until that workspace is opened — the
              tooltip carries that, since the label has no room for it.
              Not error handling either: a failing sync retries on its own and
              never lands here. Meaningless without a checkout. */}
          {here && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Sync to GitHub while this workspace is open">
              <Switch
                checked={!syncOff}
                onCheckedChange={(v) => toggleSync(ws, !v)}
              />
              Sync
            </label>
          )}
          {here ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSwitch(ws.id)}
              disabled={ws.id === activeWorkspaceId}
            >
              Open
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUpHere(ws)}
              disabled={settingUpId === ws.id}
            >
              <FolderOpen /> {settingUpId === ws.id ? 'Setting up…' : 'Set up here'}
            </Button>
          )}
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
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const otherWorkspaces = workspaces.filter((w) => w.id !== activeWorkspaceId);

  return (
    <SettingsSection
      wide
      title="Workspaces"
      description="Each workspace is a GitHub repository with a copy on this machine."
    >
      <SettingsGroup>
        <div>
          {/* The page's single primary action — row actions stay outline/ghost. */}
          {/* The gate is stated BEFORE the button and the button is dead, so
              the requirement is visible without clicking into a dialog to be
              told. The old split's failure was leaving people to discover the
              token requirement on their own. */}
          {!syncPat && (
            <p className="mb-2 text-[13px] text-muted-foreground">
              A GitHub token is required.{' '}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => onOpenGitHubSettings?.()}
              >Add one in GitHub Sync settings</button>.
            </p>
          )}
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={!syncPat}>
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
        message={target ? `Remove "${target.name}"? The folder on disk and the GitHub repo are both kept.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { onRemove(confirmRemoveId); setConfirmRemoveId(null); }}
        onClose={() => setConfirmRemoveId(null)}
      />

      <AddWorkspaceDialog
        open={addOpen}
        onAdded={onWorkspaceAdded}
        onClose={() => setAddOpen(false)}
      />
    </SettingsSection>
  );
}
