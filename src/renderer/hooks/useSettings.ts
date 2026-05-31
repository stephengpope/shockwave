import { useState, useRef, useCallback } from 'react';
import { useSyncRef } from './useSyncRef';
import { THEME_MODES, VIEW_MODES, TREE_SORT_ORDERS, DEFAULT_PROVIDER_SLUG } from '../constants';
import type { Settings, ThemeMode, ViewMode, TreeSortOrder, CodingAgentSettings, AgentSecret } from '../../shared/settings';

type DailyNote = Settings['dailyNote'];
type Transcription = Settings['transcription'];
type SyncSettings = Settings['sync'];

// Default canonical object — mirrors main's DEFAULT_SETTINGS + the renderer
// fallbacks. Seeded for real from disk via hydrate() before any user action.
const DEFAULT_CANONICAL: Settings = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: THEME_MODES.SYSTEM, hideLineNumbers: false },
  dailyNote: { format: 'YYYY-MM-DD', folder: '' },
  codingAgent: { provider: DEFAULT_PROVIDER_SLUG, model: 'claude-sonnet-4-5', apiKey: '', baseUrl: '', systemPrompt: '', skills: { global: {}, workspaces: {} } },
  agentSecrets: [],
  transcription: { provider: 'assemblyai', apiKey: '' },
  sync: { pat: '', pullIntervalSeconds: 10, disabledWorkspaceIds: [] },
  chatSidebarOpen: false,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: VIEW_MODES.LIVE,
  treeSortOrder: TREE_SORT_ORDERS.NAME_ASC,
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
  const [dailyNote, setDailyNote] = useState<DailyNote>({ format: 'YYYY-MM-DD', folder: '' });
  const dailyNoteRef = useSyncRef(dailyNote);
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
        appearance: { themeMode: s.appearance.themeMode, hideLineNumbers: s.appearance.hideLineNumbers },
        dailyNote: s.dailyNote,
        treeSortOrder: s.treeSortOrder,
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

  const onDailyNoteChange = useCallback(async (next: DailyNote) => {
    setDailyNote(next);
    dailyNoteRef.current = next;
    await persistSettings({ dailyNote: next });
  }, [persistSettings, dailyNoteRef]);

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
    const dn: DailyNote = { format: disk.dailyNote?.format || 'YYYY-MM-DD', folder: disk.dailyNote?.folder ?? '' };
    const tr: Transcription = { provider: disk.transcription?.provider || 'assemblyai', apiKey: disk.transcription?.apiKey || '' };
    const sy: SyncSettings = {
      pat: disk.sync?.pat || '',
      pullIntervalSeconds: typeof disk.sync?.pullIntervalSeconds === 'number' && disk.sync.pullIntervalSeconds > 0 ? disk.sync.pullIntervalSeconds : 10,
      disabledWorkspaceIds: Array.isArray(disk.sync?.disabledWorkspaceIds) ? disk.sync.disabledWorkspaceIds : [],
    };
    const tm: ThemeMode = disk.appearance?.themeMode || THEME_MODES.SYSTEM;
    const hln = !!disk.appearance?.hideLineNumbers;
    const tso: TreeSortOrder = typeof disk.treeSortOrder === 'string' ? disk.treeSortOrder : TREE_SORT_ORDERS.NAME_ASC;
    const ca: CodingAgentSettings = disk.codingAgent ?? settingsRef.current.codingAgent;
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];

    settingsRef.current = {
      workspaces: disk.workspaces || [],
      activeWorkspaceId: disk.activeWorkspaceId ?? null,
      appearance: { themeMode: tm, hideLineNumbers: hln },
      dailyNote: dn,
      codingAgent: ca,
      agentSecrets: secrets,
      transcription: tr,
      sync: sy,
      chatSidebarOpen: typeof disk.chatSidebarOpen === 'boolean' ? disk.chatSidebarOpen : false,
      chatSidebarWidth: typeof disk.chatSidebarWidth === 'number' ? disk.chatSidebarWidth : 360,
      sidebarWidth: typeof disk.sidebarWidth === 'number' ? disk.sidebarWidth : 260,
      viewMode: disk.viewMode === VIEW_MODES.RAW || disk.viewMode === VIEW_MODES.LIVE ? disk.viewMode : VIEW_MODES.LIVE,
      treeSortOrder: tso,
      windowBounds: disk.windowBounds ?? null,
    };
    setThemeMode(tm);
    setHideLineNumbers(hln);
    setDailyNote(dn);
    dailyNoteRef.current = dn;
    setTreeSortOrder(tso);
    if (disk.codingAgent) setCodingAgentSettings(ca);
    if (Array.isArray(disk.agentSecrets)) setAgentSecrets(secrets);
    if (disk.transcription) setTranscription(tr);
    if (disk.sync) { setSync(sy); syncRef.current = sy; }
  }, [dailyNoteRef, syncRef]);

  return {
    themeMode, hideLineNumbers, dailyNote, dailyNoteRef, treeSortOrder,
    codingAgentSettings, agentSecrets, transcription, sync, syncRef,
    settingsRef, saveStatus, persistSettings, hydrateSettings,
    onThemeModeChange, onHideLineNumbersChange, onDailyNoteChange, onTreeSortOrderChange,
    onCodingAgentChange, onAgentSecretsChange, onTranscriptionChange,
    onSyncChange, onSyncDisabledChange,
  };
}
