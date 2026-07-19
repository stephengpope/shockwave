import React, { useEffect, useMemo, useState } from 'react';
import { Check, FolderOpen, Link2, Sparkles } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import ErrorMessage from '../ErrorMessage.jsx';

// The one way to add a workspace. A workspace IS a GitHub repo, so there are
// two facts to establish: which repo, and which folder holds its checkout.
//
// THE FOLDER IS ASKED FIRST, because it decides what's left to ask. Point at a
// folder that's already a clone and the repo is no longer a question — we read
// it off the checkout and only need a name. Point at an empty one and the repo
// half appears. That's why there's no "adopt an existing folder" mode to go
// find: it's just what happens when you pick a folder that already is one.
//
// The earlier shape asked for the repo first, then a parent directory plus a
// folder name. Two problems: adopting a clone had no home at all, and "where
// does this go" read as the destination, so picking `sgp` produced `sgp/sgp`.
//
// No token check here — the Add button that opens this is disabled without one,
// and the requirement is stated next to it rather than behind a click.

const MODE = { CREATE: 'create', EXISTING: 'existing' };

// GitHub's own rule: anything not alphanumeric/hyphen/underscore/period becomes
// a hyphen. Applied so the repo name tracks the display name until the user
// takes it over, rather than being rejected by the API after the fact.
function slugify(name: string) {
  return name.trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')   // GitHub rejects leading/trailing dots too
    .replace(/\.{2,}/g, '.');        // ...and consecutive dots
}

