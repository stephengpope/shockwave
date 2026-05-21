import React, { useEffect, useState } from 'react';
import { SETTINGS_SECTIONS } from './constants.js';
import WorkspacesSection from './settings/WorkspacesSection.jsx';
import AppearanceSection from './settings/AppearanceSection.jsx';

const SECTIONS = [
  { id: SETTINGS_SECTIONS.APPEARANCE, label: 'Appearance' },
  { id: SETTINGS_SECTIONS.WORKSPACES, label: 'Workspaces' },
];

export default function SettingsModal({
  initialSection,
  onClose,
  workspaces,
  activeWorkspaceId,
  onAddWorkspace,
  onSwitchWorkspace,
  onRemoveWorkspace,
  themeMode,
  onThemeModeChange,
}) {
  const [active, setActive] = useState(initialSection || SECTIONS[0].id);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <button className="settings-close" onClick={onClose} aria-label="Close settings">×</button>
        <nav className="settings-nav">
          <div className="settings-nav-header">Options</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${active === s.id ? 'active' : ''}`}
              onClick={() => setActive(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-detail">
          {active === SETTINGS_SECTIONS.WORKSPACES && (
            <WorkspacesSection
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onAdd={onAddWorkspace}
              onSwitch={(id) => { onSwitchWorkspace(id); onClose(); }}
              onRemove={onRemoveWorkspace}
            />
          )}
          {active === SETTINGS_SECTIONS.APPEARANCE && (
            <AppearanceSection
              themeMode={themeMode}
              onChange={onThemeModeChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
