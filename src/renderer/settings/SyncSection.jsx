import React, { useEffect, useState } from 'react';

// GitHub sync settings.
//   1. PAT — encrypted on disk via OS keychain (main, safeStorage). Shown
//      masked unless the user clicks Show.
//   2. Verify — calls GET /user with the PAT to confirm it's valid and reports
//      the GitHub login back to the user. Doesn't probe scopes — those are
//      checked per-repo when the user actually configures a workspace.
//   3. Pull interval — how often the sync engine ticks (commits, pulls,
//      pushes). 10s default.
//   4. Git presence check — runs `git --version` on the host and shows
//      platform-specific install instructions if git isn't found. The sync
//      engine can't function without git; this banner prevents the user
//      hitting that as a delayed error.

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 600;

const INSTALL_INSTRUCTIONS = {
  darwin: {
    label: 'macOS',
    // Apple ships git inside Command Line Tools (`xcode-select --install`).
    // We recommend Homebrew because it's actively versioned and avoids the
    // CLT update treadmill.
    body: 'Install Homebrew (brew.sh) then run:',
    cmd: 'brew install git',
  },
  win32: {
    label: 'Windows',
    body: 'Download Git for Windows:',
    cmd: 'https://git-scm.com/download/win',
  },
  linux: {
    label: 'Linux',
    body: 'Use your distro\'s package manager. Examples:',
    cmd: 'sudo apt install git    # Debian/Ubuntu\nsudo dnf install git    # Fedora\nsudo pacman -S git      # Arch',
  },
};

export default function SyncSection({ sync, onSyncChange }) {
  const pat = sync?.pat ?? '';
  const interval = sync?.pullIntervalSeconds ?? 10;

  const [showPat, setShowPat] = useState(false);
  const [verifyState, setVerifyState] = useState({ status: 'idle' });
  const [gitState, setGitState] = useState({ status: 'checking' });

  // Re-run the git check on mount and whenever the section is reopened. Cheap
  // (spawns one process) and the result can change if the user installs git
  // while the app is running.
  useEffect(() => {
    let cancelled = false;
    setGitState({ status: 'checking' });
    window.api.sync.checkGit().then((res) => {
      if (cancelled) return;
      setGitState({ status: res.ok ? 'ok' : 'missing', ...res });
    });
    return () => { cancelled = true; };
  }, []);

  const update = (patch) => onSyncChange?.({
    pat,
    pullIntervalSeconds: interval,
    ...patch,
  });

  // Verifying a token the user hasn't saved yet: pass the current form value
  // (not the persisted one) so they can verify before committing.
  const onVerify = async () => {
    if (!pat) return;
    setVerifyState({ status: 'checking' });
    const res = await window.api.sync.verifyPat(pat);
    if (res.ok) {
      setVerifyState({ status: 'ok', login: res.login, name: res.name });
    } else {
      setVerifyState({ status: 'error', error: res.error });
    }
  };

  // Clear stale verify result whenever the PAT field changes — it could now
  // be wrong, and we don't want a stale green check misleading the user.
  const onPatChange = (e) => {
    update({ pat: e.target.value });
    if (verifyState.status !== 'idle') setVerifyState({ status: 'idle' });
  };

  const onIntervalChange = (e) => {
    const n = Number.parseInt(e.target.value, 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, n));
    update({ pullIntervalSeconds: clamped });
  };

  const install = INSTALL_INSTRUCTIONS[gitState.platform] || INSTALL_INSTRUCTIONS.linux;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">GitHub Sync</h2>
      <p className="settings-section-desc">
        Sync each workspace to its own GitHub repository. Create a fine-grained
        Personal Access Token at{' '}
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); window.api.openExternal('https://github.com/settings/tokens?type=beta'); }}
        >github.com/settings/tokens</a>
        {' '}with <code>Contents: Read and write</code> on the repos you want
        to sync. The token is encrypted on this machine using your OS keychain.
      </p>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="sync-pat">GitHub Personal Access Token</label>
        <div className="settings-input-row">
          <input
            id="sync-pat"
            className="settings-input"
            type={showPat ? 'text' : 'password'}
            value={pat}
            onChange={onPatChange}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            placeholder="github_pat_…"
          />
          <button
            type="button"
            className="settings-input-toggle"
            onClick={() => setShowPat((v) => !v)}
          >
            {showPat ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={onVerify}
            disabled={!pat || verifyState.status === 'checking'}
          >
            {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
          </button>
        </div>
        {verifyState.status === 'ok' && (
          <p className="settings-field-hint" style={{ color: 'var(--fg-success, #2a9d4a)' }}>
            ✓ Signed in as <strong>{verifyState.login}</strong>
            {verifyState.name ? ` (${verifyState.name})` : ''}
          </p>
        )}
        {verifyState.status === 'error' && (
          <p className="settings-field-hint" style={{ color: 'var(--fg-error)' }}>
            {verifyState.error}
          </p>
        )}
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="sync-interval">
          Pull interval (seconds)
        </label>
        <input
          id="sync-interval"
          className="settings-input"
          type="number"
          min={MIN_INTERVAL}
          max={MAX_INTERVAL}
          value={interval}
          onChange={onIntervalChange}
          style={{ width: 120 }}
        />
        <p className="settings-field-hint">
          How often each synced workspace tries to pull and push.
          Min {MIN_INTERVAL}s, max {MAX_INTERVAL}s.
        </p>
      </div>

      <h3 className="settings-subsection-title" style={{ marginTop: 24 }}>System</h3>
      {gitState.status === 'checking' && (
        <p className="settings-field-hint">Checking for git…</p>
      )}
      {gitState.status === 'ok' && (
        <p className="settings-field-hint" style={{ color: 'var(--fg-success, #2a9d4a)' }}>
          ✓ {gitState.version}
        </p>
      )}
      {gitState.status === 'missing' && (
        <div className="settings-field" style={{ marginTop: 8 }}>
          <p className="settings-field-hint" style={{ color: 'var(--fg-error)' }}>
            git not found on PATH. Sync requires git to be installed.
          </p>
          <p className="settings-field-hint" style={{ marginTop: 8 }}>
            <strong>{install.label}:</strong> {install.body}
          </p>
          <pre style={{
            background: 'var(--bg-elevated, #f5f5f5)',
            padding: '8px 12px',
            borderRadius: 4,
            fontSize: 12,
            margin: '4px 0 0',
            whiteSpace: 'pre-wrap',
          }}>{install.cmd}</pre>
        </div>
      )}
    </div>
  );
}
