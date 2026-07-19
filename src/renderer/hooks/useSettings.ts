import { useState, useRef, useCallback, useEffect } from 'react';
import { useSyncRef } from './useSyncRef';
import { buildPatch } from '../settingsDiff.js';
import { THEME_MODES, VIEW_MODES, TREE_SORT_ORDERS, DEFAULT_PROVIDER_SLUG } from '../constants';
import type { Settings, WorkspaceData, ThemeMode, ViewMode, TreeSortOrder, CodingAgentSettings, AgentSecret } from '../../shared/settings';

// dailyNote + templates moved to the per-workspace WorkspaceData.
type DailyNote = WorkspaceData['dailyNote'];
type TreePanel = Settings['appearance']['treePanel'];
type Templates = WorkspaceData['templates'];
type Transcription = Settings['transcription'];
type SyncSettings = Settings['sync'];

// Default canonical object — mirrors main's DEFAULT_SETTINGS + the renderer
// fallbacks. Seeded for real from disk via hydrate() before any user action.
const DEFAULT_CANONICAL: Settings = {
  workspaces: [],
  activeWorkspaceId: null,
  appearance: { themeMode: THEME_MODES.SYSTEM, hideLineNumbers: false, treePanel: { content: 'off', count: 10 } },
  codingAgent: { provider: DEFAULT_PROVIDER_SLUG, model: 'claude-sonnet-4-5', providerKeys: {}, baseUrl: '', thinkingLevel: 'medium' },
  agentSecrets: [],
  transcription: { provider: 'assemblyai', apiKey: '' },
  sync: { pat: '', pullIntervalSeconds: 10 },
  // Cron is managed in main via window.api.cron.* (main persists the slice); the
  // renderer never writes it through persistSettings. Present here only to satisfy
  // the Settings type + hydrate a default before disk load.
  cron: { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 },
  chatSidebarOpen: false,
  chatSidebarWidth: 360,
  sidebarWidth: 260,
  viewMode: VIEW_MODES.LIVE,
  treeSortOrder: TREE_SORT_ORDERS.NAME_ASC,
  bookmarkFilterActive: false,
  windowBounds: null,
};

interface UseSettingsOpts {
  /** Called when MAIN pushes a new workspace list (create / remove / set-up-here
   *  / sync toggle). The list lives in App, so this hands it over rather than
   *  duplicating the state here. */
  onWorkspacesPushed?: (workspaces: any[], activeWorkspaceId: string | null) => void;
  // Needed for onSyncChange to restart the sync engine for the active workspace.
  activeWorkspacePath: string | null;
}

// Owns everything persisted to settings.json: the per-field UI state, the one
// canonical settingsRef (the single source of truth a save writes), the save-
// status badge, persistSettings (the shared writer — callers pass only what
// changed), the per-field change handlers, and hydrate() to seed from disk on
// boot. Non-settings persisted fields (workspaces, viewMode, sidebar widths)
// flow through persistSettings too; their UI state lives in App.

