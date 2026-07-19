import React, { useState } from 'react';
import { FolderOpen, Plus, Trash2, X, FileCog } from 'lucide-react';
import { toast } from 'sonner';
import ConfirmDialog from '../ConfirmDialog.jsx';
import AddWorkspaceDialog from './AddWorkspaceDialog';
import { SettingsSection, SettingsGroup } from './SectionUI';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import ErrorMessage from '../ErrorMessage.jsx';

// Workspaces — just the list and the ways in and out of it. The account, the
// sync interval, and the git check live in GitHubSection: none of them is per
// workspace, and stacking three global controls above the list pushed the
// workspaces themselves below the fold.
//
// The PAT is still required to add one. What the old split got wrong wasn't
// that the token lived elsewhere — it's that this page left you to find it on
// your own. The Add button is now disabled without a token, with a link to the
// GitHub Sync section right above it.

export default function WorkspacesSection({
  workspaces,
  activeWorkspaceId,
  onWorkspaceAdded,
  onSwitch,
  onRemove,
  onRename,
  syncPat,
  onOpenGitHubSettings,
}) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<any>(null);
  const [renamingId, setRenamingId] = useState<any>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [settingUpId, setSettingUpId] = useState<any>(null);
  // One error slot per row, for both setup and sync-toggle failures — they're
  // the same kind of thing to the user ("this row's action failed") and having
  // two meant one could silently replace the other.
  const [rowError, setRowError] = useState<any>(null);
  const [addOpen, setAddOpen] = useState(false);

  // The workspace default files (SOUL.md, AGENTS.md, .ignore, .gitignore). Both
  // creation paths seed them; this is the manual half, for workspaces that
  // predate one being added to the set.
  const [confirmResetWs, setConfirmResetWs] = useState<any>(null);

  const target = workspaces.find((w) => w.id === confirmRemoveId) ?? null;

  // `overwrite` replaces all of them; without it only missing ones are written,
  // so the safe action can't destroy anything and needs no confirm.
  const writeDefaultFiles = async (ws: any, overwrite: boolean) => {
    setRowError(null);
    try {
      const res = await window.api.workspace.ensureFiles({ workspacePath: ws.path, overwrite });
      if (!res?.ok) {
        setRowError({ id: ws.id, error: res?.error ?? 'Could not write the default files.' });
        return;
      }
      const written = res.written ?? [];
      toast(
        written.length === 0
          ? `${ws.name} already has every default file.`
          : `${overwrite ? 'Reset' : 'Added'} ${written.join(', ')} in ${ws.name}.`,
      );
    } catch (err: any) {
      setRowError({ id: ws.id, error: err?.message ?? 'Could not write the default files.' });
    }
  };

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

  // Main owns the column, reconciles the engine (only if this is the active
  // workspace), and pushes the updated list back — so there's nothing to mirror
  // here. A failure has to SAY so: this used to be `if (res?.ok)` with no else,
  // so a failed toggle just snapped the switch back with no explanation.
  const setSyncEnabled = async (ws: any, enabled: boolean) => {
    setRowError(null);
    try {
      const res = await window.api.sync.setWorkspaceDisabled({ workspacePath: ws.path, disabled: !enabled });
      if (!res?.ok) setRowError({ id: ws.id, error: res?.error ?? 'Could not change sync for this workspace.' });
    } catch (err: any) {
      setRowError({ id: ws.id, error: err?.message ?? 'Could not change sync for this workspace.' });
    }
  };

  // Clone (or attach) a workspace that exists but has no folder on this box.
  const setUpHere = async (ws: any) => {
    // Claim the row BEFORE the picker opens — it's an await, and without this
    // the button stays live long enough to open two pickers.
    if (settingUpId) return;
    setSettingUpId(ws.id);
    const dir = await window.api.openFolder();
    if (!dir) { setSettingUpId(null); return; }
    const res = await window.api.workspace.setUpHere({ id: ws.id, workspacePath: dir });
    setSettingUpId(null);
    if (!res.ok) { setRowError({ id: ws.id, error: res.error }); return; }
    setRowError(null);
    // No switch. Main pushes the updated list, so the row refreshes on its own —
    // checking a workspace out on this machine shouldn't yank you out of the
    // one you're currently in, which is what routing this through the add
    // callback used to do (it also closed Settings).
  };

  const renderRow = (ws: any) => {

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
              aria-label="Workspace name"
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
              aria-label={`Rename ${ws.name}`}
            >
              {ws.name}
            </button>
          )}
          <div className="truncate font-mono text-xs text-muted-2" title={ws.path || ws.repo}>
            {here ? ws.path : `${ws.repo} — not on this machine`}
          </div>
          {rowError?.id === ws.id && (
            <div className="mt-1.5 flex items-start gap-2" role="alert">
              <ErrorMessage className="flex-1">{rowError.error}</ErrorMessage>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setRowError(null)}
                aria-label="Dismiss error"
                title="Dismiss"
              >
                <X />
              </Button>
            </div>
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
                checked={ws.syncEnabled}
                onCheckedChange={(v) => setSyncEnabled(ws, v)}
                aria-label={`Sync ${ws.name} to GitHub`}
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
          {/* Meaningless without a checkout — there's no folder to write to. */}
          {here && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  title="Default files"
                  aria-label={`Default files for ${ws.name}`}
                >
                  <FileCog />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => writeDefaultFiles(ws, false)}>
                  Add missing files
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmResetWs(ws)}>
                  Reset to defaults…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
          {!syncPat?.trim() && (
            <p className="mb-2 text-[13px] text-muted-foreground">
              A GitHub token is required.{' '}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => onOpenGitHubSettings?.()}
              >Add one in GitHub Sync settings</button>.
            </p>
          )}
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={!syncPat?.trim()}>
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

      {/* Names the files, because the destructive part is specific: the repo
          makes this recoverable, but only for what's already COMMITTED — an
          edit made since the last sync tick has no git copy to come back
          from. */}
      <ConfirmDialog
        open={!!confirmResetWs}
        title="Reset default files"
        message={confirmResetWs
          ? `Replace SOUL.md, AGENTS.md, .ignore, and .gitignore in "${confirmResetWs.name}" with the current defaults? Any edits you've made to them are overwritten — committed versions stay in the repo's history, but changes since the last sync are lost.`
          : ''}
        confirmLabel="Reset files"
        destructive
        onConfirm={() => { writeDefaultFiles(confirmResetWs, true); setConfirmResetWs(null); }}
        onClose={() => setConfirmResetWs(null)}
      />

      <AddWorkspaceDialog
        open={addOpen}
        onAdded={onWorkspaceAdded}
        onClose={() => setAddOpen(false)}
      />
    </SettingsSection>
  );
}
