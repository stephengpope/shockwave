import React, { useEffect, useState } from 'react';
import { SettingsSection, SettingsGroup, SettingsDivider } from './SectionUI';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import ErrorMessage from '../ErrorMessage.jsx';

// GitHub — the account and the machine, i.e. everything that is NOT per
// workspace. The token is one account for all of them; the interval is one
// engine; git is one binary on this box.
//
// This was briefly folded into Workspaces, on the theory that a workspace IS a
// repo so the account belonged above the list. The list won that argument: it's
// the thing you actually come to that page for, and three global controls on
// top of it pushed the workspaces below the fold.
//
// The old split's real failure wasn't that the token lived elsewhere — it's
// that Workspaces gave you no way to GET here, so you had to already know. The
// add dialog now links straight to this page when no token is set.

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

export default function GitHubSection({ sync, onSyncChange }) {
  const pat = sync?.pat ?? '';
  const interval = sync?.pullIntervalSeconds ?? 10;

  const [showPat, setShowPat] = useState(false);
  const [verifyState, setVerifyState] = useState<any>({ status: 'idle' });
  const [gitState, setGitState] = useState<any>({ status: 'checking' });

  // Cheap (one process) and the answer can change while the app runs, so it's
  // re-checked whenever the section mounts rather than cached.
  useEffect(() => {
    let cancelled = false;
    setGitState({ status: 'checking' });
    window.api.sync.checkGit().then((res) => {
      if (cancelled) return;
      setGitState({ status: res.ok ? 'ok' : 'missing', ...res });
    });
    return () => { cancelled = true; };
  }, []);

  const updateSync = (patch) => onSyncChange?.({ pat, pullIntervalSeconds: interval, ...patch });

  // Verifying a token the user hasn't saved yet: pass the current form value
  // (not the persisted one) so they can verify before committing.
  const onVerify = async () => {
    if (!pat) return;
    setVerifyState({ status: 'checking' });
    const res = await window.api.sync.verifyPat(pat);
    setVerifyState(res.ok
      ? { status: 'ok', login: res.login, name: res.name }
      : { status: 'error', error: res.error });
  };

  // A stale green check next to a changed token would be actively misleading.
  const onPatChange = (e) => {
    updateSync({ pat: e.target.value });
    if (verifyState.status !== 'idle') setVerifyState({ status: 'idle' });
  };

  // Clamped here as well as on the slider: the engine clamps to this same range
  // anyway, so anything outside it would silently not apply.
  const setInterval = (n: number) => {
    if (!Number.isFinite(n)) return;
    updateSync({ pullIntervalSeconds: Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, n)) });
  };

  const install = INSTALL_INSTRUCTIONS[gitState.platform] || INSTALL_INSTRUCTIONS.linux;

  return (
    <SettingsSection
      title="GitHub"
      description="The account your workspaces live under, and how often they sync."
    >
      <SettingsGroup title="Account">
        <Field>
          <FieldLabel htmlFor="sync-pat">Personal Access Token</FieldLabel>
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
            <Button variant="outline" onClick={onVerify} disabled={!pat || verifyState.status === 'checking'}>
              {verifyState.status === 'checking' ? 'Verifying…' : 'Verify'}
            </Button>
          </div>
          <FieldDescription className="text-xs">
            Needs <code className="font-mono">Contents: Read and write</code>, plus{' '}
            <code className="font-mono">Administration: Write</code> to create repos.{' '}
            <a
              href="#"
              className="text-primary hover:underline"
              onClick={(e) => { e.preventDefault(); window.api.openExternal('https://github.com/settings/tokens?type=beta'); }}
            >Create one</a>. Encrypted with your OS keychain.
          </FieldDescription>
          {verifyState.status === 'ok' && (
            <p className="text-xs text-success">
              ✓ Signed in as <strong>{verifyState.login}</strong>
              {verifyState.name ? ` (${verifyState.name})` : ''}
            </p>
          )}
          {verifyState.status === 'error' && <ErrorMessage>{verifyState.error}</ErrorMessage>}
        </Field>
      </SettingsGroup>

      <SettingsDivider />

      <SettingsGroup title="Sync">
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="sync-interval">Sync interval</FieldLabel>
            <span className="text-xs text-muted-foreground">{interval}s</span>
          </div>
          <Slider
            id="sync-interval"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            step={1}
            value={[interval]}
            onValueChange={(v) => setInterval(Number.parseInt(v?.[0], 10))}
          />
          <FieldDescription className="text-xs">
            How often the open workspace pulls and pushes. Min {MIN_INTERVAL}s, max {MAX_INTERVAL}s.
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
            <ErrorMessage>git not found on PATH. Workspaces require git to be installed.</ErrorMessage>
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