export function useSettings({ activeWorkspacePath, onWorkspacesPushed }: UseSettingsOpts) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(THEME_MODES.SYSTEM);
  const [hideLineNumbers, setHideLineNumbers] = useState(false);
  const [treePanel, setTreePanel] = useState<TreePanel>({ content: 'off', count: 10 });
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
  const [sync, setSync] = useState<SyncSettings>({ pat: '', pullIntervalSeconds: 10 });
  const syncRef = useSyncRef(sync);

  // Local cache of everything persisted, for rendering and for building whole
  // sub-objects in per-field setters. NOT the source of truth — the store is.
  const settingsRef = useRef<Settings>(DEFAULT_CANONICAL);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const inFlightSavesRef = useRef(0);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Writes ONLY the individual leaves the caller actually changed.
  //
  // This used to merge the patch into settingsRef and write the whole settings
  // object — correct when settings were one JSON file, where a partial write
  // meant a read-modify-write in main and sending everything was the safe play.
  // With one row per key that inverted: writing every subtree to change a
  // sidebar width put every unrelated setting, credentials included, in the
  // blast radius of a stale in-memory copy.
  //
  // A key absent from the patch keeps whatever the store already holds.
  const persistSettings = useCallback(async (next: Partial<Settings>) => {
    const prev = settingsRef.current;
    settingsRef.current = { ...prev, ...next };
    const patch = buildPatch(next, prev);
    if (!Object.keys(patch).length) return;
    inFlightSavesRef.current += 1;
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
    setSaveStatus('saving');
    try {
      await window.api.settings.write(patch);
      inFlightSavesRef.current -= 1;
      if (inFlightSavesRef.current === 0) {
        setSaveStatus('saved');
        savedFadeTimerRef.current = setTimeout(() => {
          savedFadeTimerRef.current = null;
          setSaveStatus('idle');
        }, 1500);
      }
    } catch {
      // Roll the cache back for the keys this save owned. Without this, the
      // optimistic update above survives a failed write, so re-applying the same
      // change diffs as "unchanged", sends nothing, and the setting can never be
      // persisted again — the cache would permanently disagree with the store.
      // Only the failed keys are reverted, so a concurrent successful save isn't
      // clobbered.
      const rolled: any = { ...settingsRef.current };
      for (const k of Object.keys(next)) rolled[k] = (prev as any)[k];
      settingsRef.current = rolled;
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

  const onTreePanelChange = useCallback(async (next: TreePanel) => {
    setTreePanel(next);
    await persistSettings({ appearance: { ...settingsRef.current.appearance, treePanel: next } });
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

  // Re-seed agentSecrets from the store WITHOUT persisting. Mostly redundant now
  // that main pushes `settings:changed` after an OAuth write (see the listener
  // below), but kept as an explicit belt for callers that want to force a pull.
  const reloadAgentSecrets = useCallback(async () => {
    const disk = await window.api.settings.read();
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];
    setAgentSecrets(secrets);
    settingsRef.current = { ...settingsRef.current, agentSecrets: secrets };
  }, []);

  // Main writes settings on its own — OAuth token refresh, window bounds, cron
  // toggles, ensureBuiltinSecretSlots — and without this the local copy would
  // silently drift from the store. The event fires ONLY for main-initiated
  // writes, so this can never echo the renderer's own save back at it.
  //
  // Applies only the keys main reports as changed, so an unrelated write can't
  // stomp a field the user is editing right now. Updates state + settingsRef but
  // never calls persistSettings — the store is already correct; this is the
  // renderer catching up, not a change to write back.
  useEffect(() => {
    const off = window.api.settings.onChanged(({ keys, settings }: { keys: string[]; settings: any }) => {
      const changed = new Set(keys);
      // Workspaces are MAIN-owned now — only main creates, removes, or flips
      // sync on one — so main pushing them is the renderer's only correct
      // source. It used to be sent and silently dropped here, which is why the
      // list had to be hand-patched at four call sites and could go stale.
      if (changed.has('workspaces') && Array.isArray(settings.workspaces)) {
        onWorkspacesPushed?.(settings.workspaces, settings.activeWorkspaceId ?? null);
        settingsRef.current = { ...settingsRef.current, workspaces: settings.workspaces };
      }
      if (changed.has('agentSecrets')) {
        const secrets: AgentSecret[] = Array.isArray(settings.agentSecrets) ? settings.agentSecrets : [];
        setAgentSecrets(secrets);
        settingsRef.current = { ...settingsRef.current, agentSecrets: secrets };
      }
      if (changed.has('sync') && settings.sync) {
        setSync(settings.sync);
        syncRef.current = settings.sync;
        settingsRef.current = { ...settingsRef.current, sync: settings.sync };
      }
      if (changed.has('transcription') && settings.transcription) {
        setTranscription(settings.transcription);
        settingsRef.current = { ...settingsRef.current, transcription: settings.transcription };
      }
      if (changed.has('codingAgent') && settings.codingAgent) {
        setCodingAgentSettings(settings.codingAgent);
        settingsRef.current = { ...settingsRef.current, codingAgent: settings.codingAgent };
      }
      if (changed.has('appearance') && settings.appearance) {
        setThemeMode(settings.appearance.themeMode);
        setHideLineNumbers(!!settings.appearance.hideLineNumbers);
        if (settings.appearance.treePanel) setTreePanel(settings.appearance.treePanel);
        settingsRef.current = { ...settingsRef.current, appearance: settings.appearance };
      }
      // `cron` and `windowBounds` are main-owned and have no renderer state to
      // update; they're in MAIN_OWNED_KEYS so they're never written back either.
    });
    return off;
  }, [syncRef, onWorkspacesPushed]);

  const onTranscriptionChange = useCallback(async (next: Transcription) => {
    setTranscription(next);
    await persistSettings({ transcription: next });
  }, [persistSettings]);

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
    };
    const tm: ThemeMode = disk.appearance?.themeMode || THEME_MODES.SYSTEM;
    const hln = !!disk.appearance?.hideLineNumbers;
    // Migrate the retired `dailyNotesInBookmarks` checkbox: on ⇒ daily notes panel.
    const rawTp = disk.appearance?.treePanel;
    const tp: TreePanel = {
      content: ['off', 'recent', 'daily', 'both'].includes(rawTp?.content)
        ? rawTp.content
        : (disk.appearance?.dailyNotesInBookmarks ? 'daily' : 'off'),
      count: typeof rawTp?.count === 'number' && rawTp.count >= 1 ? Math.min(50, Math.round(rawTp.count)) : 10,
    };
    const bfa = !!disk.bookmarkFilterActive;
    const tso: TreeSortOrder = typeof disk.treeSortOrder === 'string' ? disk.treeSortOrder : TREE_SORT_ORDERS.NAME_ASC;
    const ca: CodingAgentSettings = disk.codingAgent ?? settingsRef.current.codingAgent;
    const secrets: AgentSecret[] = Array.isArray(disk.agentSecrets) ? disk.agentSecrets : [];

    settingsRef.current = {
      workspaces: disk.workspaces || [],
      activeWorkspaceId: disk.activeWorkspaceId ?? null,
      appearance: { themeMode: tm, hideLineNumbers: hln, treePanel: tp },
      codingAgent: ca,
      agentSecrets: secrets,
      transcription: tr,
      sync: sy,
      // Main-owned (MAIN_OWNED_KEYS) — mirrored here only so settingsRef matches
      // the Settings type; the renderer never writes it back.
      cron: disk.cron ?? { enabled: false, maxCatchupHours: 36, maxRunMinutes: 30 },
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
    setTreePanel(tp);
    setBookmarkFilterActiveState(bfa);
    setTreeSortOrder(tso);
    if (disk.codingAgent) setCodingAgentSettings(ca);
    if (Array.isArray(disk.agentSecrets)) setAgentSecrets(secrets);
    if (disk.transcription) setTranscription(tr);
    if (disk.sync) { setSync(sy); syncRef.current = sy; }
  }, [dailyNoteRef, syncRef]);

  return {
    themeMode, hideLineNumbers, treePanel, bookmarkFilterActive,
    dailyNote, dailyNoteRef, templates, builtinSkills, treeSortOrder,
    codingAgentSettings, agentSecrets, transcription, sync, syncRef,
    settingsRef, saveStatus, persistSettings, hydrateSettings, loadWorkspaceData,
    onThemeModeChange, onHideLineNumbersChange, onTreePanelChange,
    onBookmarkFilterActiveChange, onDailyNoteChange, onTemplatesChange, onBuiltinSkillToggle, onTreeSortOrderChange,
    onCodingAgentChange, onAgentSecretsChange, reloadAgentSecrets, onTranscriptionChange,
    onSyncChange,
  };
}
