import React, { useEffect, useState } from 'react';
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
};

export default function WorkspaceSyncDialog({ open, workspace, syncPat, activeWorkspaceId, pullIntervalSeconds, onClose }) {
  const [status, setStatus] = useState(null);  // { hasGit, hasOrigin, originUrl }
  const [mode, setMode] = useState(MODES.PICK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  const [remoteUrl, setRemoteUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  const [makePrivate, setMakePrivate] = useState(true);

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
    window.api.sync.workspaceStatus(workspace.path).then(setStatus);
  }, [open, workspace]);

  if (!open || !workspace) return null;

  const hasPat = !!syncPat;
  const alreadyConfigured = status?.hasOrigin;

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

  const onAdopt = () => runAction(() => window.api.sync.setupExistingLocal({
    workspacePath: workspace.path,
  }));

  const onDisconnect = () => runAction(() => window.api.sync.teardown({
    workspacePath: workspace.path,
  }));

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
          <button
            className="dialog-button dialog-button-destructive"
            onClick={onDisconnect}
            disabled={busy}
            style={{ marginTop: 12 }}
          >
            {busy ? 'Working…' : 'Disconnect'}
          </button>
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
            {status.hasGit && (
              <button className="sync-choice" onClick={onAdopt} disabled={busy}>
                <span className="sync-choice-title">Use existing local git repo</span>
                <span className="sync-choice-desc">Workspace already has .git with an origin — adopt it.</span>
              </button>
            )}
          </div>
        </div>
      )}

      {hasPat && mode === MODES.CLONE && (
        <div>
          <p style={{ margin: '0 0 12px 0' }}>
            Clone a GitHub repo into this workspace. Folder must be empty.
          </p>
          <div className="settings-field">
            <label className="settings-field-label" htmlFor="ws-clone-url">Repository URL</label>
            <input
              id="ws-clone-url"
              className="settings-input"
              type="text"
              placeholder="https://github.com/owner/repo"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
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
