import React, { useEffect, useMemo, useState } from 'react';
import Dialog from '../Dialog.jsx';
import ErrorMessage from '../ErrorMessage.jsx';

// Per-workspace sync configuration dialog.
//
// Three setup modes, exposed depending on current state:
//   - Clone existing GitHub URL into an empty workspace
//   - Create a new GitHub repo and wire this workspace to it
//   - Adopt a workspace the user already turned into a git repo themselves
//
// If already configured, shows the origin URL + a Disconnect action.
//
// Buttons + form fields use the same `dialog-button` / `settings-input` /
// `settings-field` patterns as AgentSecretsSection so the surface matches
// the rest of Settings.

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
        <button className="dialog-button" onClick={() => setMode(MODES.PICK)} disabled={busy}>Back</button>
        <button
          className="dialog-button dialog-button-primary"
          onClick={onClone}
          disabled={busy || !remoteUrl.trim()}
        >
          {busy ? 'Cloning…' : 'Clone'}
        </button>
      </>
    );
  } else if (mode === MODES.LINK) {
    footer = (
      <>
        <button className="dialog-button" onClick={() => setMode(MODES.PICK)} disabled={busy}>Back</button>
        <button
          className="dialog-button dialog-button-primary"
          onClick={onLink}
          disabled={busy || !remoteUrl.trim()}
        >
          {busy ? 'Linking…' : 'Link'}
        </button>
      </>
    );
  } else if (mode === MODES.INIT) {
    footer = (
      <>
        <button className="dialog-button" onClick={() => setMode(MODES.PICK)} disabled={busy}>Back</button>
        <button
          className="dialog-button dialog-button-primary"
          onClick={onInit}
          disabled={busy || !repoName.trim()}
        >
          {busy ? 'Creating…' : 'Create repo'}
        </button>
      </>
    );
  } else {
    footer = <button className="dialog-button" onClick={onClose} disabled={busy}>Close</button>;
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Sync — ${workspace.name}`}
      footer={footer}
    >
      {!hasPat && (
        <ErrorMessage>
          No GitHub PAT configured. Set one in Settings → GitHub Sync first.
        </ErrorMessage>
      )}

      {status === null && hasPat && (
        <p style={{ margin: 0 }}>Checking workspace…</p>
      )}

      {alreadyConfigured && (
        <div className="settings-field">
          <div className="settings-field-label">Connected to</div>
          <code className="settings-input-mono" style={{ display: 'block', padding: '6px 8px', wordBreak: 'break-all' }}>
            {status.originUrl}
          </code>
          {isUserDisabled ? (
            <>
              <p className="settings-field-hint" style={{ marginTop: 8 }}>
                Sync is paused for this workspace. The remote is still wired up — re-enable to resume.
              </p>
              <button
                className="dialog-button dialog-button-primary"
                onClick={() => onToggleDisabled(false)}
                disabled={busy}
                style={{ marginTop: 12 }}
              >
                {busy ? 'Working…' : 'Re-enable GitHub sync'}
              </button>
            </>
          ) : (
            <button
              className="dialog-button"
              onClick={() => onToggleDisabled(true)}
              disabled={busy}
              style={{ marginTop: 12 }}
            >
              {busy ? 'Working…' : 'Disable GitHub sync'}
            </button>
          )}
        </div>
      )}

      {hasPat && status && !alreadyConfigured && mode === MODES.PICK && (
        <div>
          <p style={{ margin: '0 0 12px 0' }}>How would you like to set up sync for this workspace?</p>
          <div className="sync-choice-list">
            <button className="sync-choice" onClick={() => setMode(MODES.CLONE)} disabled={busy}>
              <span className="sync-choice-title">Clone existing GitHub repo</span>
              <span className="sync-choice-desc">Pull a repo from GitHub into this (empty) workspace folder.</span>
            </button>
            <button className="sync-choice" onClick={() => setMode(MODES.INIT)} disabled={busy}>
              <span className="sync-choice-title">Create new GitHub repo</span>
              <span className="sync-choice-desc">Make a new repo under your account and push these files to it.</span>
            </button>
            <button className="sync-choice" onClick={() => setMode(MODES.LINK)} disabled={busy}>
              <span className="sync-choice-title">Link to existing GitHub repo</span>
              <span className="sync-choice-desc">Attach this workspace to a repo you already have on GitHub. Your files stay; sync resumes on the next tick.</span>
            </button>
          </div>
        </div>
      )}

      {hasPat && (mode === MODES.CLONE || mode === MODES.LINK) && (
        <div>
          <p style={{ margin: '0 0 12px 0' }}>
            {mode === MODES.CLONE
              ? 'Clone a GitHub repo into this workspace. Folder must be empty.'
              : 'Attach this workspace to an existing GitHub repo. Your files stay where they are; the next sync tick commits and pushes them.'}
          </p>
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="ws-clone-filter">Repository</label>
            <input
              id="ws-clone-filter"
              className="settings-input"
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
            <div className="sync-repo-list" role="listbox" aria-label="Your repositories">
              {reposLoading && (
                <div className="sync-repo-empty">Loading repos…</div>
              )}
              {!reposLoading && reposError && (
                <div className="sync-repo-empty">Couldn't load repos: {reposError}. Paste a URL above instead.</div>
              )}
              {!reposLoading && !reposError && repos && filteredRepos.length === 0 && (
                <div className="sync-repo-empty">No matching repos.</div>
              )}
              {!reposLoading && !reposError && filteredRepos.map((r) => {
                const selected = remoteUrl === r.clone_url;
                return (
                  <button
                    key={r.full_name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`sync-repo-item${selected ? ' is-selected' : ''}`}
                    onClick={() => {
                      setRemoteUrl(r.clone_url);
                      setRepoFilter(r.full_name);
                    }}
                  >
                    <span className="sync-repo-name">{r.full_name}</span>
                    {r.private && <span className="sync-repo-tag">Private</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {hasPat && mode === MODES.INIT && (
        <div>
          <p style={{ margin: '0 0 12px 0' }}>
            Create a new repo under your GitHub account and push this workspace
            to it. Existing files will be committed and pushed by the next sync tick.
          </p>
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="ws-repo-name">Repository name</label>
            <input
              id="ws-repo-name"
              className="settings-input"
              type="text"
              placeholder="my-notes"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="settings-field">
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={makePrivate}
                onChange={(e) => setMakePrivate(e.target.checked)}
              />
              Private repository
            </label>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12 }}>
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      )}
      {okMsg && (
        <p className="settings-field-hint" style={{ color: 'var(--accent)', marginTop: 12 }}>{okMsg}</p>
      )}
    </Dialog>
  );
}
