import React, { useEffect, useState } from 'react';
import { SETTINGS_SECTIONS } from './constants.js';
import { XIcon, CheckCircleIcon } from './Icons.jsx';
import WorkspacesSection from './settings/WorkspacesSection.jsx';
import AppearanceSection from './settings/AppearanceSection.jsx';
import AgentChatSection from './settings/AgentChatSection.jsx';
import WorkspaceSkillsSection from './settings/WorkspaceSkillsSection.jsx';
import BuiltinSkillsSection from './settings/BuiltinSkillsSection.jsx';
import AgentSecretsSection from './settings/AgentSecretsSection.jsx';
import DailyNoteSection from './settings/DailyNoteSection.jsx';
import TemplatesSection from './settings/TemplatesSection.jsx';
import TranscriptionSection from './settings/TranscriptionSection.jsx';
import SyncSection from './settings/SyncSection.jsx';
import UpdatesSection from './settings/UpdatesSection.jsx';

// Sidebar layout: section headers group related items. Header rows are
// non-interactive labels; item rows are the actual nav buttons. To add a new
// page, drop a new { kind: 'item', id, label } row under the relevant header.
const NAV = [
  { kind: 'header', label: 'General' },
  { kind: 'item', id: SETTINGS_SECTIONS.APPEARANCE, label: 'Appearance' },
  { kind: 'item', id: SETTINGS_SECTIONS.SYNC, label: 'GitHub Sync' },
  { kind: 'item', id: SETTINGS_SECTIONS.TRANSCRIPTION, label: 'Transcription' },
  { kind: 'item', id: SETTINGS_SECTIONS.UPDATES, label: 'Updates' },
  { kind: 'header', label: 'Workspaces' },
  { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACES, label: 'Manage' },
  { kind: 'item', id: SETTINGS_SECTIONS.DAILY_NOTE, label: 'Daily Notes' },
  { kind: 'item', id: SETTINGS_SECTIONS.TEMPLATES, label: 'Templates' },
  { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACE_SKILLS, label: 'Manage Skills' },
  { kind: 'header', label: 'AI Agent' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_LLM, label: 'Agent Chat' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_BUILTIN_SKILLS, label: 'Built-in Skills' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_SECRETS, label: 'API Secrets' },
];

const DEFAULT_SECTION = SETTINGS_SECTIONS.APPEARANCE;

