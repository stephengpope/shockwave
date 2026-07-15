import { useState, useRef, useCallback } from 'react';
import { useSyncRef } from './useSyncRef';
import { THEME_MODES, VIEW_MODES, TREE_SORT_ORDERS, DEFAULT_PROVIDER_SLUG } from '../constants';
import type { Settings, WorkspaceData, ThemeMode, ViewMode, TreeSortOrder, CodingAgentSettings, AgentSecret } from '../../shared/settings';

// dailyNote + templates moved to the per-workspace WorkspaceData.
type DailyNote = WorkspaceData['dailyNote'];
type Templates = WorkspaceData['templates'];
type Transcription = Settings['transcription'];
type SyncSettings = Settings['sync'];

// Default canonical object — mirrors main's DEFAULT_SETTINGS + the renderer
// fallbacks. Seeded for real from disk via hydrate() before any user action.
const DEFAULT_CANONICAL: Settings = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: THEME_MODES.SYSTEM, hideLineNumbers: false, dailyNotesInBookmarks: false },
  codingAgent: { provider: DEFAULT_PROVIDER_SLUG, model: 'claude-sonnet-4-5', providerKeys: {}, baseUrl: '', thinkingLevel: 'medium' },
  agentSecrets: [],
  transcription: { provider: 'assemblyai', apiKey: '' },
  sync: { pat: '', pullIntervalSeconds: 10, disabledWorkspaceIds: [] },
  chatSidebarOpen: false,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: VIEW_MODES.LIVE,
  treeSortOrder: TREE_SORT_ORDERS.NAME_ASC,
  bookmarkFilterActive: false,
  windowBounds: null,
};

interface UseSettingsOpts {
  // Needed for onSyncChange to restart the sync engine for the active workspace.
  activeWorkspacePath: string | null;
}

