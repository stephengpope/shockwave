import React, { useState } from 'react';
import ConfirmDialog from '../ConfirmDialog.jsx';
import { TrashIcon } from '../Icons.jsx';

export default function WorkspacesSection({
  workspaces,
  activeWorkspaceId,
  onAdd,
  onSwitch,
  onRemove,
}) {
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const target = workspaces.find((w) => w.id === confirmRemoveId) ?? null;
  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Workspaces</h2>
      <p className="settings-section-desc">
        Workspaces let you switch between different folders of files. Each workspace keeps its own
        files and link graph. The folder on disk is never modified by adding or removing a workspace
        from this list.
      </p>

      {workspaces.length === 0 ? (
        <div className="settings-empty">No workspaces yet.</div>
      ) : (
        <ul className="workspace-list">
          {workspaces.map((ws) => (
            <li key={ws.id} className="workspace-row">
              <div className="workspace-meta">
                <div className="workspace-name">
                  {ws.name}
                  {ws.id === activeWorkspaceId && <span className="workspace-active-badge">Active</span>}
                </div>
                <div className="workspace-path" title={ws.path}>{ws.path}</div>
              </div>
              <div className="workspace-actions">
                <button
                  onClick={() => onSwitch(ws.id)}
                  disabled={ws.id === activeWorkspaceId}
                >
                  Open
                </button>
                <button
                  className="workspace-remove icon-btn"
                  onClick={() => setConfirmRemoveId(ws.id)}
                  title={`Remove ${ws.name}`}
                  aria-label={`Remove ${ws.name}`}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button className="workspace-add" onClick={onAdd}>+ Add workspace</button>

      <ConfirmDialog
        open={!!target}
        title="Remove workspace"
        message={target ? `Remove "${target.name}" from this list? The folder on disk is not deleted.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { onRemove(confirmRemoveId); setConfirmRemoveId(null); }}
        onClose={() => setConfirmRemoveId(null)}
      />
    </div>
  );
}
