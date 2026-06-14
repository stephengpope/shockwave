import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import FileTree from './FileTree.jsx';
import Editor from './Editor.jsx';
import BacklinksPanel from './BacklinksPanel.jsx';
import GraphView from './GraphView.jsx';
import MediaView, { mediaKind, isOpenable, isDrawing } from './MediaView';
import DrawingView from './DrawingView';
import type { DrawingViewHandle } from './DrawingView';
import { rewriteReferences } from './renameOps.js';
import TabStrip from './TabStrip.jsx';
import EditorTitle from './EditorTitle.jsx';
import EditorNav from './EditorNav.jsx';
import ThinSidebar from './ThinSidebar.jsx';
import WorkspaceSelector from './WorkspaceSelector.jsx';
import SettingsModal from './SettingsModal.jsx';
import UrlPromptModal from './UrlPromptModal.jsx';
import ErrorMessage from './ErrorMessage.jsx';
import EditorStatusBar from './EditorStatusBar.jsx';
import ChatSidebar from './ChatSidebar.jsx';
import Dialog from './Dialog.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import JournalDatePicker from './JournalDatePicker.jsx';
import QuickSearch from './QuickSearch.jsx';
import { basenameOf, dirOf, toRelPath } from './pathUtils';
import { prettyName } from './linkIndex.js';
import { SETTINGS_SECTIONS, THEME_MODES, APP_NAME, FOLDER_ACTIONS, VIEW_MODES, SAVE_STATES, TREE_SORT_ORDERS, FILE_ACTIONS } from './constants.js';
import SortBar from './SortBar.jsx';
import DailyNotesPanel from './DailyNotesPanel.jsx';
import { parseDailyNoteDate } from './dailyNote.js';
import { collectTemplateFiles } from './templates.js';
import { useLinkIndex } from './hooks/useLinkIndex.js';
import { useTabs } from './hooks/useTabs.js';
import { useFileOps } from './hooks/useFileOps.js';
import { useSyncRef } from './hooks/useSyncRef';
import { useBookmarks, flattenBookmarkedFiles, bookmarkKey } from './hooks/useBookmarks';
import { useDailyNote } from './hooks/useDailyNote';
import { useSendToAgent } from './hooks/useSendToAgent';
import { useFsWatcher } from './hooks/useFsWatcher';
import { useSettings } from './hooks/useSettings';
import { useAppUpdate } from './hooks/useAppUpdate';

const SAVE_DEBOUNCE_MS = 500;

function genWorkspaceId() {
  return 'ws_' + Math.random().toString(36).slice(2, 10);
}



// Sort the tree recursively. Folders are always pinned to the top in A→Z order;
// only files within each folder are re-ordered per `order`. Missing timestamps
// (older builds, race with delete) fall back to 0 so the node still appears.
function sortTreeNodes(nodes, order) {
  const cmpName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const out = nodes.slice().sort((a, b) => {
    const aDir = !!a.children;
    const bDir = !!b.children;
    if (aDir !== bDir) return aDir ? -1 : 1;
    if (aDir) return cmpName(a, b);
    switch (order) {
      case TREE_SORT_ORDERS.NAME_DESC: return cmpName(b, a);
      case TREE_SORT_ORDERS.MODIFIED_DESC: return (b.mtime ?? 0) - (a.mtime ?? 0);
      case TREE_SORT_ORDERS.MODIFIED_ASC: return (a.mtime ?? 0) - (b.mtime ?? 0);
      case TREE_SORT_ORDERS.CREATED_DESC: return (b.ctime ?? 0) - (a.ctime ?? 0);
      case TREE_SORT_ORDERS.CREATED_ASC: return (a.ctime ?? 0) - (b.ctime ?? 0);
      case TREE_SORT_ORDERS.NAME_ASC:
      default: return cmpName(a, b);
    }
  });
  return out.map((n) => (n.children ? { ...n, children: sortTreeNodes(n.children, order) } : n));
}

function flattenAll(nodes, out: any[] = []) {
  for (const n of nodes) {
    if (n.children) flattenAll(n.children, out);
    out.push(n);
  }
  return out;
}