export default function AddWorkspaceDialog({ open, onClose, onAdded }) {
  const [folder, setFolder] = useState('');
  // null until a folder is picked; then { state: 'empty'|'clone'|'occupied', … }
  const [info, setInfo] = useState<any>(null);
  const [inspecting, setInspecting] = useState(false);

  const [mode, setMode] = useState<string>(MODE.CREATE);
  const [name, setName] = useState('');
  const [repoName, setRepoName] = useState('');
  // Once the user edits the repo name, stop deriving it from the display name —
  // otherwise every further keystroke in Name would silently undo their edit.
  const [repoNameTouched, setRepoNameTouched] = useState(false);
  const [isPrivate, setIsPrivate] = useState(true);
  const [picked, setPicked] = useState<any>(null);
  const [repos, setRepos] = useState<any[] | null>(null);
  const [reposError, setReposError] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setFolder(''); setInfo(null); setInspecting(false);
    setMode(MODE.CREATE); setName(''); setRepoName(''); setRepoNameTouched(false);
    setIsPrivate(true); setPicked(null); setRepoFilter(''); setCursor(0); setBusy(false); setError(''); setReposError('');
    // `repos` must reset too. The dialog is permanently mounted inside
    // WorkspacesSection, so a list left as [] by one failed fetch survived every
    // reopen — one network blip and "No matching repositories." for the rest of
    // the session.
    setRepos(null);
  }, [open]);

  // Only the empty-folder path needs the repo list, and it's a network call —
  // fetched on first entry to that state, then cached until the dialog reopens
  // (it stays MOUNTED inside WorkspacesSection, so the reset effect is what
  // clears it, not an unmount).
  const needsRepoList = info?.state === 'empty' && mode === MODE.EXISTING;
  useEffect(() => {
    if (!open || !needsRepoList || repos !== null || reposError) return;
    let cancelled = false;
    window.api.sync.listRepos().then((res) => {
      if (cancelled) return;
      if (res.ok) setRepos(res.repos ?? []);
      // Leave `repos` null on failure so the effect can run again — setting []
      // would satisfy the `repos !== null` guard and never retry.
      else setReposError(res.error ?? 'Could not list repositories');
    });
    return () => { cancelled = true; };
  }, [open, needsRepoList, repos, reposError]);

  const filteredRepos = useMemo(() => {
    if (!repos) return [];
    const q = repoFilter.trim().toLowerCase();
    if (!q) return repos.slice(0, 50);
    return repos.filter((r) => r.full_name.toLowerCase().includes(q)).slice(0, 50);
  }, [repos, repoFilter]);

  // Keyboard cursor into the filtered list (aria-activedescendant target).
  const [cursor, setCursor] = useState(0);
  const onRepoKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => {
        const n = filteredRepos.length;
        if (!n) return 0;
        return e.key === 'ArrowDown' ? (c + 1) % n : (c - 1 + n) % n;
      });
    } else if (e.key === 'Enter' && filteredRepos[cursor]) {
      e.preventDefault();
      setPicked(filteredRepos[cursor]);
    }
  };

  const chooseFolder = async () => {
    const dir = await window.api.openFolder();
    if (!dir) return;
    setFolder(dir);
    setError('');
    setInspecting(true);
    const res = await window.api.workspace.inspectFolder(dir);
    setInspecting(false);
    setInfo(res);
    // A clone answers the repo question, so seed the name from it.
    if (res.state === 'clone' && !name) setName(res.repoName ?? '');
  };

  const canSubmit = !busy && !inspecting && (
    info?.state === 'clone' ? true
      : info?.state === 'empty'
        ? (mode === MODE.CREATE ? !!(repoNameTouched ? repoName : slugify(name)) : !!picked)
        : false
  );

  const submit = async () => {
    setBusy(true);
    setError('');
    let res;
    if (info.state === 'clone') {
      // Same call as the picker path — `ensureCheckout` sees the folder already
      // matches and leaves it alone, so "adopt" isn't a separate operation.
      res = await window.api.workspace.addFromRepo({
        workspacePath: folder,
        owner: info.repoOwner,
        repo: info.repoName,
        name: name || info.repoName,
      });
    } else if (mode === MODE.CREATE) {
      res = await window.api.workspace.createWithRepo({
        workspacePath: folder,
        repoName: repoNameTouched ? repoName : slugify(name),
        name,
        private: isPrivate,
      });
    } else {
      res = await window.api.workspace.addFromRepo({
        workspacePath: folder,
        owner: picked.full_name.split('/')[0],
        repo: picked.full_name.split('/')[1],
        name: name || picked.full_name.split('/')[1],
      });
    }
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'Could not add workspace'); return; }
    await onAdded(res.id);
    onClose();
  };

  const submitLabel = busy
    ? (info?.state === 'clone' ? 'Adding…' : mode === MODE.CREATE ? 'Creating…' : 'Cloning…')
    : 'Add workspace';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add workspace</DialogTitle>
          <DialogDescription>
            Every workspace is a GitHub repository with a folder on this machine.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Folder</FieldLabel>
            <div className="flex gap-2">
              <Input
                readOnly
                value={folder}
                placeholder="Choose a folder"
                className="flex-1 font-mono text-xs"
                title={folder}
              />
              <Button variant="outline" size="sm" onClick={chooseFolder} disabled={busy}>
                <FolderOpen /> Choose…
              </Button>
            </div>
            {!folder && (
              <FieldDescription className="text-xs">
                Pick a folder that's already a clone to connect it, or an empty folder to set up a new one.
              </FieldDescription>
            )}
            {inspecting && <p className="text-xs text-muted-foreground">Checking folder…</p>}
            {info?.state === 'clone' && (
              <p className="flex items-center gap-1.5 text-xs text-success">
                <Check className="size-3.5" />
                Already a clone of <strong className="font-mono">{info.repoOwner}/{info.repoName}</strong>
              </p>
            )}
            {info?.state === 'occupied' && <ErrorMessage>{info.error}</ErrorMessage>}
          </Field>

          {/* Name is asked in every usable case; the rest depends on the folder. */}
          {(info?.state === 'clone' || info?.state === 'empty') && (
            <Field>
              <FieldLabel htmlFor="ws-name">Name</FieldLabel>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={info.state === 'clone' ? info.repoName : 'My notes'}
                autoFocus
              />
            </Field>
          )}

          {/* Empty folder → the repo is still an open question. */}
          {info?.state === 'empty' && (
            <>
              {/* A radio group: `variant` alone conveyed the choice visually
                  but announced nothing to a screen reader. */}
              <div className="flex gap-2" role="radiogroup" aria-label="Repository source">
                <Button
                  role="radio"
                  aria-checked={mode === MODE.CREATE}
                  variant={mode === MODE.CREATE ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => { setMode(MODE.CREATE); setError(''); }}
                >
                  <Sparkles /> Create new repo
                </Button>
                <Button
                  role="radio"
                  aria-checked={mode === MODE.EXISTING}
                  variant={mode === MODE.EXISTING ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => { setMode(MODE.EXISTING); setError(''); }}
                >
                  <Link2 /> Clone existing
                </Button>
              </div>

              {mode === MODE.CREATE ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="ws-repo">Repository name</FieldLabel>
                    <Input
                      id="ws-repo"
                      className="font-mono text-[13px]"
                      value={repoNameTouched ? repoName : slugify(name)}
                      onChange={(e) => { setRepoNameTouched(true); setRepoName(e.target.value); }}
                      placeholder="my-notes"
                      spellCheck={false}
                    />
                    <FieldDescription className="text-xs">
                      Created under your GitHub account.
                    </FieldDescription>
                  </Field>
                  <label className="flex items-center gap-2 text-[13px]">
                    <Checkbox checked={isPrivate} onCheckedChange={(v) => setIsPrivate(!!v)} />
                    Private repository
                  </label>
                </>
              ) : (
                <Field>
                  <FieldLabel htmlFor="ws-repo-pick">Repository</FieldLabel>
                  <Input
                    id="ws-repo-pick"
                    className="font-mono text-[13px]"
                    value={repoFilter}
                    onChange={(e) => setRepoFilter(e.target.value)}
                    placeholder={repos === null ? 'Loading…' : 'Filter repositories…'}
                    spellCheck={false}
                  />
                  <ul className="m-0 max-h-[180px] list-none overflow-y-auto rounded-md border border-border p-1">
                    {filteredRepos.map((r) => (
                      <li key={r.full_name}>
                        <button
                          type="button"
                          onClick={() => setPicked(r)}
                          className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-accent ${picked?.full_name === r.full_name ? 'bg-selected text-primary' : ''}`}
                        >
                          <span className="truncate">{r.full_name}</span>
                          {r.private && <Badge variant="secondary">Private</Badge>}
                        </button>
                      </li>
                    ))}
                    {repos !== null && filteredRepos.length === 0 && (
                      <li className="px-2 py-1.5 text-xs text-muted-foreground">No matching repositories.</li>
                    )}
                  </ul>
                </Field>
              )}
            </>
          )}

          {error && <ErrorMessage>{error}</ErrorMessage>}
        </div>
        <DialogFooter>
          {/* Enabled during a clone on purpose. It doesn't abort — main finishes
              and the workspace appears in the list — but a long clone used to
              lock the dialog with no progress and no way out. */}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
