import React, { useEffect, useState } from 'react';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import ErrorMessage from '../ErrorMessage.jsx';

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
  const [verifyState, setVerifyState] = useState<any>({ status: 'idle' });
  const [gitState, setGitState] = useState<any>({ status: 'checking' });

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

  const onIntervalChange = (values) => {
    const n = Number.parseInt(values?.[0], 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, n));
    update({ pullIntervalSeconds: clamped });
  };

  const install = INSTALL_INSTRUCTIONS[gitState.platform] || INSTALL_INSTRUCTIONS.linux;

  return (
    <SettingsSection
      title="GitHub Sync"
      description={(
        <>
          Sync each workspace to its own GitHub repository. Create a fine-grained
          Personal Access Token at{' '}
          <a
            href="#"
            className="text-primary hover:underline"
            onClick={(e) => { e.preventDefault(); window.api.openExternal('https://github.com/settings/tokens?type=beta'); }}
          >github.com/settings/tokens</a>
          {' '}with <code className="font-mono text-xs">Contents: Read and write</code> on the repos you want
          to sync. The token is encrypted on this machine using your OS keychain.
        </>
      )}
    >
      <SettingsGroup title="Authentication">
        <Field>
          <FieldLabel htmlFor="sync-pat">GitHub Personal Access Token</FieldLabel>
          <div className="flex gap-2">
            <InputGroup className="flex-1">
              <InputGroupInput
                id="sync-pat"
                type={showPat ? 'text' : 'password'}
                className="font-mono text-[13px]"
                value={pat}
                onChange={onPatChange}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                placeholder="github_pat_…"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={() => setShowPat((v) => !v)}>
                  {showPat ? 'Hide' : 'Show'}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <Button
              onClick={onVerify}
              disabled={!pat || verifyState.status === 'checking'}
            >
              {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
            </Button>
          </div>
          {verifyState.status === 'ok' && (
            <p className="text-xs text-success">
              ✓ Signed in as <strong>{verifyState.login}</strong>
              {verifyState.name ? ` (${verifyState.name})` : ''}
            </p>
          )}
          {verifyState.status === 'error' && (
            <ErrorMessage>{verifyState.error}</ErrorMessage>
          )}
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Sync engine">
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="sync-interval">Pull interval</FieldLabel>
            <span className="text-xs text-muted-foreground">{interval}s</span>
          </div>
          <Slider
            id="sync-interval"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            step={1}
            value={[interval]}
            onValueChange={onIntervalChange}
          />
          <FieldDescription className="text-xs">
            How often each synced workspace tries to pull and push.
            Min {MIN_INTERVAL}s, max {MAX_INTERVAL}s.
          </FieldDescription>
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="System">
        {gitState.status === 'checking' && (
          <p className="text-xs text-muted-foreground">Checking for git…</p>
        )}
        {gitState.status === 'ok' && (
          <p className="text-xs text-success">✓ {gitState.version}</p>
        )}
        {gitState.status === 'missing' && (
          <div className="flex flex-col gap-2">
            <ErrorMessage>
              git not found on PATH. Sync requires git to be installed.
            </ErrorMessage>
            <p className="text-xs text-muted-foreground">
              <strong>{install.label}:</strong> {install.body}
            </p>
            <pre className="m-0 rounded-md bg-raise px-3 py-2 font-mono text-xs whitespace-pre-wrap">{install.cmd}</pre>
          </div>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