// Per-workspace sections need an active workspace. Shown when none is open.
function NoWorkspaceNote() {
  return (
    <div className="settings-section">
      <div className="settings-empty">Open a workspace to configure this.</div>
    </div>
  );
}

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
  hideLineNumbers,
  onHideLineNumbersChange,
  dailyNotesInBookmarks,
  onDailyNotesInBookmarksChange,
  dailyNote,
  onDailyNoteChange,
  templates,
  onTemplatesChange,
  templateOptions,
  builtinSkills,
  onBuiltinSkillToggle,
  globalBuiltinSkills,
  onGlobalBuiltinSkillToggle,
  tree,
  workspacePath,
  codingAgent,
  onCodingAgentChange,
  agentSecrets,
  onAgentSecretsChange,
  transcription,
  onTranscriptionChange,
  sync,
  onSyncChange,
  onSyncDisabledChange,
  appUpdate,
  saveStatus,
}) {
  const [active, setActive] = useState(initialSection || DEFAULT_SECTION);

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
        {saveStatus && saveStatus !== 'idle' && (
          <div className="settings-save-status" data-status={saveStatus}>
            {saveStatus === 'saving' && <span>Saving…</span>}
            {saveStatus === 'error' && <span>Save failed</span>}
            {saveStatus === 'saved' && (
              <>
                <CheckCircleIcon size={14} />
                <span>Saved</span>
              </>
            )}
          </div>
        )}
        <button className="settings-close" onClick={onClose} aria-label="Close settings"><XIcon size={16} /></button>
        <nav className="settings-nav">
          {NAV.map((row, idx) => {
            if (row.kind === 'header') {
              return (
                <div key={`h-${idx}`} className="settings-nav-header">{row.label}</div>
              );
            }
            return (
              <button
                key={row.id}
                className={`settings-nav-item ${active === row.id ? 'active' : ''}`}
                onClick={() => setActive(row.id)}
              >
                {row.label}
              </button>
            );
          })}
        </nav>
        <div className="settings-detail">
          {active === SETTINGS_SECTIONS.APPEARANCE && (
            <AppearanceSection
              themeMode={themeMode}
              onThemeModeChange={onThemeModeChange}
              hideLineNumbers={hideLineNumbers}
              onHideLineNumbersChange={onHideLineNumbersChange}
              dailyNotesInBookmarks={dailyNotesInBookmarks}
              onDailyNotesInBookmarksChange={onDailyNotesInBookmarksChange}
            />
          )}
          {active === SETTINGS_SECTIONS.WORKSPACES && (
            <WorkspacesSection
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onAdd={onAddWorkspace}
              onSwitch={(id) => { onSwitchWorkspace(id); onClose(); }}
              onRemove={onRemoveWorkspace}
              syncPat={sync?.pat}
              pullIntervalSeconds={sync?.pullIntervalSeconds}
              disabledWorkspaceIds={sync?.disabledWorkspaceIds || []}
              onSyncDisabledChange={onSyncDisabledChange}
            />
          )}
          {/* Per-workspace config — applies to the ACTIVE workspace, stored in
              its `.shockwave/workspace.json`. */}
          {active === SETTINGS_SECTIONS.DAILY_NOTE && (
            workspacePath ? (
              <DailyNoteSection
                dailyNote={dailyNote}
                onDailyNoteChange={onDailyNoteChange}
                tree={tree}
                workspacePath={workspacePath}
                templateOptions={templateOptions}
              />
            ) : <NoWorkspaceNote />
          )}
          {active === SETTINGS_SECTIONS.TEMPLATES && (
            workspacePath ? (
              <TemplatesSection
                templates={templates}
                onTemplatesChange={onTemplatesChange}
                tree={tree}
                workspacePath={workspacePath}
              />
            ) : <NoWorkspaceNote />
          )}
          {active === SETTINGS_SECTIONS.WORKSPACE_SKILLS && (
            workspacePath ? (
              <WorkspaceSkillsSection
                workspacePath={workspacePath}
                builtinSkills={builtinSkills}
                globalBuiltinSkills={globalBuiltinSkills}
                onBuiltinSkillToggle={onBuiltinSkillToggle}
              />
            ) : <NoWorkspaceNote />
          )}
          {active === SETTINGS_SECTIONS.AGENT_BUILTIN_SKILLS && (
            <BuiltinSkillsSection
              globalBuiltinSkills={globalBuiltinSkills}
              onGlobalBuiltinSkillToggle={onGlobalBuiltinSkillToggle}
            />
          )}
          {active === SETTINGS_SECTIONS.SYNC && (
            <SyncSection
              sync={sync}
              onSyncChange={onSyncChange}
            />
          )}
          {active === SETTINGS_SECTIONS.TRANSCRIPTION && (
            <TranscriptionSection
              transcription={transcription}
              onTranscriptionChange={onTranscriptionChange}
            />
          )}
          {active === SETTINGS_SECTIONS.UPDATES && (
            <UpdatesSection appUpdate={appUpdate} />
          )}
          {active === SETTINGS_SECTIONS.AGENT_LLM && (
            <AgentChatSection
              codingAgent={codingAgent}
              onCodingAgentChange={onCodingAgentChange}
            />
          )}
          {active === SETTINGS_SECTIONS.AGENT_SECRETS && (
            <AgentSecretsSection
              secrets={agentSecrets ?? []}
              onChange={onAgentSecretsChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