// Build a nested folder/file tree for the conflict view straight from the git
// conflict list (workspace-absolute paths) — NOT from the file tree, which
// excludes hidden files. So conflicts in `.obsidian/…` etc. still show up.
// Node shape matches buildTree: { id (abs path), name, children? }.
function buildConflictTree(absPaths: string[], workspacePath: string | null) {
  if (!workspacePath) return [];
  const root: any[] = [];
  const folders = new Map<string, any>(); // abs folder path → node
  for (const abs of absPaths) {
    const prefix = workspacePath + '/';
    if (!abs.startsWith(prefix)) continue;
    const parts = abs.slice(prefix.length).split('/');
    let children = root;
    let curAbs = workspacePath;
    for (let i = 0; i < parts.length - 1; i++) {
      curAbs = `${curAbs}/${parts[i]}`;
      let node = folders.get(curAbs);
      if (!node) {
        node = { id: curAbs, name: parts[i], children: [] };
        folders.set(curAbs, node);
        children.push(node);
      }
      children = node.children;
    }
    children.push({ id: abs, name: parts[parts.length - 1] });
  }
  // Folders first, then A→Z, at every level.
  const sortLevel = (ns: any[]) => {
    ns.sort((a, b) => {
      const ad = !!a.children, bd = !!b.children;
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of ns) if (n.children) sortLevel(n.children);
  };
  sortLevel(root);
  return root;
}

// Workspace-wide, case-insensitive .md basename collision check. The link
// index is keyed by basename, so two files sharing a name (in any folder)
// collapse into one and break references. This drives the live title-input
// warning. The IPC handlers auto-disambiguate if the user submits anyway.
function findNameConflict({ tree, currentPath, newName }) {
  const clean = newName.replace(/\.md$/i, '').toLowerCase().trim();
  if (!clean) return null;
  for (const node of flattenAll(tree)) {
    if (node.children) continue;
    if (node.id === currentPath) continue;
    if (!node.name.toLowerCase().endsWith('.md')) continue;
    if (node.name.slice(0, -3).toLowerCase() === clean) return node.id;
  }
  return null;
}

const isMdName = (n: string) => /\.md$/i.test(n);

// Live collision check for the file-browser rename (literal names). Returns
// true if `newName` would collide and the rename must be blocked:
//   - `.md` target → workspace-wide basename collision (link index is keyed by
//     basename, so two `.md` sharing one break it).
//   - other files → same-folder exact-name collision.
// Empty names also count as "can't save". Folders aren't checked here (the
// folder rename path keeps its own behavior).
function findTreeRenameConflict({ tree, currentPath, newName }: { tree: any[]; currentPath: string; newName: string }) {
  const name = (newName ?? '').trim();
  const oldName = currentPath.slice(currentPath.lastIndexOf('/') + 1);
  if (!name) return true;
  if (name === oldName) return false;
  const files = flattenAll(tree).filter((n) => !n.children && n.id !== currentPath);
  if (isMdName(name)) {
    const base = name.slice(0, -3).toLowerCase();
    return files.some((n) => isMdName(n.name) && n.name.slice(0, -3).toLowerCase() === base);
  }
  const dir = currentPath.slice(0, currentPath.lastIndexOf('/'));
  return files.some((n) => {
    const nd = n.id.slice(0, n.id.lastIndexOf('/'));
    return nd === dir && n.name.toLowerCase() === name.toLowerCase();
  });
}

export default function App() {
  // ---- top-level state ----
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<any>(null);
  const [tree, setTree] = useState<any[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState<any>(null);
  const [graphMode, setGraphMode] = useState(false);
  const [errorMessage, setErrorMessage] = useState<any>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState(SETTINGS_SECTIONS.WORKSPACES);
  // When set, renders <UrlPromptModal>. `resolve` is the awaiting promise's
  // resolver. `initialUrl` / `initialText` (Edit mode) optionally pre-fill the
  // form. Resolver receives { url, text } | null.
  const [urlPromptOpts, setUrlPromptOpts] = useState<any>(null);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  // Bookmarks live in useBookmarks (called below, after workspacePath + showError
  // exist). sortedTree is defined there too, since it consumes the bookmark set.
  // Persisted settings (themeMode, dailyNote, codingAgent, sync, etc.) + the
  // canonical settingsRef + persistSettings live in useSettings (called below,
  // once workspacePath exists).
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [bootDone, setBootDone] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const sidebarWidthRef = useRef(260);
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const chatSidebarOpenRef = useRef(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState(360);
  const chatSidebarWidthRef = useRef(360);
  const [viewMode, setViewMode] = useState<any>(VIEW_MODES.LIVE);
  const [editorStats, setEditorStats] = useState({ words: 0, chars: 0 });
  const [editorHistory, setEditorHistory] = useState({ canUndo: false, canRedo: false });
  const [saveState, setSaveState] = useState<any>(SAVE_STATES.SAVED);
  // Send-to-Agent state (sendToAgentPending, chatSidebarRef, injection) lives in
  // useSendToAgent, called below once its chat-sidebar deps exist.
  // Sync engine status pushed from main via `sync:status` events.
  // status: 'disabled' | 'idle' | 'syncing' | 'paused' | 'error'.
  const [syncStatus, setSyncStatus] = useState<any>({ status: 'disabled', detail: '', lastSyncAt: null });

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const workspacePath = activeWorkspace?.path ?? null;
  const workspacePathRef = useSyncRef(workspacePath);
  const treeRef = useSyncRef(tree);

  // Conflict files surfaced by the sync engine on its paused status (relative
  // POSIX paths → workspace-absolute). Drives the conflict-resolution view.
  const conflictPaths = useMemo(
    () => (workspacePath ? (syncStatus?.conflicts ?? []).map((r: string) => `${workspacePath}/${r}`) : []),
    [workspacePath, syncStatus],
  );
  const hasConflicts = conflictPaths.length > 0;
  // Conflict-only tree view. Manual entry (click the red sync icon / sort-bar
  // toggle); auto-exit once everything's resolved.
  const [conflictFilterActive, setConflictFilterActive] = useState(false);
  useEffect(() => { if (!hasConflicts) setConflictFilterActive(false); }, [hasConflicts]);

  const {
    themeMode, hideLineNumbers, dailyNotesInBookmarks, bookmarkFilterActive,
    dailyNote, dailyNoteRef, templates, treeSortOrder,
    codingAgentSettings, agentSecrets, transcription, sync, syncRef,
    saveStatus, persistSettings, hydrateSettings,
    onThemeModeChange, onHideLineNumbersChange, onDailyNotesInBookmarksChange,
    onBookmarkFilterActiveChange, onDailyNoteChange, onTemplatesChange, onTreeSortOrderChange,
    onCodingAgentChange, onAgentSecretsChange, onTranscriptionChange,
    onSyncChange, onSyncDisabledChange,
  } = useSettings({ activeWorkspacePath: workspacePath });

  // App-update status: feeds the editor-pane "Update available" pill + Settings → Updates.
  const appUpdate = useAppUpdate();

  // Live ref to the active file's absolute path. Used by the editor's image
  // paste/drop handler (target dir for the saved image) and the inline image
  // renderer (base for resolving relative URLs). Null for drafts.
  const activeFilePathRef = useRef<any>(null);

  // ---- app title ----
  useEffect(() => {
    document.title = APP_NAME;
  }, []);

  // Sync engine bridge — once on mount, no workspace dep. The engine asks us
  // to flush dirty editor tabs before each tick; we writeNow then ack with
  // the same token. Status events update the status-bar icon.
  //
  // Minimum SYNCING visibility: a fast push/pull can flip `syncing` → `idle`
  // in well under one render frame, so the spinning icon never reaches the
  // screen. Hold any SYNCING state for at least SYNC_MIN_DISPLAY_MS before
  // letting a subsequent IDLE/ERROR through. PAUSED is never delayed (user
  // action required). The hold is per-status-event, not cumulative — back-
  // to-back ticks just keep extending the SYNCING window.
  useEffect(() => {
    const SYNC_MIN_DISPLAY_MS = 400;
    let syncingShownAt = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingStatus: any = null;
    const apply = (s: any) => {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      if (s.status === 'syncing') {
        syncingShownAt = Date.now();
        setSyncStatus(s);
        return;
      }
      if (s.status === 'paused') {
        setSyncStatus(s);
        return;
      }
      // idle | error | disabled — defer if SYNCING hasn't been on-screen long enough
      const elapsed = Date.now() - syncingShownAt;
      if (syncingShownAt && elapsed < SYNC_MIN_DISPLAY_MS) {
        pendingStatus = s;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          setSyncStatus(pendingStatus);
          pendingStatus = null;
        }, SYNC_MIN_DISPLAY_MS - elapsed);
        return;
      }
      setSyncStatus(s);
    };

    const unsubFlush = window.api.sync.onFlushRequest(async (token) => {
      // Best-effort flush before sync acks; log so a failed save isn't silent.
      try { await writeNowRef.current(); } catch (e: any) { console.warn('sync flush save failed:', e); }
      window.api.sync.flushDone(token).catch(() => {});
    });
    const unsubStatus = window.api.sync.onStatus(apply);
    // Seed the current status so the icon doesn't flash 'disabled' on reload
    // when the engine is already running.
    window.api.sync.engineStatus().then((s) => { if (s) setSyncStatus(s); }).catch(() => {});
    return () => {
      unsubFlush();
      unsubStatus();
      if (pendingTimer) clearTimeout(pendingTimer);
      // Stop the engine when the renderer goes away (full reload, window close).
      window.api.sync.engineStop().catch(() => {});
    };
  }, []);

  // ---- effective theme ----
  const effectiveTheme = useMemo(() => {
    if (themeMode === THEME_MODES.SYSTEM) return systemPrefersDark ? 'dark' : 'light';
    return themeMode;
  }, [themeMode, systemPrefersDark]);
  const isDark = effectiveTheme === 'dark';
  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
  }, [effectiveTheme]);

  // ---- error helper ----
  const errorTimerRef = useRef<any>(null);
  const showError = useCallback((msg) => {
    setErrorMessage(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null;
      setErrorMessage(null);
    }, 4000);
  }, []);

  const {
    bookmarks,
    resetBookmarks,
    seedBookmarks,
    toggleBookmark,
    setBookmarksForPaths,
    isBookmarked,
    renameBookmarkName,
    removeBookmarkName,
    persistBookmarks,
  } = useBookmarks({ workspacePath, showError });

  // Resolvable bookmark keys = basenames of every .md file currently in the
  // workspace. Used to prune dead bookmarks on seed and to resolve a name → path
  // on click (via the link index's pageIndex).
  const bookmarkResolvableKeys = useCallback(
    () => new Set(flattenAll(treeRef.current).filter((n) => !n.children && /\.md$/i.test(n.id)).map((n) => bookmarkKey(n.id))),
    [treeRef],
  );

  const sortedTree = useMemo(() => {
    // Conflict view is its own pre-sorted tree from the git conflict list.
    if (conflictFilterActive) return buildConflictTree(conflictPaths, workspacePath);
    const base = bookmarkFilterActive ? flattenBookmarkedFiles(tree, bookmarks) : tree;
    return sortTreeNodes(base, treeSortOrder);
  }, [tree, treeSortOrder, bookmarkFilterActive, bookmarks, conflictFilterActive, conflictPaths, workspacePath]);

  // Daily-note files for the panel below the bookmarks list. Only computed when
  // the panel is actually shown (bookmark mode + Appearance toggle on). Matches
  // every `.md` under the configured daily-note folder whose path (relative to
  // that folder, minus `.md`) strict-parses against the daily-note format.
  // Sorted by the active tree sort order, same as the bookmarks list above it.
  const dailyNoteFiles = useMemo(() => {
    if (!bookmarkFilterActive || !dailyNotesInBookmarks || !workspacePath) return [];
    const cleanFolder = (dailyNote.folder ?? '').replace(/^\/+|\/+$/g, '');
    const prefix = cleanFolder ? `${workspacePath}/${cleanFolder}/` : `${workspacePath}/`;
    const out: any[] = [];
    for (const n of flattenAll(tree)) {
      if (n.children || !/\.md$/i.test(n.id) || !n.id.startsWith(prefix)) continue;
      const relNoExt = n.id.slice(prefix.length).replace(/\.md$/i, '');
      if (parseDailyNoteDate(relNoExt, dailyNote.format)) out.push(n);
    }
    return sortTreeNodes(out, treeSortOrder);
  }, [bookmarkFilterActive, dailyNotesInBookmarks, workspacePath, tree, dailyNote.format, dailyNote.folder, treeSortOrder]);

  // Template files (direct `.md` children of the configured templates folder),
  // alphabetical. Drives both the left-rail picker and the Daily Note default-
  // template dropdown.
  const templateFiles = useMemo(
    () => collectTemplateFiles(tree, templates.folder, workspacePath),
    [tree, templates.folder, workspacePath],
  );
  const templateOptions = useMemo(
    () => templateFiles.map((t) => ({ name: t.name, value: t.relPath })),
    [templateFiles],
  );

  // ---- editor ref ----
  const editorRef = useRef<any>(null);
  // ---- file tree ref (imperative API: editNode(id)) ----
  const fileTreeRef = useRef<any>(null);
  // ---- chat sidebar ref (imperative API: setComposerText, getComposerText, focusComposer) ----

  // ---- save lifecycle (stays in App, crosses concerns) ----
  // dirtyTabIdRef holds the tab id that needs flushing. For drafts (no path
  // yet) writeNow creates the file using titleDraft (or "Untitled") at the
  // moment of save; for real files it writes through. Per-tab in-flight guard
  // coalesces concurrent calls so two near-simultaneous saves can't both fire
  // createFile and leave an orphan disambiguated file behind.
  const dirtyTabIdRef = useRef<any>(null);
  const saveTimerRef = useRef<any>(null);
  const writeInFlightRef = useRef(new Map());
  // Forward refs filled below by useSyncRef once useTabs/newFileDir exist.
  const tabsRef = useRef<any[]>([]);
  const activeTabIdRef = useRef<any>(null);
  const titleDraftRef = useSyncRef(titleDraft);
  const newFileDirRef = useRef(() => null);
  const promoteTabPathRef = useRef(() => {});

  const linkIndex = useLinkIndex(tree);

  // Bookmarks resolved to current locations for the picker: name → path via the
  // link index. Unresolved names (file gone) are hidden. Sorted by display name.
  const bookmarkItems = useMemo(() => {
    const items: Array<{ name: string; dir: string; path: string }> = [];
    for (const key of bookmarks) {
      const path = linkIndex.pageIndex.get(key);
      if (!path) continue;
      const rel = (workspacePath && path.startsWith(workspacePath + '/')) ? path.slice(workspacePath.length + 1) : path;
      const slash = rel.lastIndexOf('/');
      items.push({ name: slash >= 0 ? rel.slice(slash + 1) : rel, dir: slash >= 0 ? rel.slice(0, slash) : '', path });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [bookmarks, linkIndex.pageIndex, workspacePath]);

  // Returns the absolute path that was saved (the new path for a draft, or the
  // existing path for a real file), or null if nothing was dirty / save failed.
  // (writeNowRef declared after the useCallback below.)
  const writeNow = useCallback(async () => {
    const tabId = dirtyTabIdRef.current;
    if (!tabId) return null;
    const existing = writeInFlightRef.current.get(tabId);
    if (existing) return existing;
    const work = (async () => {
      dirtyTabIdRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const editor = editorRef.current;
      if (!editor) return null;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return null;
      const text = editor.getText();
      try {
        let path;
        let mtime;
        if (tab.isDraft) {
          // Only trust titleDraft when the dirty tab is also the active tab;
          // for any other tab (background flush during switch) fall back.
          const candidate = tabId === activeTabIdRef.current ? (titleDraftRef.current || '') : '';
          const name = (candidate || 'Untitled').replace(/\.md$/i, '').trim() || 'Untitled';
          const targetDir = newFileDirRef.current();
          if (!targetDir) throw new Error('No active workspace');
          const res = await window.api.createFile(targetDir, `${name}.md`, text);
          path = res.path;
          mtime = res.mtime;
          (promoteTabPathRef.current as any)(tabId, path);
        } else {
          path = tab.path;
          mtime = await window.api.writeFile(path, text);
        }
        // Pass the file's real mtime (returned by main) so the self-echo guard
        // can compare against the watcher's stat.mtimeMs without losing the
        // fractional ms that Date.now() would drop.
        linkIndex.updateFile(path, text, mtime);
        if (dirtyTabIdRef.current === null) setSaveState(SAVE_STATES.SAVED);
        return path;
      } catch (err: any) {
        // Re-arm dirty so the next edit/save attempt retries this tab.
        dirtyTabIdRef.current = tabId;
        showError(err.message ?? String(err));
        return null;
      }
    })();
    writeInFlightRef.current.set(tabId, work);
    try {
      return await work;
    } finally {
      writeInFlightRef.current.delete(tabId);
    }
  }, [linkIndex, showError]);

  // Ref to writeNow so the sync engine's flush-request handler can call it
  // without depending on writeNow's identity (which changes when its deps
  // change).
  const writeNowRef = useSyncRef(writeNow);

  // ---- tabs (drafts live here) ----
  const onAfterSwitch = useCallback(() => {
    if (graphMode) setGraphMode(false);
  }, [graphMode]);

  const tabsApi = useTabs({ editorRef, writeNow, onAfterSwitch });
  const { activeFile, activeIsDraft, activeTab, openInActiveTab, openInNewTab, addDraftTab,
          switchTab, closeTab, closeTabsForPath, closeTabsUnderPath, renameTabsPath, resetTabs,
          promoteTabPath, tabs, activeTabId, goBack, goForward, canGoBack, canGoForward } = tabsApi;

  // Keep writeNow's refs current. writeNow itself is a stable closure declared
  // above; these effects feed it the freshest tab state and helpers.
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  useEffect(() => { promoteTabPathRef.current = promoteTabPath; }, [promoteTabPath]);

  useEffect(() => {
    activeFilePathRef.current = activeIsDraft ? null : activeFile;
  }, [activeFile, activeIsDraft]);

  // Image/video active file → render a MediaView preview instead of the text
  // editor. null for .md and any other text (those open in the editor).
  const activeMediaKind = activeIsDraft ? null : mediaKind(activeFile);
  // `.excalidraw` active file → render the editable DrawingView instead.
  const activeDrawing = !activeIsDraft && isDrawing(activeFile);
  // Live drawing canvas (for watcher reload) + per-path mtime store guarding
  // the drawing self-echo (drawings aren't in the link index — see useFsWatcher).
  const drawingViewRef = useRef<DrawingViewHandle | null>(null);
  const drawingMtimesRef = useRef<Map<string, number>>(new Map());
  const onDrawingSaved = useCallback((p: string, mtime: number) => {
    drawingMtimesRef.current.set(p, mtime);
  }, []);

  const onBack = useCallback(() => { if (activeTabId) goBack(activeTabId); }, [activeTabId, goBack]);
  const onForward = useCallback(() => { if (activeTabId) goForward(activeTabId); }, [activeTabId, goForward]);

  // Where a new file should be created when saving a draft for the first time.
  // Priority: explicitly selected folder → dir of the active file → workspace root.
  const newFileDir = useCallback(() => {
    if (selectedFolderPath) return selectedFolderPath;
    if (activeFile) return dirOf(activeFile);
    return workspacePath;
  }, [selectedFolderPath, activeFile, workspacePath]);
  useEffect(() => { newFileDirRef.current = newFileDir; }, [newFileDir]);

  // For image paste/drop: ensure the active tab has a real file path. If it's
  // a draft, force a save now (which creates the file via writeNow's draft
  // branch). Returns the resolved absolute path, or null if there's no active
  // tab. Used by the editor's image plugin to know where to write the image.
  const flushDraftToDisk = useCallback(async () => {
    if (!activeTab) return null;
    if (!activeTab.isDraft) return activeFile;
    dirtyTabIdRef.current = activeTab.id;
    const newPath = await writeNow();
    // Push the new path into activeFilePathRef synchronously so the image
    // widget's decoration pass (which runs on the upcoming view.dispatch's
    // docChanged) can resolve the image's relative URL. Without this, the ref
    // is still null when the decoration computes (the effect that mirrors
    // activeFile into the ref hasn't fired yet — React hasn't committed the
    // setTabs from promoteTabPath), so the image stays as raw text until the
    // next docChange triggers another decoration pass.
    if (newPath) activeFilePathRef.current = newPath;
    return newPath;
  }, [activeTab, activeFile, writeNow]);
  const flushDraftToDiskRef = useSyncRef(flushDraftToDisk);

  // ---- on editor change: schedule debounced save ----
  const onEditorChange = useCallback(() => {
    if (!activeTab) return;
    setSaveState(SAVE_STATES.UNSAVED);
    dirtyTabIdRef.current = activeTab.id;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => writeNow(), SAVE_DEBOUNCE_MS);
  }, [activeTab, writeNow]);

  // ---- refresh tree ----
  const refreshTree = useCallback(async () => {
    if (!workspacePath) return [];
    const data = await window.api.readTree(workspacePath);
    setTree(data);
    return data;
  }, [workspacePath]);

  // ---- file operations ----
  const fileOps = useFileOps({
    workspacePath,
    pageIndex: linkIndex.pageIndex,
    linkIndex,
    tabs,
    writeNow,
    openInActiveTab,
    openInNewTab,
    renameTabsPath,
    showError,
    refreshTree,
  });

  // ---- tree selection ----
  // Folders set selectedFolderPath (used as target dir for new files).
  // Files clear it and open in the active tab — BUT only on a true single-row
  // click. A multi-row selection (Cmd/Shift+click building up a set of files
  // for a bulk action) must NOT auto-open anything, or every Cmd+click would
  // swap the editor's content.
  const onSelect = useCallback(async (nodes) => {
    if (nodes.length === 0) {
      // Tree-selection cleared (clicked empty space, etc). Match the visual
      // state — without this, selectedFolderPath would stay set and the next
      // new file would land in a folder the user no longer thinks is "selected".
      setSelectedFolderPath(null);
      return;
    }
    if (nodes.length > 1) {
      // Multi-select: don't auto-open and don't reinterpret selectedFolderPath.
      setSelectedFolderPath(null);
      return;
    }
    const node = nodes[0];
    if (node.children) {
      setSelectedFolderPath(node.id);
      return;
    }
    setSelectedFolderPath(null);
    // Only .md (editor) + image/video (MediaView) open. Other types are inert.
    // Conflict view is exempt so any conflicted file can be opened to resolve it.
    if (!conflictFilterActive && !isOpenable(node.id)) return;
    if (graphMode) setGraphMode(false);
    await openInActiveTab(node.id);
  }, [openInActiveTab, graphMode, conflictFilterActive]);

  // ---- workspace operations ----

  const persistSidebarWidth = useCallback(async (width) => {
    sidebarWidthRef.current = width;
    await persistSettings({ sidebarWidth: width });
  }, [persistSettings]);

  const loadWorkspace = useCallback(async (workspace) => {
    await writeNow();
    await window.api.watchStop();
    resetTabs();
    setTree([]);
    setSelectedFolderPath(null);
    setGraphMode(false);
    setSaveState(SAVE_STATES.SAVED);
    resetBookmarks();
    const [treeData, files, bookmarkNames] = await Promise.all([
      window.api.readTree(workspace.path),
      window.api.readAllMarkdown(workspace.path),
      window.api.bookmarks.read(workspace.path),
    ]);
    setTree(treeData);
    linkIndex.rebuild(files);
    // Seed the bookmark set from disk, pruning names whose .md file is gone.
    seedBookmarks(bookmarkNames, new Set(files.map((f) => bookmarkKey(f.path))));
    await window.api.watchStart(workspace.path);
    // Kick the sync engine. It self-checks whether the workspace has an
    // origin and what the PAT is, so we don't gate on those here. Status
    // events flow back via `onStatus` (subscribed once on mount).
    window.api.sync.engineStart({
      workspacePath: workspace.path,
      intervalSeconds: syncRef.current?.pullIntervalSeconds,
    }).catch(() => {});
  }, [writeNow, resetTabs, linkIndex]);

  const switchWorkspace = useCallback(async (id) => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    const exists = await window.api.pathExists(ws.path);
    if (!exists) {
      const removed = workspaces.filter((w) => w.id !== id);
      setWorkspaces(removed);
      setActiveWorkspaceId(null);
      await persistSettings({ workspaces: removed, activeWorkspaceId: null });
      showError(`Workspace "${ws.name}" no longer exists.`);
      return;
    }
    setActiveWorkspaceId(id);
    await persistSettings({ workspaces, activeWorkspaceId: id });
    await loadWorkspace(ws);
  }, [workspaces, persistSettings, themeMode, loadWorkspace, showError]);

  const addWorkspace = useCallback(async () => {
    const folder = await window.api.openFolder();
    if (!folder) return;
    const existing = workspaces.find((w) => w.path === folder);
    if (existing) {
      await switchWorkspace(existing.id);
      return;
    }
    const ws = { id: genWorkspaceId(), name: basenameOf(folder), path: folder };
    const next = [...workspaces, ws];
    setWorkspaces(next);
    setActiveWorkspaceId(ws.id);
    await persistSettings({ workspaces: next, activeWorkspaceId: ws.id });
    await loadWorkspace(ws);
  }, [workspaces, persistSettings, themeMode, loadWorkspace, switchWorkspace]);

  const removeWorkspace = useCallback(async (id) => {
    const next = workspaces.filter((w) => w.id !== id);
    setWorkspaces(next);
    let newActive = activeWorkspaceId;
    if (id === activeWorkspaceId) {
      newActive = null;
      setActiveWorkspaceId(null);
      resetTabs();
      setTree([]);
      setSelectedFolderPath(null);
      await window.api.watchStop();
    }
    await persistSettings({ workspaces: next, activeWorkspaceId: newActive });
  }, [workspaces, activeWorkspaceId, persistSettings, themeMode, resetTabs]);


  // File-delete confirmation state — holds the path(s) the user asked to delete
  // (one or many). The ConfirmDialog renders below. Folder delete has its own.
  const [deleteCandidates, setDeleteCandidates] = useState<any>(null);
  const [folderDeleteCandidate, setFolderDeleteCandidate] = useState<string | null>(null);
  // Whole-tree conflict actions awaiting the user's confirm.
  const [resetToRemotePending, setResetToRemotePending] = useState(false);
  const [keepAllPending, setKeepAllPending] = useState(false);

  // Action wrapper around fileOps.onFileAction. Two responsibilities:
  // 1) Handle TOGGLE_BOOKMARK (kept here so useFileOps stays bookmark-free).
  // 2) Handle multi-path actions — FileTree passes an array of paths from a
  //    right-click on a multi-selection. Single-target actions (DUPLICATE,
  //    REVEAL, RENAME) collapse to the first path; bulk-safe actions
  //    (TOGGLE_BOOKMARK, DELETE, NEW_TAB) fan out.
  // Per-file conflict action: 'resolve' (accept as-edited / git add), 'keep'
  // (our version), 'reset' (remote version). Flush the file first if it's open
  // so git stages the user's edits, not stale on-disk content. The engine
  // pushes a new status (fewer conflicts / idle) → the view refreshes/exits.
  const conflictFileAction = useCallback(async (absPath, kind) => {
    if (!workspacePath) return;
    if (absPath === activeFile) { try { await writeNow(); } catch { /* surfaced below */ } }
    const rel = toRelPath(absPath, workspacePath);
    if (!rel) return;
    try {
      if (kind === 'keep') await window.api.sync.keepConflict(workspacePath, rel);
      else if (kind === 'reset') await window.api.sync.resetConflict(workspacePath, rel);
      else await window.api.sync.resolveConflict(workspacePath, rel);
    } catch (err: any) {
      showError(`Conflict action failed: ${err.message ?? err}`);
    }
  }, [workspacePath, activeFile, writeNow, showError]);

  const onFileActionWithBookmarks = useCallback((action, filePathOrPaths) => {
    const paths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
    if (paths.length === 0) return;

    if (action === FILE_ACTIONS.RESOLVE) { void conflictFileAction(paths[0], 'resolve'); return; }
    if (action === FILE_ACTIONS.KEEP) { void conflictFileAction(paths[0], 'keep'); return; }
    if (action === FILE_ACTIONS.RESET) { void conflictFileAction(paths[0], 'reset'); return; }

    if (action === FILE_ACTIONS.TOGGLE_BOOKMARK) {
      // Only .md files can be bookmarked (keyed by basename via the link index).
      // The menu only offers it for .md, but guard here too.
      const mdPaths = paths.filter((p) => /\.md$/i.test(p));
      if (mdPaths.length === 0) return;
      if (mdPaths.length === 1) {
        toggleBookmark(mdPaths[0]);
      } else {
        // Mirror the menu label: if all selected files are bookmarked, the user
        // saw "Remove N bookmarks" — clear them. Otherwise they saw
        // "Bookmark N files" — set them all bookmarked.
        const allBookmarked = mdPaths.every((p) => isBookmarked(p));
        setBookmarksForPaths(mdPaths, !allBookmarked);
      }
      return;
    }

    if (action === FILE_ACTIONS.DELETE) {
      // All file deletes (one or many) confirm via the renderer ConfirmDialog.
      setDeleteCandidates(paths);
      return;
    }

    if (action === FILE_ACTIONS.NEW_TAB && paths.length > 1) {
      for (const p of paths) fileOps.onFileAction(action, p);
      return;
    }

    // Single-target actions: act on the first path.
    fileOps.onFileAction(action, paths[0]);
  }, [fileOps, toggleBookmark, setBookmarksForPaths, isBookmarked, conflictFileAction]);

  const confirmResetToRemote = useCallback(async () => {
    setResetToRemotePending(false);
    if (!workspacePath) return;
    try {
      await window.api.sync.resetToRemote(workspacePath);
    } catch (err: any) {
      showError(`Reset to remote failed: ${err.message ?? err}`);
    }
  }, [workspacePath, showError]);

  const confirmKeepAll = useCallback(async () => {
    setKeepAllPending(false);
    if (!workspacePath) return;
    try {
      await window.api.sync.keepAll(workspacePath);
    } catch (err: any) {
      showError(`Keep entire tree failed: ${err.message ?? err}`);
    }
  }, [workspacePath, showError]);

  // Cloud-icon right-click → whole-tree resolution menu.
  const onConflictCloudMenu = useCallback(async () => {
    const choice = await window.api.showConflictCloudMenu();
    if (choice === 'reset') setResetToRemotePending(true);
    else if (choice === 'keep') setKeepAllPending(true);
  }, []);

  const cancelDelete = useCallback(() => setDeleteCandidates(null), []);
  const confirmDelete = useCallback(async () => {
    const paths = deleteCandidates;
    setDeleteCandidates(null);
    if (!paths) return;
    try {
      const trashed = await window.api.trashFiles(paths);
      for (const p of trashed) {
        closeTabsForPath(p);
        linkIndex.removeFile(p);
      }
      if (trashed.length > 0) await fileOps.treeAndIndexChanged();
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [deleteCandidates, closeTabsForPath, linkIndex, fileOps, showError]);

  const onToggleViewMode = useCallback(async () => {
    const next = viewMode === VIEW_MODES.LIVE ? VIEW_MODES.RAW : VIEW_MODES.LIVE;
    setViewMode(next);
    await persistSettings({ viewMode: next });
  }, [viewMode, persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onUndo = useCallback(() => { editorRef.current?.undo(); }, []);
  const onRedo = useCallback(() => { editorRef.current?.redo(); }, []);

  // ---- title commit (rename existing or save draft with this name) ----
  const onTitleCommit = useCallback(async (newName) => {
    if (!activeTab) return;
    if (activeTab.isDraft) {
      // Sync the ref synchronously so writeNow (running in this same tick)
      // sees the committed name; setTitleDraft alone wouldn't propagate to
      // titleDraftRef before writeNow reads it.
      titleDraftRef.current = newName;
      setTitleDraft(newName);
      dirtyTabIdRef.current = activeTab.id;
      await writeNow();
      // Refresh the tree right away — the watcher echo would also do this,
      // but we want snappy UI when the user explicitly named the file.
      await fileOps.treeAndIndexChanged();
      return;
    }
    if (!activeFile) return;
    const newPath = await fileOps.performRename(activeFile, newName);
    // Rename changes the basename → re-key the bookmark (move keeps it, rename
    // must follow). renameBookmarkName no-ops if it wasn't bookmarked.
    if (newPath && renameBookmarkName(bookmarkKey(activeFile), bookmarkKey(newPath))) persistBookmarks();
  }, [activeTab, activeFile, writeNow, fileOps, titleDraftRef, renameBookmarkName, persistBookmarks]);

  // ---- graph toggle ----
  const onToggleGraph = useCallback(async () => {
    await writeNow();
    setGraphMode((g) => !g);
  }, [writeNow]);

  // ---- new file (thin sidebar) ----
  const onNewFile = useCallback(async () => {
    if (!workspacePath) return;
    await addDraftTab();
  }, [workspacePath, addDraftTab]);

  // ---- templates ----
  // Holds template content destined for a freshly-opened draft; the editor
  // load effect (which owns a draft's initial buffer) consumes it. See below.
  const pendingTemplateRef = useRef<string | null>(null);

  // Insert a template (by absolute path) into the active editor, or — when no
  // editable doc is open — into a new draft. The draft/dirty/autosave path then
  // creates the file, exactly like typing or dropping an image into a draft.
  const applyTemplate = useCallback(async (absPath) => {
    if (!workspacePath || !absPath) return;
    let content: string;
    try {
      content = await window.api.readFile(absPath);
    } catch (err: any) {
      showError(err.message ?? String(err));
      return;
    }
    if (graphMode) setGraphMode(false);
    const hasEditableTab = !!activeTab && !activeMediaKind && !activeDrawing;
    if (hasEditableTab) {
      // Editor may be remounting if we just left graph mode — wait for the ref.
      const tryInsert = (attempt = 0) => {
        const ed = editorRef.current;
        if (ed) { ed.insertAtCursor(content); return; }
        if (attempt < 30) requestAnimationFrame(() => tryInsert(attempt + 1));
      };
      tryInsert();
    } else {
      pendingTemplateRef.current = content;
      await addDraftTab();
    }
  }, [workspacePath, graphMode, activeTab, activeMediaKind, activeDrawing, addDraftTab, showError]);

  // ---- create a folder + put it into rename mode ----
  const createFolderAt = useCallback(async (dirPath) => {
    try {
      const newPath = await window.api.createFolder(dirPath, 'New folder');
      await fileOps.treeAndIndexChanged();
      fileTreeRef.current?.editNode(newPath);
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [fileOps, showError]);

  // ---- folder context-menu actions (right-click on a tree folder) ----
  const onFolderAction = useCallback(async (action, folderPath) => {
    try {
      if (action === FOLDER_ACTIONS.NEW_FILE) {
        setSelectedFolderPath(folderPath);
        await addDraftTab();
      } else if (action === FOLDER_ACTIONS.NEW_FOLDER) {
        await createFolderAt(folderPath);
      } else if (action === FOLDER_ACTIONS.REVEAL) {
        await window.api.revealInFolder(folderPath);
      } else if (action === FOLDER_ACTIONS.RENAME) {
        fileTreeRef.current?.editNode(folderPath);
      } else if (action === FOLDER_ACTIONS.DELETE) {
        // Confirmation moves to the renderer ConfirmDialog (confirmFolderDelete).
        setFolderDeleteCandidate(folderPath);
      }
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [addDraftTab, createFolderAt, showError]);

  const cancelFolderDelete = useCallback(() => setFolderDeleteCandidate(null), []);
  const confirmFolderDelete = useCallback(async () => {
    const folderPath = folderDeleteCandidate;
    setFolderDeleteCandidate(null);
    if (!folderPath) return;
    try {
      await window.api.trashFolder(folderPath);
      // Sweep up any link-index entries inside the trashed folder so
      // backlinks/graph drop them immediately (don't wait for the watcher).
      const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
      const affected: any[] = [];
      for (const p of linkIndex.getOutgoingMap().keys()) {
        if (p.startsWith(prefix)) affected.push(p);
      }
      linkIndex.mutate((idx) => {
        for (const p of affected) idx.removeFile(p);
      });
      closeTabsUnderPath(folderPath);
      // Clear the selected folder if it's the one we just trashed.
      if (selectedFolderPath && (selectedFolderPath === folderPath || selectedFolderPath.startsWith(prefix))) {
        setSelectedFolderPath(null);
      }
      await fileOps.treeAndIndexChanged();
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [folderDeleteCandidate, closeTabsUnderPath, fileOps, linkIndex, selectedFolderPath, showError]);

  // ---- new folder from thin sidebar (root level, or current selected folder) ----
  const onNewFolder = useCallback(async () => {
    if (!workspacePath) return;
    const dir = selectedFolderPath || workspacePath;
    await createFolderAt(dir);
  }, [workspacePath, selectedFolderPath, createFolderAt]);

  // ---- empty-area right-click on the file tree → root-scoped folder menu ----
  const onRootContextMenu = useCallback(async () => {
    if (!workspacePath || conflictFilterActive) return;
    const action = await window.api.showFolderContextMenu({ isRoot: true });
    if (!action) return;
    onFolderAction(action, workspacePath);
  }, [workspacePath, conflictFilterActive, onFolderAction]);

  // ---- journal (calendar in thin sidebar) ----
  const { journalPickerAnchor, setJournalPickerAnchor, openJournal } = useDailyNote({
    workspacePath,
    dailyNoteRef,
    writeNow,
    openInActiveTab,
    linkIndex,
    fileOps,
    showError,
  });

  // ---- handle drag-and-drop moves from the tree ----
  // dragIds = list of source paths (files or folders). destFolderId is the destination
  // folder's path, or null for the workspace root.
  const onMoveItems = useCallback(async (dragIds, destFolderId) => {
    const destDir = destFolderId ?? workspacePath;
    if (!destDir) return;
    const affectedRenames: any[] = []; // [{oldPath, newPath}] for FILES (immediate + nested)

    for (const src of dragIds) {
      try {
        // No-op: dropping into the current parent.
        if (dirOf(src) === destDir) continue;
        // No-op: dropping a folder onto itself.
        if (src === destDir) continue;
        // Capture every linkIndex entry currently under this src (files + folder contents).
        const srcAsDir = src.endsWith('/') ? src : src + '/';
        const insideSrc: any[] = [];
        for (const p of linkIndex.getOutgoingMap().keys()) {
          if (p === src || p.startsWith(srcAsDir)) insideSrc.push(p);
        }

        const newPath = await window.api.moveItem(src, destDir);
        const newAsDir = newPath.endsWith('/') ? newPath : newPath + '/';

        // For folders: the folder rename causes every nested .md path to change.
        // For files: insideSrc contains just the file itself (if it was in the index).
        const renames = insideSrc.map((oldP) => {
          const suffix = oldP === src ? '' : oldP.slice(srcAsDir.length);
          const newP = suffix ? (newAsDir + suffix) : newPath;
          return { oldP, newP };
        });
        linkIndex.mutate((idx) => {
          for (const { oldP, newP } of renames) idx.renameFile(oldP, newP);
        });
        for (const { oldP, newP } of renames) {
          renameTabsPath(oldP, newP);
          affectedRenames.push({ oldPath: oldP, newPath: newP });
        }

        // Selected folder might have moved — track it.
        if (selectedFolderPath === src) setSelectedFolderPath(newPath);
        else if (selectedFolderPath && selectedFolderPath.startsWith(srcAsDir)) {
          setSelectedFolderPath(newAsDir + selectedFolderPath.slice(srcAsDir.length));
        }
      } catch (err: any) {
        showError(err.message ?? String(err));
      }
    }

    if (affectedRenames.length > 0 || dragIds.length > 0) {
      await fileOps.treeAndIndexChanged();
    }
  }, [workspacePath, linkIndex, renameTabsPath, fileOps, selectedFolderPath, showError]);

  // Disallow dropping ONTO a leaf node (you can only drop into folders).
  const disableDrop = useCallback(({ parentNode }) => {
    if (!parentNode) return false; // root drop is fine
    return !parentNode.isInternal;
  }, []);

  // ---- handle rename commits from the tree (files OR folders) ----
  //
  // Folder renames change every nested file's path. We re-key the link index
  // and any open tabs synchronously to keep them in sync — same shape as the
  // drag-and-drop move handler (onMoveItems above). Without this, the index
  // would carry stale path keys until the watcher echoed unlink+add for
  // every nested file, and any open tab inside the renamed folder would
  // point at a nonexistent path.
  const onTreeRename = useCallback(async ({ id, name }) => {
    // Folder vs file by the actual tree node, not by extension — non-.md files
    // (images, etc.) are still files and must not take the folder path.
    const treeNode = flattenAll(tree).find((n) => n.id === id);
    const isFolder = treeNode ? !!treeNode.children : !id.toLowerCase().endsWith('.md');
    if (isFolder) {
      try {
        // Capture nested .md paths from the index BEFORE renaming.
        const srcAsDir = id.endsWith('/') ? id : id + '/';
        const insideSrc: any[] = [];
        for (const p of linkIndex.getOutgoingMap().keys()) {
          if (p === id || p.startsWith(srcAsDir)) insideSrc.push(p);
        }
        // Flush any pending edits before the rename invalidates the path.
        await writeNow();
        const newFolderPath = await window.api.renameFolder(id, name);
        const newAsDir = newFolderPath.endsWith('/') ? newFolderPath : newFolderPath + '/';
        const renames = insideSrc.map((oldP) => {
          const suffix = oldP === id ? '' : oldP.slice(srcAsDir.length);
          const newP = suffix ? (newAsDir + suffix) : newFolderPath;
          return { oldP, newP };
        });
        linkIndex.mutate((idx) => {
          for (const { oldP, newP } of renames) idx.renameFile(oldP, newP);
        });
        for (const { oldP, newP } of renames) renameTabsPath(oldP, newP);
        if (selectedFolderPath === id) setSelectedFolderPath(newFolderPath);
        else if (selectedFolderPath && selectedFolderPath.startsWith(srcAsDir)) {
          setSelectedFolderPath(newAsDir + selectedFolderPath.slice(srcAsDir.length));
        }
        await fileOps.treeAndIndexChanged();
      } catch (err: any) {
        showError(err.message ?? String(err));
      }
      return;
    }
    // File: literal rename (name verbatim, no `.md` forcing). The link index
    // is updated per the extension transition: md→md re-keys + rewrites refs,
    // md→non-md drops it (its backlinks dangle, by design), non-md→md adds it.
    const literal = (name ?? '').trim();
    const oldName = id.slice(id.lastIndexOf('/') + 1);
    if (!literal || literal === oldName) return;
    if (findTreeRenameConflict({ tree, currentPath: id, newName: literal })) {
      showError(`"${literal}" already exists.`);
      return;
    }
    try {
      await writeNow();
      const oldIsMd = isMdName(oldName);
      const newIsMd = isMdName(literal);
      const finalPath = await window.api.renameFileLiteral(id, literal);
      const finalName = finalPath.slice(finalPath.lastIndexOf('/') + 1);
      const idx = linkIndex.linkIndexRef.current;
      if (oldIsMd && newIsMd) {
        idx.renameFile(id, finalPath);
        await rewriteReferences({
          api: window.api,
          linkIndex: idx,
          oldBaseName: oldName.replace(/\.md$/i, ''),
          newBaseName: finalName.replace(/\.md$/i, ''),
          selfPath: finalPath,
        });
        try { const c = await window.api.readFile(finalPath); idx.updateFile(finalPath, c); } catch { /* best effort */ }
      } else if (oldIsMd && !newIsMd) {
        idx.removeFile(id); // left markdown → drop from the index
      } else if (!oldIsMd && newIsMd) {
        try { const c = await window.api.readFile(finalPath); idx.updateFile(finalPath, c); } catch { /* best effort */ }
      }
      // Bookmarks are .md-keyed by basename: md→md re-keys the bookmark, md→non-md
      // drops it (no longer bookmarkable). Moves never reach here.
      let bmChanged = false;
      if (oldIsMd && newIsMd) bmChanged = renameBookmarkName(bookmarkKey(oldName), bookmarkKey(finalName));
      else if (oldIsMd && !newIsMd) bmChanged = removeBookmarkName(bookmarkKey(oldName));
      if (bmChanged) persistBookmarks();
      renameTabsPath(id, finalPath);
      await fileOps.treeAndIndexChanged();
    } catch (err: any) {
      showError(err.message ?? String(err));
    }
  }, [tree, fileOps, linkIndex, renameTabsPath, selectedFolderPath, showError, writeNow, renameBookmarkName, removeBookmarkName, persistBookmarks]);

  // ---- URL prompt (used by editor "Add" / "Edit" external link) ----
  // Always resolves to { url, text } | null. `text` is undefined in Add mode.
  const requestUrl = useCallback((opts: any = {}) => {
    return new Promise((resolve) => {
      setUrlPromptOpts({
        resolve,
        initialUrl: opts.initialUrl,
        initialText: opts.initialText,
      });
    });
  }, []);

  const handleUrlSubmit = useCallback((value) => {
    setUrlPromptOpts((prev) => { prev?.resolve?.(value); return null; });
  }, []);

  const handleUrlCancel = useCallback(() => {
    setUrlPromptOpts((prev) => { prev?.resolve?.(null); return null; });
  }, []);

  // ---- settings open helpers ----
  // Pass an explicit section to land on a specific page; omit to defer to the modal's
  // topmost section (whatever it currently is).
  const openSettings = useCallback((section?: any) => {
    setSettingsInitialSection(section ?? null);
    setSettingsOpen(true);
  }, []);

  // ---- beforeunload save ----
  useEffect(() => {
    const flush = () => { writeNow(); };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [writeNow]);

  // ---- external file change subscription ----
  //
  // Watcher events fall into four buckets:
  //   - {type:'add'|'change', path, mtime, outgoingLinks}             — .md file appeared or modified
  //   - {type:'unlink', path}                                          — .md file removed
  //   - {type:'rename', oldPath, newPath, mtime, outgoingLinks}        — paired by the correlator (inode+hash)
  //   - {type:'tree'}                                                  — folder change / non-.md (tree refresh only)
  //
  // The 'rename' event lets external renames (Finder, `mv`, agents, git checkout)
  // rewrite references the same way in-app renames do — without it, refs in
  // other files would break silently when something moves outside the app.
  //
  // Self-echo guard: every renderer-initiated write triggers a watcher event ~350ms
  // later. The renderer has already called linkIndex.updateFile with the file's
  // real stat.mtimeMs (returned by main from fs:writeFile), so the echo's
  // stat.mtimeMs will equal the stored mtime and we skip it.
  // Stable refs so the watcher subscription below depends ONLY on workspacePath
  // and never tears down on re-render. Critical: `linkIndex.bump()` (called by
  // `applyParsedLinks` / `removeFile` / `renameFile`) triggers a re-render; if
  // this effect re-ran on that, the 80ms `refreshTimer` set inside the listener
  // would be cleared by cleanup before it could fire, and the tree would never
  // refresh for external .md adds. See the deep dive on the file-watcher
  // gotcha in CLAUDE.md → Development workflow.
  useFsWatcher({
    workspacePath,
    linkIndex,
    refreshTree,
    renameTabsPath,
    showError,
    activeFile,
    activeIsDraft,
    editorRef,
    renameBookmarkName,
    removeBookmarkName,
    persistBookmarks,
    drawingViewRef,
    drawingMtimesRef,
  });

  // Re-seed bookmarks when bookmarks.json changes on disk out from under us
  // (sync pull, another machine, a hand edit). The main watcher ignores
  // .shockwave/, so main emits a dedicated `bookmarks:changed`. Subscribe once
  // per workspace; read the current tree via ref (no IPC) to prune dead paths.
  useEffect(() => {
    if (!workspacePath) return;
    const unsub = window.api.bookmarks.onChanged(async () => {
      const names = await window.api.bookmarks.read(workspacePath);
      seedBookmarks(names, bookmarkResolvableKeys());
    });
    return unsub;
  }, [workspacePath, seedBookmarks, bookmarkResolvableKeys]);

  // Agent `open_file` tool → open the file in a new tab. Main has already
  // confined the path to the active workspace; we re-gate on displayable types.
  // Subscribe once on mount; openInNewTab is read via ref so it stays stable.
  const openInNewTabRef = useSyncRef(openInNewTab);
  useEffect(() => {
    return window.api.agent.onOpenFile(({ path }) => {
      if (path && isOpenable(path)) openInNewTabRef.current(path);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- subscribe once; openInNewTab via ref

  // ---- boot: load settings + subscribe to system theme ----
  useEffect(() => {
    let active = true;
    let unsubscribe;
    (async () => {
      const [settings, initialTheme] = await Promise.all([
        window.api.settings.read(),
        window.api.theme.getInitial(),
      ]);
      if (!active) return;
      // Seed settings state + the canonical settingsRef from disk before any
      // save can fire (so an unchanged field isn't written as its default).
      hydrateSettings(settings);
      setSystemPrefersDark(!!initialTheme.dark);
      setWorkspaces(settings.workspaces || []);
      if (typeof settings.sidebarWidth === 'number') {
        setSidebarWidth(settings.sidebarWidth);
        sidebarWidthRef.current = settings.sidebarWidth;
      }
      if (typeof settings.chatSidebarOpen === 'boolean') {
        setChatSidebarOpen(settings.chatSidebarOpen);
        chatSidebarOpenRef.current = settings.chatSidebarOpen;
      }
      if (typeof settings.chatSidebarWidth === 'number') {
        setChatSidebarWidth(settings.chatSidebarWidth);
        chatSidebarWidthRef.current = settings.chatSidebarWidth;
      }
      if (settings.viewMode === VIEW_MODES.RAW || settings.viewMode === VIEW_MODES.LIVE) {
        setViewMode(settings.viewMode);
      }

      const lastId = settings.activeWorkspaceId;
      if (lastId) {
        const ws = (settings.workspaces || []).find((w) => w.id === lastId);
        if (ws) {
          const exists = await window.api.pathExists(ws.path);
          if (exists) {
            setActiveWorkspaceId(lastId);
            await loadWorkspace(ws);
          } else {
            // Drop it from the list and persist. Route through persistSettings
            // so the full settings object is written, not a partial that would
            // drop dailyNote/sync/etc.
            const next = (settings.workspaces || []).filter((w) => w.id !== lastId);
            setWorkspaces(next);
            await persistSettings({ workspaces: next, activeWorkspaceId: null });
            showError(`Workspace "${ws.name}" no longer exists at ${ws.path}.`);
          }
        }
      }

      unsubscribe = window.api.theme.onSystemChange(({ dark }) => {
        setSystemPrefersDark(!!dark);
      });
      setBootDone(true);
    })();
    return () => {
      active = false;
      if (unsubscribe) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- effect: load the active file's content into the editor ----
  // Tracks the last (tabId, path, isDark) we loaded into the editor. The
  // important case: when a draft is saved, the tab keeps its id but its path
  // flips from null to a real path. That is NOT a content load — the buffer
  // already holds the authoritative content (we just wrote it to disk). Same
  // tab, last path was null → skip the disk read. Tab switches, back/forward,
  // open-in-active-tab, theme toggles, and workspace switches all still load
  // because tabId / path / isDark differ.
  const lastLoadRef = useRef<any>({ tabId: null, path: null, isDark: null });
  useEffect(() => {
    if (!workspacePath) return;
    // Media + drawing tabs don't use the text editor — MediaView / DrawingView
    // own their content. Nothing to load here (reading them as text is garbage;
    // DrawingView loads its own JSON from the path prop).
    if (activeMediaKind || activeDrawing) {
      lastLoadRef.current = { tabId: activeTabId, path: activeFile, isDark };
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const last = lastLoadRef.current;
    if (activeIsDraft || !activeFile) {
      const pendingTpl = pendingTemplateRef.current;
      if (pendingTpl != null) {
        pendingTemplateRef.current = null;
        editor.setContent(pendingTpl, null);
        // Mark the draft dirty so the debounced writeNow creates the file —
        // same path as typing / image drop into a draft. Done via stable refs
        // (NOT onEditorChange) so this effect's dep array stays stable; adding
        // the recreated-every-render onEditorChange here caused an infinite
        // setContent→render→effect loop.
        setSaveState(SAVE_STATES.UNSAVED);
        dirtyTabIdRef.current = activeTabId;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => writeNowRef.current(), SAVE_DEBOUNCE_MS);
      } else {
        editor.setContent('', null);
      }
      lastLoadRef.current = { tabId: activeTabId, path: null, isDark };
      return;
    }
    // Promotion: same tab, previously had no path. Buffer is authoritative.
    if (last.tabId === activeTabId && last.path === null && last.isDark === isDark) {
      lastLoadRef.current = { tabId: activeTabId, path: activeFile, isDark };
      return;
    }
    // Already loaded.
    if (last.tabId === activeTabId && last.path === activeFile && last.isDark === isDark) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const text = await window.api.readFile(activeFile);
        if (cancelled) return;
        const ed = editorRef.current;
        if (!ed) return;
        const vs = tabsApi.viewStateByPath.current.get(activeFile) ?? null;
        ed.setContent(text, vs);
        lastLoadRef.current = { tabId: activeTabId, path: activeFile, isDark };
      } catch (err: any) {
        if (!cancelled) showError(err.message ?? String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [activeFile, activeIsDraft, activeTabId, workspacePath, isDark, tabsApi.viewStateByPath, showError, activeMediaKind, activeDrawing]);

  // ---- backlinks for active file ----
  const activeBacklinks = useMemo(
    () => linkIndex.getBacklinksForFile(activeFile),
    [activeFile, linkIndex],
  );

  // ---- title sync with active file/tab ----
  const titleFromActive = activeIsDraft
    ? ''
    : (activeFile ? prettyName(activeFile).split('/').pop() : '');
  // Layout effect — runs synchronously before paint so the title input never
  // renders with a stale draft against a freshly-switched activeFile (which
  // would briefly trigger a false title-conflict popup).
  useLayoutEffect(() => {
    setTitleDraft(titleFromActive);
  }, [titleFromActive]);

  // ---- title conflict (live validation while typing) ----
  const titleConflict = useMemo(() => {
    if (!workspacePath) return null;
    const draft = (titleDraft || '').trim();
    if (!draft) return null;
    if (!activeIsDraft && draft === titleFromActive) return null;
    return findNameConflict({
      tree,
      currentPath: activeFile,
      newName: draft,
    });
  }, [titleDraft, tree, workspacePath, activeFile, activeIsDraft, titleFromActive]);

  const onSidebarResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    const onMove = (ev) => {
      const next = Math.max(180, Math.min(600, startWidth + ev.clientX - startX));
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistSidebarWidth(sidebarWidthRef.current);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [persistSidebarWidth]);

  const persistChatSidebar = useCallback(async () => {
    await persistSettings({ workspaces, activeWorkspaceId });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const toggleChatSidebar = useCallback(() => {
    setChatSidebarOpen((prev) => {
      const next = !prev;
      chatSidebarOpenRef.current = next;
      persistChatSidebar();
      return next;
    });
  }, [persistChatSidebar]);

  // Build the framing snippet that gets dropped into the chat composer when
  // the user picks "Send to Agent" from the editor context menu. Path is
  // workspace-relative; selected text is fenced with ~~~ to avoid colliding
  // with code blocks inside it. Trailing newline puts the caret on a blank
  // line so the user can start typing their request.
  const {
    onSendToAgent,
    onSendDrawingToAgent,
    setChatSidebarRef,
    sendToAgentPending,
    setSendToAgentPending,
    applySendToAgent,
  } = useSendToAgent({ workspacePath, activeFile, chatSidebarOpenRef, setChatSidebarOpen, persistChatSidebar });

  const onChatSidebarResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = chatSidebarWidthRef.current;
    const onMove = (ev) => {
      // Chat sidebar is on the right edge, so dragging LEFT (negative delta) widens it.
      const next = Math.max(260, Math.min(720, startWidth - (ev.clientX - startX)));
      chatSidebarWidthRef.current = next;
      setChatSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistChatSidebar();
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [persistChatSidebar]);

  return (
    <div
      className="app"
      style={{
        '--sidebar-width': `${sidebarWidth}px`,
        '--chat-col-width': chatSidebarOpen ? `${chatSidebarWidth}px` : '28px',
      } as React.CSSProperties}
    >
      <ThinSidebar
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
        onOpenJournal={() => openJournal()}
        onJournalContextMenu={(x, y) => setJournalPickerAnchor({ x, y })}
        onToggleGraph={onToggleGraph}
        graphMode={graphMode}
        templates={templateFiles}
        onPickTemplate={applyTemplate}
        disabled={!workspacePath}
      />
      <QuickSearch
        open={quickSearchOpen}
        tree={sortedTree}
        sortOrder={treeSortOrder}
        workspacePath={workspacePath}
        onClose={() => setQuickSearchOpen(false)}
        onPick={async (path) => {
          setQuickSearchOpen(false);
          if (graphMode) setGraphMode(false);
          await openInActiveTab(path);
        }}
      />
      <JournalDatePicker
        open={!!journalPickerAnchor}
        anchor={journalPickerAnchor}
        onClose={() => setJournalPickerAnchor(null)}
        onPick={(date) => {
          setJournalPickerAnchor(null);
          openJournal(date);
        }}
      />

      <aside className="sidebar">
        <SortBar
          value={treeSortOrder}
          onChange={onTreeSortOrderChange}
          onOpenQuickSearch={() => setQuickSearchOpen(true)}
          onCollapseAll={() => fileTreeRef.current?.closeAll?.()}
          bookmarkFilterActive={bookmarkFilterActive}
          onToggleBookmarkFilter={() => { setConflictFilterActive(false); onBookmarkFilterActiveChange(!bookmarkFilterActive); }}
          bookmarkItems={bookmarkItems}
          onPickBookmark={async (path) => {
            if (graphMode) setGraphMode(false);
            await openInActiveTab(path);
          }}
          hasConflicts={hasConflicts}
          conflictCount={conflictPaths.length}
          conflictFilterActive={conflictFilterActive}
          onToggleConflictFilter={() => { onBookmarkFilterActiveChange(false); setConflictFilterActive((v) => !v); }}
          onConflictCloudMenu={onConflictCloudMenu}
          disabled={!workspacePath}
        />
        <div className="tree-wrap">
          {bookmarkFilterActive && sortedTree.length > 0 && (
            <div className="sidebar-list-header">Bookmarks</div>
          )}
          {sortedTree.length > 0 ? (
            <FileTree
              ref={fileTreeRef}
              data={sortedTree}
              onSelect={onSelect}
              onRename={onTreeRename}
              onFileAction={onFileActionWithBookmarks}
              onFolderAction={onFolderAction}
              onMoveItems={onMoveItems}
              disableDrop={disableDrop || conflictFilterActive}
              conflictMode={conflictFilterActive}
              checkRenameConflict={(name, id) => findTreeRenameConflict({ tree, currentPath: id, newName: name })}
              getIsBookmarked={isBookmarked}
              onRootContextMenu={onRootContextMenu}
              // In bookmark mode the list is flat; size the tree to its content
              // (rowHeight=24, matching FileTree) so the daily-notes list can sit
              // directly beneath it and tree-wrap scrolls them as one.
              fixedHeight={bookmarkFilterActive ? sortedTree.length * 24 : undefined}
            />
          ) : (
            <div
              className="empty"
              onContextMenu={(e) => {
                if (!workspacePath || conflictFilterActive) return;
                e.preventDefault();
                onRootContextMenu();
              }}
            >
              {!workspacePath
                ? 'No workspace open'
                : conflictFilterActive
                  ? 'No conflicts'
                  : bookmarkFilterActive
                    ? 'No bookmarks'
                    : 'Empty workspace'}
            </div>
          )}
          {bookmarkFilterActive && dailyNotesInBookmarks && (
            <DailyNotesPanel
              items={dailyNoteFiles}
              activePath={activeFile}
              onOpen={async (path) => {
                if (graphMode) setGraphMode(false);
                await openInActiveTab(path);
              }}
            />
          )}
        </div>
        <WorkspaceSelector
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSwitch={switchWorkspace}
          onManage={() => openSettings(SETTINGS_SECTIONS.WORKSPACES)}
          onOpenSettings={() => openSettings()}
        />
        <div
          className="sidebar-resize-handle"
          onMouseDown={onSidebarResizeStart}
        />
      </aside>

      <main className="editor-pane">
        {(() => {
          const u = appUpdate.status;
          if (!u?.updateAvailable || !u.url) return null;
          return (
            <button
              type="button"
              className="update-pill"
              onClick={() => window.api.openExternal(u.url!)}
              title={`Version ${u.latest} is available — you're on ${u.current}. Click to view the release.`}
            >
              Update available
            </button>
          );
        })()}
        {workspacePath && (
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            vaultPath={workspacePath}
            activeOverrideLabel={titleDraft}
            onSwitch={switchTab}
            onClose={closeTab}
            onAdd={addDraftTab}
          />
        )}
        {errorMessage && <div className="app-error">{errorMessage}</div>}

        {graphMode ? (
          <GraphView
            tree={tree}
            pageIndex={linkIndex.pageIndex}
            outgoingByFile={linkIndex.getOutgoingMap()}
            linkIndexVersion={linkIndex.version}
            dark={isDark}
            onOpenFile={async (id) => {
              setGraphMode(false);
              await openInActiveTab(id);
            }}
          />
        ) : workspacePath ? (
          <>
            <div className={activeDrawing ? 'editor-scroll editor-scroll-fill' : 'editor-scroll'}>
              {/* Drawings render full-bleed: no title bar or backlinks (the
                  link index is .md-only). The Editor stays mounted but hidden so
                  switching back to a text tab doesn't rebuild it. */}
              <div className={(activeTab && !activeDrawing) ? '' : 'editor-zone-hidden'}>
                <EditorNav
                  onBack={onBack}
                  onForward={onForward}
                  canGoBack={canGoBack}
                  canGoForward={canGoForward}
                />
                <EditorTitle
                  value={titleDraft}
                  onChange={setTitleDraft}
                  onCommit={onTitleCommit}
                  conflict={!!titleConflict}
                />
                {titleConflict && (
                  <ErrorMessage className="error-message-title">
                    There's already a file with the same name
                  </ErrorMessage>
                )}
              </div>
              <div className={activeTab ? '' : 'editor-zone-hidden'} style={(activeMediaKind || activeDrawing) ? { display: 'none' } : undefined}>
                <Editor
                  ref={editorRef}
                  onLinkClick={fileOps.onLinkClick}
                  onChange={onEditorChange}
                  getPageIndexRef={linkIndex.pageIndexRef}
                  getVaultPathRef={workspacePathRef}
                  getActiveFilePathRef={activeFilePathRef}
                  onImageError={showError}
                  onRequestUrl={requestUrl}
                  onSendToAgent={onSendToAgent}
                  flushDraftToDiskRef={flushDraftToDiskRef}
                  onStats={setEditorStats}
                  onHistory={setEditorHistory}
                  dark={isDark}
                  viewMode={viewMode}
                  hideLineNumbers={hideLineNumbers}
                />
              </div>
              {activeMediaKind && activeFile && (
                <MediaView path={activeFile} workspacePath={workspacePath} kind={activeMediaKind} />
              )}
              {activeDrawing && activeFile && (
                <DrawingView
                  ref={drawingViewRef}
                  key={activeFile}
                  path={activeFile}
                  dark={isDark}
                  onSaved={onDrawingSaved}
                  onError={showError}
                  onSendToAgent={onSendDrawingToAgent}
                />
              )}
              {activeTab && activeDrawing ? null : activeTab ? (
                <BacklinksPanel
                  groups={activeBacklinks}
                  vaultPath={workspacePath}
                  onOpen={openInActiveTab}
                />
              ) : (
                <div className="no-tab-cta">
                  <button className="create-file-btn" onClick={onNewFile}>
                    + Create new file
                  </button>
                  <div className="no-tab-hint">or pick a file from the sidebar</div>
                </div>
              )}
            </div>
            {activeTab && (
              <EditorStatusBar
                backlinkCount={activeBacklinks.length}
                words={(activeMediaKind || activeDrawing) ? 0 : editorStats.words}
                chars={(activeMediaKind || activeDrawing) ? 0 : editorStats.chars}
                viewMode={viewMode}
                onToggleViewMode={onToggleViewMode}
                saveState={saveState}
                canUndo={editorHistory.canUndo}
                canRedo={editorHistory.canRedo}
                onUndo={onUndo}
                onRedo={onRedo}
                syncStatus={syncStatus}
                onOpenConflicts={() => { onBookmarkFilterActiveChange(false); setConflictFilterActive(true); }}
                onEnableSync={() => {
                  if (!workspacePath) return;
                  window.api.sync.setWorkspaceDisabled({ workspacePath, disabled: false })
                    .catch((err: any) => showError(`Couldn't enable sync: ${err.message ?? err}`));
                }}
              />
            )}
          </>
        ) : (
          <div className="empty centered">
            {bootDone ? `Welcome to ${APP_NAME}. Add a workspace from the gear icon to get started.` : ''}
          </div>
        )}
      </main>

      {chatSidebarOpen ? (
        <aside className="chat-sidebar-wrap" key={workspacePath ?? 'no-workspace'}>
          <div
            className="chat-sidebar-resize-handle"
            onMouseDown={onChatSidebarResizeStart}
          />
          <ChatSidebar ref={setChatSidebarRef} onClose={toggleChatSidebar} workspacePath={workspacePath} />
        </aside>
      ) : (
        <button
          type="button"
          className="chat-sidebar-strip"
          onClick={toggleChatSidebar}
          title="Open coding agent"
          aria-label="Open coding agent"
        >
          <svg
            className="chat-sidebar-strip-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width={16}
            height={16}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 8V4H8" />
            <rect width={16} height={12} x={4} y={8} rx={2} />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M15 13v2" />
            <path d="M9 13v2" />
          </svg>
          <span className="chat-sidebar-strip-label">Agent Chat</span>
        </button>
      )}

      {urlPromptOpts && (
        <UrlPromptModal
          onSubmit={handleUrlSubmit}
          onCancel={handleUrlCancel}
          initialUrl={urlPromptOpts.initialUrl}
          initialText={urlPromptOpts.initialText}
        />
      )}

      <ConfirmDialog
        open={!!deleteCandidates}
        title={deleteCandidates && deleteCandidates.length > 1 ? 'Delete files' : 'Delete file'}
        message={
          !deleteCandidates
            ? ''
            : deleteCandidates.length > 1
              ? `Move ${deleteCandidates.length} files to the Trash? This can't be undone from inside the app.`
              : `Move "${basenameOf(deleteCandidates[0])}" to the Trash? This can't be undone from inside the app.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onClose={cancelDelete}
      />

      <ConfirmDialog
        open={!!folderDeleteCandidate}
        title="Delete folder"
        message={
          folderDeleteCandidate
            ? `Move "${basenameOf(folderDeleteCandidate)}" and everything inside it to the Trash? This can't be undone from inside the app.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmFolderDelete}
        onClose={cancelFolderDelete}
      />

      <ConfirmDialog
        open={resetToRemotePending}
        title="Reset entire tree"
        message="Discard all local changes in this workspace and take the GitHub version? This throws away your un-synced edits and can't be undone."
        confirmLabel="Reset to remote"
        destructive
        onConfirm={confirmResetToRemote}
        onClose={() => setResetToRemotePending(false)}
      />

      <ConfirmDialog
        open={keepAllPending}
        title="Keep entire tree"
        message="Resolve every conflict in favor of your version? On the next sync this overwrites the other machine's conflicting edits on GitHub."
        confirmLabel="Keep ours"
        destructive
        onConfirm={confirmKeepAll}
        onClose={() => setKeepAllPending(false)}
      />

      <Dialog
        open={!!sendToAgentPending}
        onClose={() => setSendToAgentPending(null)}
        title="Send to Agent"
        footer={
          <>
            <button
              className="dialog-button"
              onClick={() => {
                const s = sendToAgentPending;
                setSendToAgentPending(null);
                if (s) applySendToAgent(s, { append: true });
              }}
            >
              Append
            </button>
            <button
              className="dialog-button dialog-button-primary"
              onClick={() => {
                const s = sendToAgentPending;
                setSendToAgentPending(null);
                if (s) applySendToAgent(s, { append: false });
              }}
            >
              Replace
            </button>
            <button className="dialog-button" onClick={() => setSendToAgentPending(null)}>
              Cancel
            </button>
          </>
        }
      >
        The chat composer already has text. Replace it with the selection, or append to it?
      </Dialog>

      {settingsOpen && (
        <SettingsModal
          initialSection={settingsInitialSection}
          onClose={() => setSettingsOpen(false)}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onAddWorkspace={addWorkspace}
          onSwitchWorkspace={switchWorkspace}
          onRemoveWorkspace={removeWorkspace}
          themeMode={themeMode}
          onThemeModeChange={onThemeModeChange}
          hideLineNumbers={hideLineNumbers}
          onHideLineNumbersChange={onHideLineNumbersChange}
          dailyNotesInBookmarks={dailyNotesInBookmarks}
          onDailyNotesInBookmarksChange={onDailyNotesInBookmarksChange}
          dailyNote={dailyNote}
          onDailyNoteChange={onDailyNoteChange}
          templates={templates}
          onTemplatesChange={onTemplatesChange}
          templateOptions={templateOptions}
          tree={tree}
          workspacePath={workspacePath}
          codingAgent={codingAgentSettings}
          onCodingAgentChange={onCodingAgentChange}
          agentSecrets={agentSecrets}
          onAgentSecretsChange={onAgentSecretsChange}
          transcription={transcription}
          onTranscriptionChange={onTranscriptionChange}
          sync={sync}
          onSyncChange={onSyncChange}
          onSyncDisabledChange={onSyncDisabledChange}
          appUpdate={appUpdate}
          saveStatus={saveStatus}
        />
      )}
    </div>
  );
}
