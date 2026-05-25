import React, { useEffect, useRef, useState } from 'react';
import { GearIcon, ChevronDownIcon } from './Icons.jsx';

export default function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onManage,
  onOpenSettings,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const active = workspaces.find((w) => w.id === activeWorkspaceId) || null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="workspace-selector" ref={rootRef}>
      {open && (
        <div className="workspace-popover">
          {workspaces.length === 0 ? (
            <div className="workspace-popover-empty">No workspaces yet</div>
          ) : (
            workspaces.map((w) => (
              <button
                key={w.id}
                className={`workspace-popover-item ${w.id === activeWorkspaceId ? 'active' : ''}`}
                onClick={() => { setOpen(false); onSwitch(w.id); }}
                title={w.path}
              >
                {w.name}
              </button>
            ))
          )}
          <div className="workspace-popover-divider" />
          <button
            className="workspace-popover-item"
            onClick={() => { setOpen(false); onManage(); }}
          >
            Manage workspaces…
          </button>
        </div>
      )}
      <button
        className="workspace-selector-main"
        onClick={() => setOpen((v) => !v)}
        title={active?.path ?? 'No workspace open'}
      >
        <span className="workspace-selector-name">{active ? active.name : 'No workspace'}</span>
        <span className="workspace-selector-chevron" aria-hidden="true"><ChevronDownIcon size={12} /></span>
      </button>
      <button
        className="workspace-selector-gear"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Open settings"
      >
        <GearIcon size={16} />
      </button>
    </div>
  );
}