// Owns everything persisted to settings.json: the per-field UI state, the one
// canonical settingsRef (the single source of truth a save writes), the save-
// status badge, persistSettings (the shared writer — callers pass only what
// changed), the per-field change handlers, and hydrate() to seed from disk on
// boot. Non-settings persisted fields (workspaces, viewMode, sidebar widths)
// flow through persistSettings too; their UI state lives in App.
export function useSettings({ activeWorkspacePath }: UseSettingsOpts) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(THEME_MODES.SYSTEM);
  const [hideLineNumbers, setHideLineNumbers] = useState(false);
  const [dailyNotesInBookmarks, setDailyNotesInBookmarks] = useState(false);
  // Live + persisted bookmark-filter mode (single source of truth; useBookmarks
  // no longer owns this so the view can survive restarts / workspace switches).
  const [bookmarkFilterActive, setBookmarkFilterActiveState] = useState(false);
  const [dailyNote, setDailyNote] = useState<DailyNote>({ format: 'YYYY-MM-DD', folder: '', templatePath: '' });
  const dailyNoteRef = useSyncRef(dailyNote);
  const [templates, setTemplates] = useState<Templates>({ folder: '' });
  // Per-workspace built-in skill toggles: folderName → 'enabled' | 'disabled'.
  // Absent ⇒ enabled (default-on). Loaded with the workspace; written to its file.
  const [builtinSkills, setBuiltinSkills] = useState<Record<string, 'enabled' | 'disabled'>>({});
  const [treeSortOrder, setTreeSortOrder] = useState<TreeSortOrder>(TREE_SORT_ORDERS.NAME_ASC);
  const [codingAgentSettings, setCodingAgentSettings] = useState<CodingAgentSettings>(DEFAULT_CANONICAL.codingAgent);
  const [agentSecrets, setAgentSecrets] = useState<AgentSecret[]>([]);
  const [transcription, setTranscription] = useState<Transcription>({ provider: 'assemblyai', apiKey: '' });
  const [sync, setSync] = useState<SyncSettings>({ pat: '', pullIntervalSeconds: 10, disabledWorkspaceIds: [] });
  const syncRef = useSyncRef(sync);

  // The single canonical copy of everything persisted. A save merges the caller's
  // patch into this and writes the WHOLE object, so no field can be dropped by a
  // stale per-field value.
  const settingsRef = useRef<Settings>(DEFAULT_CANONICAL);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const inFlightSavesRef = useRef(0);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSettings = useCallback(async (next: Partial<Settings>) => {
    const s = { ...settingsRef.current, ...next };
    settingsRef.current = s;
    inFlightSavesRef.current += 1;
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
    setSaveStatus('saving');
    try {
      await window.api.settings.write({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        appearance: { themeMode: s.appearance.themeMode, hideLineNumbers: s.appearance.hideLineNumbers, dailyNotesInBookmarks: s.appearance.dailyNotesInBookmarks },
        treeSortOrder: s.treeSortOrder,
        bookmarkFilterActive: s.bookmarkFilterActive,
        codingAgent: s.codingAgent,
        agentSecrets: s.agentSecrets,
        transcription: s.transcription,
        sync: s.sync,
        sidebarWidth: s.sidebarWidth,
        viewMode: s.viewMode,
        chatSidebarOpen: s.chatSidebarOpen,
        chatSidebarWidth: s.chatSidebarWidth,
      });
      inFlightSavesRef.current -= 1;
      if (inFlightSavesRef.current === 0) {
        setSaveStatus('saved');
        savedFadeTimerRef.current = setTimeout(() => {
          savedFadeTimerRef.current = null;
          setSaveStatus('idle');
        }, 1500);
      }
    } catch {
      inFlightSavesRef.current -= 1;
      setSaveStatus('error');
    }
  }, []);

  // persistSettings stores appearance flat for callers, so settingsRef.appearance
  // must always be coherent. The theme/hideLineNumbers handlers patch the nested
  // appearance object explicitly.
  const onThemeModeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, themeMode: mode } });
  }, [persistSettings]);

  const onHideLineNumbersChange = useCallback(async (next: boolean) => {
    setHideLineNumbers(next);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, hideLineNumbers: next } });
  }, [persistSettings]);

  const onDailyNotesInBookmarksChange = useCallback(async (next: boolean) => {
    setDailyNotesInBookmarks(next);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, dailyNotesInBookmarks: next } });
  }, [persistSettings]);

  // Toggle/persist the bookmark-filter view. Sets React state synchronously so
  // the tree re-renders immediately; the write is fire-and-forget.
  const onBookmarkFilterActiveChange = useCallback((next: boolean) => {
    setBookmarkFilterActiveState(next);
    persistSettings({ bookmarkFilterActive: next });
  }, [persistSettings]);

  // Daily-note + templates are per-workspace now: they live in the active
  // workspace's `.shockwave/workspace.json`, not global settings.json. Writes
  // go through workspaceSettings.update (active workspace only); loads happen on
  // workspace switch via loadWorkspaceData().
  const onDailyNoteChange = useCallback(async (next: DailyNote) => {
    setDailyNote(next);
    dailyNoteRef.current = next;
    if (activeWorkspacePath) await window.api.workspaceSettings.update(activeWorkspacePath, { dailyNote: next });
  }, [dailyNoteRef, activeWorkspacePath]);

  const onTemplatesChange = useCallback(async (next: Templates) => {
    setTemplates(next);
    if (activeWorkspacePath) await window.api.workspaceSettings.update(activeWorkspacePath, { templates: next });
  }, [activeWorkspacePath]);

  // Seed daily-note + templates from a loaded workspace-data object (called by
  // App's loadWorkspace). Resets to defaults when data is null.
  const loadWorkspaceData = useCallback((data: any) => {
    const dn: DailyNote = {
      format: data?.dailyNote?.format || 'YYYY-MM-DD',
      folder: data?.dailyNote?.folder ?? '',
      templatePath: data?.dailyNote?.templatePath ?? '',
    };
    const tpl: Templates = { folder: data?.templates?.folder ?? '' };
    setDailyNote(dn);
    dailyNoteRef.current = dn;
    setTemplates(tpl);
    setBuiltinSkills(data?.builtinSkills && typeof data.builtinSkills === 'object' ? data.builtinSkills : {});
  }, [dailyNoteRef]);

  // Per-workspace built-in on/off. Built-ins are default-on (absent key ⇒
  // enabled); this writes an explicit value only when the user changes it.
  const onBuiltinSkillToggle = useCallback(async (folderName: string, enabled: boolean) => {
    setBuiltinSkills((prev) => {
      const next = { ...prev, [folderName]: enabled ? 'enabled' : 'disabled' } as Record<string, 'enabled' | 'disabled'>;
      if (activeWorkspacePath) window.api.workspaceSettings.update(activeWorkspacePath, { builtinSkills: next }).catch(() => {});
      return next;
    });
  }, [activeWorkspacePath]);

  const onTreeSortOrderChange = useCallback(async (next: TreeSortOrder) => {
    setTreeSortOrder(next);
    await persistSettings({ treeSortOrder: next });
  }, [persistSettings]);

  const onCodingAgentChange = useCallback(async (next: CodingAgentSettings) => {
    setCodingAgentSettings(next);
    await persistSettings({ codingAgent: next });
  }, [persistSettings]);

  const onAgentSecretsChange = useCallback(async (next: AgentSecret[]) => {
    setAgentSecrets(next);
    await persistSettings({ agentSecrets: next });
  }, [persistSettings]);

  // Re-seed agentSecrets from disk WITHOUT persisting. The OAuth connect/refresh
  // flow writes tokens directly from main (tokens never round-trip through a
  // renderer-initiated save), so after a Connect/Disconnect the in-memory copy
  // is stale. This pulls the fresh array back in and keeps settingsRef coherent
  // so a later persist can't clobber the tokens main just wrote.
  const reloadAgentSecrets = useCallback(async () => {
    const disk = await window.api.settings.read();
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];
    setAgentSecrets(secrets);
    settingsRef.current = { ...settingsRef.current, agentSecrets: secrets };
  }, []);

  const onTranscriptionChange = useCallback(async (next: Transcription) => {
    setTranscription(next);
    await persistSettings({ transcription: next });
  }, [persistSettings]);

  // Per-workspace sync disable toggle. Persisted via IPC elsewhere; we mirror the
  // disabled-set into local state + keep settingsRef coherent so a later save
  // doesn't write a stale sync.
  const onSyncDisabledChange = useCallback((workspaceId: string, disabled: boolean) => {
    setSync((prev) => {
      const cur = new Set(prev.disabledWorkspaceIds || []);
      if (disabled) cur.add(workspaceId);
      else cur.delete(workspaceId);
      const next = { ...prev, disabledWorkspaceIds: [...cur] };
      syncRef.current = next;
      settingsRef.current = { ...settingsRef.current, sync: next };
      return next;
    });
  }, [syncRef]);

  const onSyncChange = useCallback(async (next: SyncSettings) => {
    setSync(next);
    syncRef.current = next;
    await persistSettings({ sync: next });
    // Restart the engine so PAT / interval changes take effect immediately.
    if (activeWorkspacePath) {
      window.api.sync.engineStart({ workspacePath: activeWorkspacePath, intervalSeconds: next.pullIntervalSeconds }).catch(() => {});
    }
  }, [persistSettings, activeWorkspacePath, syncRef]);

  // Seed everything from the on-disk settings object at boot, BEFORE any save can
  // fire (so an unchanged field isn't written as its default and clobbered).
  const hydrateSettings = useCallback((disk: any) => {
    const tr: Transcription = { provider: disk.transcription?.provider || 'assemblyai', apiKey: disk.transcription?.apiKey || '' };
    const sy: SyncSettings = {
      pat: disk.sync?.pat || '',
      pullIntervalSeconds: typeof disk.sync?.pullIntervalSeconds === 'number' && disk.sync.pullIntervalSeconds > 0 ? disk.sync.pullIntervalSeconds : 10,
      disabledWorkspaceIds: Array.isArray(disk.sync?.disabledWorkspaceIds) ? disk.sync.disabledWorkspaceIds : [],
    };
    const tm: ThemeMode = disk.appearance?.themeMode || THEME_MODES.SYSTEM;
    const hln = !!disk.appearance?.hideLineNumbers;
    const dnb = !!disk.appearance?.dailyNotesInBookmarks;
    const bfa = !!disk.bookmarkFilterActive;
    const tso: TreeSortOrder = typeof disk.treeSortOrder === 'string' ? disk.treeSortOrder : TREE_SORT_ORDERS.NAME_ASC;
    const ca: CodingAgentSettings = disk.codingAgent ?? settingsRef.current.codingAgent;
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];

    settingsRef.current = {
      workspaces: disk.workspaces || [],
      activeWorkspaceId: disk.activeWorkspaceId ?? null,
      appearance: { themeMode: tm, hideLineNumbers: hln, dailyNotesInBookmarks: dnb },
      codingAgent: ca,
      agentSecrets: secrets,
      transcription: tr,
      sync: sy,
      chatSidebarOpen: typeof disk.chatSidebarOpen === 'boolean' ? disk.chatSidebarOpen : false,
      chatSidebarWidth: typeof disk.chatSidebarWidth === 'number' ? disk.chatSidebarWidth : 360,
      sidebarWidth: typeof disk.sidebarWidth === 'number' ? disk.sidebarWidth : 260,
      viewMode: disk.viewMode === VIEW_MODES.RAW || disk.viewMode === VIEW_MODES.LIVE ? disk.viewMode : VIEW_MODES.LIVE,
      treeSortOrder: tso,
      bookmarkFilterActive: bfa,
      windowBounds: disk.windowBounds ?? null,
    };
    setThemeMode(tm);
    setHideLineNumbers(hln);
    setDailyNotesInBookmarks(dnb);
    setBookmarkFilterActiveState(bfa);
    setTreeSortOrder(tso);
    if (disk.codingAgent) setCodingAgentSettings(ca);
    if (Array.isArray(disk.agentSecrets)) setAgentSecrets(secrets);
    if (disk.transcription) setTranscription(tr);
    if (disk.sync) { setSync(sy); syncRef.current = sy; }
  }, [dailyNoteRef, syncRef]);

  return {
    themeMode, hideLineNumbers, dailyNotesInBookmarks, bookmarkFilterActive,
    dailyNote, dailyNoteRef, templates, builtinSkills, treeSortOrder,
    codingAgentSettings, agentSecrets, transcription, sync, syncRef,
    settingsRef, saveStatus, persistSettings, hydrateSettings, loadWorkspaceData,
    onThemeModeChange, onHideLineNumbersChange, onDailyNotesInBookmarksChange,
    onBookmarkFilterActiveChange, onDailyNoteChange, onTemplatesChange, onBuiltinSkillToggle, onTreeSortOrderChange,
    onCodingAgentChange, onAgentSecretsChange, reloadAgentSecrets, onTranscriptionChange,
    onSyncChange, onSyncDisabledChange,
  };
}
