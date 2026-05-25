import React, { useEffect, useMemo, useState } from 'react';
import Dialog from '../Dialog.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import ErrorMessage from '../ErrorMessage.jsx';
import { TrashIcon, PencilIcon } from '../Icons.jsx';

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
  const [error, setError] = useState(null);

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
          <button className="dialog-button" onClick={onClose}>Cancel</button>
          <button
            className="dialog-button dialog-button-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {editing ? 'Save' : 'Add'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <div className="settings-field">
          <label className="settings-field-label" htmlFor="secret-name">Name</label>
          <input
            id="secret-name"
            className="settings-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GITHUB_TOKEN"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          {duplicateName && (
            <p className="settings-field-hint" style={{ color: 'var(--fg-error)' }}>
              A secret with this name already exists.
            </p>
          )}
        </div>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="secret-description">Description</label>
          <input
            id="secret-description"
            className="settings-input"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — what this token is for"
            autoComplete="off"
          />
        </div>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="secret-token">Token</label>
          <div className="settings-input-row">
            <input
              id="secret-token"
              className="settings-input"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            <button
              type="button"
              className="settings-input-toggle"
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {error && <ErrorMessage>{error}</ErrorMessage>}

        {/* Submit button rendered in dialog footer; this hidden submit lets
            Enter in the form fire the same submit handler. */}
        <button type="submit" style={{ display: 'none' }} aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

export default function AgentSecretsSection({ secrets, onChange }) {
  // null = dialog closed. {} = Add mode. {name,...} = Edit mode for that secret.
  const [dialogTarget, setDialogTarget] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

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
    <div className="settings-section">
      <h2 className="settings-section-title">API Secrets</h2>
      <p className="settings-section-desc">
        Store API tokens (GitHub, Linear, etc.) for the coding agent. Tokens are encrypted on
        this machine using your OS keychain. Names must be unique.
      </p>

      <button className="workspace-add" onClick={() => setDialogTarget({})}>
        + Add secret
      </button>

      <h3 className="settings-subsection-title" style={{ marginTop: 24 }}>Saved secrets</h3>
      {(!secrets || secrets.length === 0) ? (
        <div className="settings-empty">No secrets yet.</div>
      ) : (
        <ul className="workspace-list">
          {secrets.map((s) => (
            <li
              key={s.name}
              className="workspace-row"
              role="button"
              tabIndex={0}
              onClick={() => setDialogTarget(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setDialogTarget(s);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <div className="workspace-meta">
                <div className="workspace-name">{s.name}</div>
                {s.description && (
                  <div className="workspace-path" title={s.description}>{s.description}</div>
                )}
                <div className="workspace-path">Updated {formatUpdated(s.updatedAt)}</div>
              </div>
              <div className="workspace-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  onClick={() => setDialogTarget(s)}
                  title={`Edit ${s.name}`}
                  aria-label={`Edit ${s.name}`}
                >
                  <PencilIcon size={14} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setConfirmDelete(s.name)}
                  title={`Delete ${s.name}`}
                  aria-label={`Delete ${s.name}`}
                >
                  <TrashIcon size={14} />
                </button>
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
    </div>
  );
}
