import React, { useState } from 'react';
import { SETTINGS_SECTIONS } from './constants.js';
import { CheckCircleIcon } from './Icons.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import WorkspacesSection from './settings/WorkspacesSection.jsx';
import AppearanceSection from './settings/AppearanceSection.jsx';
import AgentChatSection from './settings/AgentChatSection.jsx';
import CronSection from './settings/CronSection.jsx';
import WorkspaceSkillsSection from './settings/WorkspaceSkillsSection.jsx';
import AgentSecretsSection from './settings/AgentSecretsSection.jsx';
import DailyNoteSection from './settings/DailyNoteSection.jsx';
import TemplatesSection from './settings/TemplatesSection.jsx';
import TranscriptionSection from './settings/TranscriptionSection.jsx';
import SyncSection from './settings/SyncSection.jsx';
import UpdatesSection from './settings/UpdatesSection.jsx';
import AdvancedSection from './settings/AdvancedSection.jsx';

// Sidebar layout: section headers group related items. Header rows are
// non-interactive labels; item rows are the actual nav buttons. To add a new
// page, drop a new { kind: 'item', id, label } row under the relevant header.
//
// "Workspaces" (the list/create/switch picker) is a GLOBAL concern, so it lives
// under General — it's not configuration *of* a workspace. The second group
// holds per-(active-)workspace pages and is labeled with the active workspace's
// name so it reads as scoped to it. `workspaceLabel` is passed in at render.
function buildNav(workspaceLabel) {
  return [
    { kind: 'header', label: 'General' },
    { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACES, label: 'Workspaces' },
    { kind: 'item', id: SETTINGS_SECTIONS.APPEARANCE, label: 'Appearance' },
    { kind: 'item', id: SETTINGS_SECTIONS.SYNC, label: 'GitHub Sync' },
    { kind: 'item', id: SETTINGS_SECTIONS.TRANSCRIPTION, label: 'Transcription' },
    { kind: 'item', id: SETTINGS_SECTIONS.UPDATES, label: 'Updates' },
    { kind: 'item', id: SETTINGS_SECTIONS.ADVANCED, label: 'Advanced' },
    { kind: 'header', label: workspaceLabel },
    { kind: 'item', id: SETTINGS_SECTIONS.DAILY_NOTE, label: 'Daily Notes' },
    { kind: 'item', id: SETTINGS_SECTIONS.TEMPLATES, label: 'Templates' },
    { kind: 'item', id: SETTINGS_SECTIONS.WORKSPACE_SKILLS, label: 'Manage Skills' },
    { kind: 'header', label: 'AI Agent' },
    { kind: 'item', id: SETTINGS_SECTIONS.AGENT_LLM, label: 'Agent Chat' },
    { kind: 'item', id: SETTINGS_SECTIONS.AGENT_SECRETS, label: 'API Secrets' },
    { kind: 'item', id: SETTINGS_SECTIONS.CRON, label: 'Cron Settings' },
  ];
}

const DEFAULT_SECTION = SETTINGS_SECTIONS.APPEARANCE;

// Per-workspace sections need an active workspace. Shown when none is open.
function NoWorkspaceNote() {
  return (
    <div className="px-7 py-6 text-sm text-muted-foreground">
      Open a workspace to configure this.
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
  treePanel,
  onTreePanelChange,
  dailyNote,
  onDailyNoteChange,
  templates,
  onTemplatesChange,
  templateOptions,
  builtinSkills,
  onBuiltinSkillToggle,
  tree,
  workspacePath,
  codingAgent,
  onCodingAgentChange,
  agentSecrets,
  onAgentSecretsChange,
  onReloadSecrets,
  transcription,
  onTranscriptionChange,
  sync,
  onSyncChange,
  onSyncDisabledChange,
  onRebuildCache,
  appUpdate,
  saveStatus,
  onOpenCronPanel,
}) {
  const [active, setActive] = useState(initialSection || DEFAULT_SECTION);

  const activeWs = (workspaces || []).find((w) => w.id === activeWorkspaceId);
  const workspaceLabel = activeWs ? `Workspace · ${activeWs.name}` : 'Workspace';
  const NAV = buildNav(workspaceLabel);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex h-[620px] max-h-[85vh] w-[780px] max-w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-[780px]">
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Application settings</DialogDescription>
        </DialogHeader>
        {saveStatus && saveStatus !== 'idle' && (
          <div
            className={cn(
              'absolute right-12 top-3.5 z-10 flex items-center gap-1.5 text-xs',
              saveStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
              saveStatus === 'saved' && 'text-success',
            )}
          >
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
        <nav className="flex w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-2.5 pt-4">
          {NAV.map((row, idx) => {
            if (row.kind === 'header') {
              return (
                <div
                  key={`h-${idx}`}
                  className={cn(
                    'px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-2',
                    idx === 0 ? 'pt-1.5' : 'pt-4',
                  )}
                >
                  {row.label}
                </div>
              );
            }
            return (
              <button
                key={row.id}
                className={cn(
                  'rounded-lg px-3 py-[7px] text-left text-[13px] text-foreground/75 hover:bg-accent',
                  active === row.id && 'bg-selected font-medium text-selected-foreground hover:bg-selected',
                )}
                onClick={() => setActive(row.id)}
              >
                {row.label}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {active === SETTINGS_SECTIONS.APPEARANCE && (
            <AppearanceSection
              themeMode={themeMode}
              onThemeModeChange={onThemeModeChange}
              hideLineNumbers={hideLineNumbers}
              onHideLineNumbersChange={onHideLineNumbersChange}
              treePanel={treePanel}
              onTreePanelChange={onTreePanelChange}
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
                onBuiltinSkillToggle={onBuiltinSkillToggle}
              />
            ) : <NoWorkspaceNote />
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
          {active === SETTINGS_SECTIONS.ADVANCED && (
            <AdvancedSection
              hasWorkspace={!!workspacePath}
              onRebuildCache={onRebuildCache}
            />
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
              onReload={onReloadSecrets}
            />
          )}
          {active === SETTINGS_SECTIONS.CRON && <CronSection onOpenCronPanel={onOpenCronPanel} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
