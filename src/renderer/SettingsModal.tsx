import React, { useEffect, useState } from 'react';
import { SETTINGS_SECTIONS } from './constants.js';
import { XIcon, CheckCircleIcon } from './Icons.jsx';
import WorkspacesSection from './settings/WorkspacesSection.jsx';
import AppearanceSection from './settings/AppearanceSection.jsx';
import AgentChatSection from './settings/AgentChatSection.jsx';
import AiSkillsTab from './settings/AiSkillsTab.jsx';
import WorkspaceSkillsTab from './settings/WorkspaceSkillsTab.jsx';
import AgentSecretsSection from './settings/AgentSecretsSection.jsx';
import DailyNoteSection from './settings/DailyNoteSection.jsx';
import TranscriptionSection from './settings/TranscriptionSection.jsx';
import SyncSection from './settings/SyncSection.jsx';

// Sidebar layout: section headers group related items. Header rows are
// non-interactive labels; item rows are the actual nav buttons. To add a new
// page, drop a new { kind: 'item', id, label } row under the relevant header.
const NAV = [
  { kind: 'header', label: 'General' },
  { kind: 'item', id: SETTINGS_SECTIONS.APPEARANCE, label: 'Appearance' },
  { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACES, label: 'Workspaces' },
  { kind: 'item', id: SETTINGS_SECTIONS.DAILY_NOTE, label: 'Daily Notes' },
  { kind: 'item', id: SETTINGS_SECTIONS.SYNC, label: 'GitHub Sync' },
  { kind: 'item', id: SETTINGS_SECTIONS.TRANSCRIPTION, label: 'Transcription' },
  { kind: 'header', label: 'AI Agent' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_LLM, label: 'Agent Chat' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_SKILLS, label: 'Global Skills' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_WORKSPACE_SKILLS, label: 'Workspace Skills' },
  { kind: 'item', id: SETTINGS_SECTIONS.AGENT_SECRETS, label: 'API Secrets' },
];

const DEFAULT_SECTION = SETTINGS_SECTIONS.APPEARANCE;

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
  dailyNote,
  onDailyNoteChange,
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

  const caSkills = codingAgent?.skills ?? { global: {}, workspaces: {} };
  const onSkillsChange = (nextSkills) => onCodingAgentChange?.({
    ...codingAgent,
    skills: nextSkills,
  });

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
          {active === SETTINGS_SECTIONS.DAILY_NOTE && (
            <DailyNoteSection
              dailyNote={dailyNote}
              onDailyNoteChange={onDailyNoteChange}
              tree={tree}
              workspacePath={workspacePath}
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
          {active === SETTINGS_SECTIONS.AGENT_LLM && (
            <AgentChatSection
              codingAgent={codingAgent}
              onCodingAgentChange={onCodingAgentChange}
            />
          )}
          {active === SETTINGS_SECTIONS.AGENT_SKILLS && (
            <div className="settings-section">
              <h2 className="settings-section-title">Global Skills</h2>
              <AiSkillsTab skills={caSkills} onSkillsChange={onSkillsChange} />
            </div>
          )}
          {active === SETTINGS_SECTIONS.AGENT_WORKSPACE_SKILLS && (
            <div className="settings-section">
              <h2 className="settings-section-title">Workspace Skills</h2>
              <WorkspaceSkillsTab
                skills={caSkills}
                onSkillsChange={onSkillsChange}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
              />
            </div>
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
