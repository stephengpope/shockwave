import React, { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import Dialog from '../Dialog.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import ErrorMessage from '../ErrorMessage.jsx';
import { SettingsSection } from './SectionUI';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

function formatUpdated(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function nameKey(s) {
  return (s ?? '').trim().toLowerCase();
}

// Dialog body for both Add and Edit modes. `editing` is null for Add, or the
// secret being edited. The form is uncontrolled-by-key — we reset state when
// the editing target changes.
function SecretFormDialog({ open, editing, secrets, onSubmit, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setToken(editing?.token ?? '');
    setShowToken(false);
    setError(null);
  }, [open, editing]);

  const trimmedName = name.trim();
  const editingKey = editing ? nameKey(editing.name) : null;
  const duplicateName = !!trimmedName
    && (secrets ?? []).some((s) => nameKey(s.name) === nameKey(trimmedName) && nameKey(s.name) !== editingKey);
  const canSubmit = trimmedName && token && !duplicateName;

  const submit = (e) => {
    e.preventDefault();
    setError(null);
    if (!trimmedName) return setError('Name is required.');
    if (!token) return setError('Token is required.');
    if (duplicateName) return setError('A secret with this name already exists.');
    onSubmit({ name: trimmedName, description: description.trim(), token });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : 'Add secret'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {editing ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="secret-name">Name</FieldLabel>
          <Input
            id="secret-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GITHUB_TOKEN"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          {duplicateName && (
            <p className="text-xs text-destructive">
              A secret with this name already exists.
            </p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="secret-description">Description</FieldLabel>
          <Input
            id="secret-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — what this token is for"
            autoComplete="off"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="secret-token">Token</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="secret-token"
              className="font-mono"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Hide' : 'Show'}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>

        {error && <ErrorMessage>{error}</ErrorMessage>}

        {/* Submit button rendered in dialog footer; this hidden submit lets
            Enter in the form fire the same submit handler. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

export default function AgentSecretsSection({ secrets, onChange }) {
  // null = dialog closed. {} = Add mode. {name,...} = Edit mode for that secret.
  const [dialogTarget, setDialogTarget] = useState<any>(null);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);

  const dialogOpen = dialogTarget !== null;
  const editing = dialogTarget && dialogTarget.name ? dialogTarget : null;

  const onSubmit = ({ name, description, token }) => {
    const now = Date.now();
    const list = secrets ?? [];
    let next;
    if (editing) {
      next = list.map((s) =>
        nameKey(s.name) === nameKey(editing.name)
          ? { ...s, name, description, token, updatedAt: now }
          : s,
      );
    } else {
      next = [...list, { name, description, token, createdAt: now, updatedAt: now }];
    }
    onChange(next);
    setDialogTarget(null);
  };

  const onDelete = (n) => {
    onChange((secrets ?? []).filter((s) => s.name !== n));
    setConfirmDelete(null);
  };

  return (
    <SettingsSection
      wide
      title="API Secrets"
      description="Store API tokens (GitHub, Linear, etc.) for the coding agent. Tokens are encrypted on this machine using your OS keychain. Names must be unique."
    >
      <Button variant="outline" size="sm" className="w-fit" onClick={() => setDialogTarget({})}>
        <Plus />
        Add secret
      </Button>

      {(!secrets || secrets.length === 0) ? (
        <div className="text-[13px] text-muted-foreground">No secrets yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {secrets.map((s) => (
            <li
              key={s.name}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
              role="button"
              tabIndex={0}
              onClick={() => setDialogTarget(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setDialogTarget(s);
                }
              }}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-foreground">{s.name}</div>
                {s.description && (
                  <div className="truncate text-xs text-muted-foreground" title={s.description}>{s.description}</div>
                )}
                <div className="text-xs text-muted-foreground">Updated {formatUpdated(s.updatedAt)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDialogTarget(s)}
                  title={`Edit ${s.name}`}
                  aria-label={`Edit ${s.name}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setConfirmDelete(s.name)}
                  title={`Delete ${s.name}`}
                  aria-label={`Delete ${s.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <SecretFormDialog
        open={dialogOpen}
        editing={editing}
        secrets={secrets ?? []}
        onSubmit={onSubmit}
        onClose={() => setDialogTarget(null)}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete secret"
        message={confirmDelete ? `Delete "${confirmDelete}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => onDelete(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </SettingsSection>
  );
}
