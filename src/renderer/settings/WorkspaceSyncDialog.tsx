import React, { useEffect, useMemo, useState } from 'react';
import ErrorMessage from '../ErrorMessage.jsx';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Field, FieldLabel } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';

// Per-workspace sync configuration dialog.
//
// Three setup modes, exposed depending on current state:
//   - Clone existing GitHub URL into an empty workspace
//   - Create a new GitHub repo and wire this workspace to it
//   - Adopt a workspace the user already turned into a git repo themselves
//
// If already configured, shows the origin URL + a Disconnect action.

const MODES = {
  PICK: 'pick',
  CLONE: 'clone',
  INIT: 'init',
  LINK: 'link',
};

export default function WorkspaceSyncDialog({ open, workspace, syncPat, activeWorkspaceId, pullIntervalSeconds, disabledWorkspaceIds, onSyncDisabledChange, onClose }) {
  const [status, setStatus] = useState<any>(null);  // { hasGit, hasOrigin, originUrl }
  const [mode, setMode] = useState(MODES.PICK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [okMsg, setOkMsg] = useState<any>(null);

  const [remoteUrl, setRemoteUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [makePrivate, setMakePrivate] = useState(true);

  // Repo picker state for CLONE mode. Fetched lazily when the user enters
  // that mode so opening the dialog itself doesn't hit GitHub.
  const [repos, setRepos] = useState<any>(null);     // null = not loaded yet, [] = loaded empty
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<any>(null);
  const [repoFilter, setRepoFilter] = useState('');

  useEffect(() => {
    if (!open || !workspace) return;
    setMode(MODES.PICK);
    setBusy(false);
    setError(null);
    setOkMsg(null);
    setRemoteUrl('');
    setRepoName(workspace.name?.replace(/\s+/g, '-').toLowerCase() ?? '');
    setMakePrivate(true);
    setStatus(null);
    setRepos(null);
    setReposLoading(false);
    setReposError(null);
    setRepoFilter('');
    window.api.sync.workspaceStatus(workspace.path).then(setStatus);
  }, [open, workspace]);

  const hasPat = !!syncPat;
  const alreadyConfigured = status?.hasOrigin;
  const isUserDisabled = !!(workspace && (disabledWorkspaceIds || []).includes(workspace.id));

  // Load repos the first time the user opens a picker (Clone or Link).
  // Subsequent returns to either mode reuse the cached list for the
  // lifetime of the dialog.
  useEffect(() => {
    const usesPicker = mode === MODES.CLONE || mode === MODES.LINK;
    if (!usesPicker || !hasPat || repos !== null || reposLoading) return;
    setReposLoading(true);
    setReposError(null);
    window.api.sync.listRepos().then((res) => {
      if (res.ok) setRepos(res.repos);
      else setReposError(res.error || 'Failed to load repos');
      setReposLoading(false);
    });
  }, [mode, hasPat, repos, reposLoading]);

  const filteredRepos = useMemo(() => {
    if (!repos) return [];
    const q = repoFilter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repos, repoFilter]);

  if (!open || !workspace) return null;

  const runAction = async (fn) => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await fn();
      if (res.ok) {
        setOkMsg(res.remoteUrl ? `Connected to ${res.remoteUrl}` : 'Done');
        const fresh = await window.api.sync.workspaceStatus(workspace.path);
        setStatus(fresh);
        setMode(MODES.PICK);
        if (workspace.id === activeWorkspaceId) {
          window.api.sync.engineStart({
            workspacePath: workspace.path,
            intervalSeconds: pullIntervalSeconds,
          }).catch(() => {});
        }
      } else {
        setError(res.error || 'Setup failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const onClone = () => runAction(() => window.api.sync.setupClone({
    workspacePath: workspace.path,
    remoteUrl,
  }));

  const onInit = () => runAction(() => window.api.sync.setupInitAndCreate({
    workspacePath: workspace.path,
    repoName,
    private: makePrivate,
  }));

  const onLink = () => runAction(() => window.api.sync.setupLink({
    workspacePath: workspace.path,
    remoteUrl,
  }));

  const onToggleDisabled = async (nextDisabled) => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await window.api.sync.setWorkspaceDisabled({
        workspacePath: workspace.path,
        disabled: nextDisabled,
      });
      if (!res.ok) {
        setError(res.error || 'Failed to update sync state');
        return;
      }
      onSyncDisabledChange?.(workspace.id, nextDisabled);
      setOkMsg(nextDisabled ? 'GitHub sync disabled for this workspace' : 'GitHub sync re-enabled');
    } finally {
      setBusy(false);
    }
  };

  // Footer changes per mode so the primary action is always at bottom-right.
  let footer;
  if (mode === MODES.CLONE) {
    footer = (
      <>
        <Button variant="outline" onClick={() => setMode(MODES.PICK)} disabled={busy}>Back</Button>
        <Button onClick={onClone} disabled={busy || !remoteUrl.trim()}>
          {busy ? 'Cloning…' : 'Clone'}
        </Button>
      </>
    );
  } else if (mode === MODES.LINK) {
    footer = (
      <>
        <Button variant="outline" onClick={() => setMode(MODES.PICK)} disabled={busy}>Back</Button>
        <Button onClick={onLink} disabled={busy || !remoteUrl.trim()}>
          {busy ? 'Linking…' : 'Link'}
        </Button>
      </>
    );
  } else if (mode === MODES.INIT) {
    footer = (
      <>
        <Button variant="outline" onClick={() => setMode(MODES.PICK)} disabled={busy}>Back</Button>
        <Button onClick={onInit} disabled={busy || !repoName.trim()}>
          {busy ? 'Creating…' : 'Create repo'}
        </Button>
      </>
    );
  } else {
    footer = <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>;
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="text-[13px]" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Sync — {workspace.name}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {!hasPat && (
            <ErrorMessage>
              No GitHub PAT configured. Set one in Settings → GitHub Sync first.
            </ErrorMessage>
          )}

          {status === null && hasPat && (
            <p className="m-0 text-muted-foreground">Checking workspace…</p>
          )}

          {alreadyConfigured && (
            <Field>
              <FieldLabel>Connected to</FieldLabel>
              <code className="block break-all rounded-md border border-border bg-raise px-2 py-1.5 font-mono text-xs">
                {status.originUrl}
              </code>
              {isUserDisabled ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Sync is paused for this workspace. The remote is still wired up — re-enable to resume.
                  </p>
                  <Button
                    className="self-start"
                    onClick={() => onToggleDisabled(false)}
                    disabled={busy}
                  >
                    {busy ? 'Working…' : 'Re-enable GitHub sync'}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  className="self-start"
                  onClick={() => onToggleDisabled(true)}
                  disabled={busy}
                >
                  {busy ? 'Working…' : 'Disable GitHub sync'}
                </Button>
              )}
            </Field>
          )}

          {hasPat && status && !alreadyConfigured && mode === MODES.PICK && (
            <div>
              <p className="m-0 mb-3">How would you like to set up sync for this workspace?</p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="flex flex-col gap-1 rounded-lg border border-border p-3 text-left hover:border-ring hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => setMode(MODES.CLONE)}
                  disabled={busy}
                >
                  <span className="text-[13px] font-medium">Clone existing GitHub repo</span>
                  <span className="text-xs text-muted-foreground">Pull a repo from GitHub into this (empty) workspace folder.</span>
                </button>
                <button
                  type="button"
                  className="flex flex-col gap-1 rounded-lg border border-border p-3 text-left hover:border-ring hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => setMode(MODES.INIT)}
                  disabled={busy}
                >
                  <span className="text-[13px] font-medium">Create new GitHub repo</span>
                  <span className="text-xs text-muted-foreground">Make a new repo under your account and push these files to it.</span>
                </button>
                <button
                  type="button"
                  className="flex flex-col gap-1 rounded-lg border border-border p-3 text-left hover:border-ring hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => setMode(MODES.LINK)}
                  disabled={busy}
                >
                  <span className="text-[13px] font-medium">Link to existing GitHub repo</span>
                  <span className="text-xs text-muted-foreground">Attach this workspace to a repo you already have on GitHub. Your files stay; sync resumes on the next tick.</span>
                </button>
              </div>
            </div>
          )}

          {hasPat && (mode === MODES.CLONE || mode === MODES.LINK) && (
            <div>
              <p className="m-0 mb-3">
                {mode === MODES.CLONE
                  ? 'Clone a GitHub repo into this workspace. Folder must be empty.'
                  : 'Attach this workspace to an existing GitHub repo. Your files stay where they are; the next sync tick commits and pushes them.'}
              </p>
              <Field>
                <FieldLabel htmlFor="ws-clone-filter">Repository</FieldLabel>
                <Input
                  id="ws-clone-filter"
                  type="text"
                  placeholder={reposLoading ? 'Loading repos…' : 'Filter by name, or paste a URL'}
                  value={repoFilter}
                  onChange={(e) => {
                    setRepoFilter(e.target.value);
                    setRemoteUrl(e.target.value);
                  }}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
                <div
                  className="max-h-56 overflow-y-auto rounded-md border border-border"
                  role="listbox"
                  aria-label="Your repositories"
                >
                  {reposLoading && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Loading repos…</div>
                  )}
                  {!reposLoading && reposError && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">Couldn't load repos: {reposError}. Paste a URL above instead.</div>
                  )}
                  {!reposLoading && !reposError && repos && filteredRepos.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No matching repos.</div>
                  )}
                  {!reposLoading && !reposError && filteredRepos.map((r) => {
                    const selected = remoteUrl === r.clone_url;
                    return (
                      <button
                        key={r.full_name}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent',
                          selected && 'bg-selected text-selected-foreground',
                        )}
                        onClick={() => {
                          setRemoteUrl(r.clone_url);
                          setRepoFilter(r.full_name);
                        }}
                      >
                        <span className="truncate font-mono text-xs">{r.full_name}</span>
                        {r.private && <Badge variant="outline">Private</Badge>}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
          )}

          {hasPat && mode === MODES.INIT && (
            <div className="flex flex-col gap-3">
              <p className="m-0">
                Create a new repo under your GitHub account and push this workspace
                to it. Existing files will be committed and pushed by the next sync tick.
              </p>
              <Field>
                <FieldLabel htmlFor="ws-repo-name">Repository name</FieldLabel>
                <Input
                  id="ws-repo-name"
                  type="text"
                  placeholder="my-notes"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Label className="gap-2.5 text-[13px] font-normal">
                <Checkbox
                  checked={makePrivate}
                  onCheckedChange={(v) => setMakePrivate(v === true)}
                />
                Private repository
              </Label>
            </div>
          )}

          {error && <ErrorMessage>{error}</ErrorMessage>}
          {okMsg && <p className="m-0 text-xs text-success">{okMsg}</p>}
        </div>

        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
