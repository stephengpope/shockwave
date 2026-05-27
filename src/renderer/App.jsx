import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import FileTree from './FileTree.jsx';
import Editor from './Editor.jsx';
import BacklinksPanel from './BacklinksPanel.jsx';
import GraphView from './GraphView.jsx';
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
import { formatDailyNote, resolveDailyNotePath } from './dailyNote.js';
import { basenameOf, dirOf, toRelPath, toAbsPath } from './pathUtils.js';
import { diffWordsWithSpace } from 'diff';
import { rangesAddedFromDiff } from './diffFlash.js';
import { prettyName } from './linkIndex.js';
import { rewriteReferences } from './renameOps.js';
import { SETTINGS_SECTIONS, THEME_MODES, APP_NAME, FOLDER_ACTIONS, DEFAULT_PROVIDER_SLUG, VIEW_MODES, SAVE_STATES, TREE_SORT_ORDERS, FILE_ACTIONS } from './constants.js';
import SortBar from './SortBar.jsx';
import { useLinkIndex } from './hooks/useLinkIndex.js';
import { useTabs } from './hooks/useTabs.js';
import { useFileOps } from './hooks/useFileOps.js';
import { useSyncRef } from './hooks/useSyncRef.js';

const SAVE_DEBOUNCE_MS = 500;

function genWorkspaceId() {
  return 'ws_' + Math.random().toString(36).slice(2, 10);
}


// Prune the tree to only the bookmarked files and the folders that contain
// them. Folders with no bookmarked descendants are removed.
function filterTreeToBookmarks(nodes, bookmarkedSet) {
  const out = [];
  for (const n of nodes) {
    if (n.children) {
      const filteredChildren = filterTreeToBookmarks(n.children, bookmarkedSet);
      if (filteredChildren.length > 0) {
        out.push({ ...n, children: filteredChildren });
      }
    } else if (bookmarkedSet.has(n.id)) {
      out.push(n);
    }
  }
  return out;
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

function flattenAll(nodes, out = []) {
  for (const n of nodes) {
    if (n.children) flattenAll(n.children, out);
    out.push(n);
  }
  return out;
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

export default function App() {
  // ---- top-level state ----
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  const [tree, setTree] = useState([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState(null);
  const [graphMode, setGraphMode] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState(SETTINGS_SECTIONS.WORKSPACES);
  // When set, renders <UrlPromptModal>. `resolve` is the awaiting promise's
  // resolver. `initialUrl` / `initialText` (Edit mode) optionally pre-fill the
  // form. Resolver receives { url, text } | null.
  const [urlPromptOpts, setUrlPromptOpts] = useState(null);
  const [journalPickerAnchor, setJournalPickerAnchor] = useState(null);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  // Bookmarks: a Set of absolute file paths in the current workspace. The
  // on-disk file (`<workspace>/.shockwave/bookmarks.json`) stores workspace-
  // relative paths; we convert on read/write.
  const [bookmarks, setBookmarks] = useState(() => new Set());
  const bookmarksRef = useSyncRef(bookmarks);
  const [bookmarkFilterActive, setBookmarkFilterActive] = useState(false);
  const [themeMode, setThemeMode] = useState(THEME_MODES.SYSTEM);
  const [hideLineNumbers, setHideLineNumbers] = useState(false);
  const hideLineNumbersRef = useSyncRef(hideLineNumbers);
  const [dailyNote, setDailyNote] = useState({ format: 'YYYY-MM-DD', folder: '' });
  const dailyNoteRef = useSyncRef(dailyNote);
  const [treeSortOrder, setTreeSortOrder] = useState(TREE_SORT_ORDERS.NAME_ASC);
  const treeSortOrderRef = useSyncRef(treeSortOrder);
  const sortedTree = useMemo(() => {
    const base = bookmarkFilterActive ? filterTreeToBookmarks(tree, bookmarks) : tree;
    return sortTreeNodes(base, treeSortOrder);
  }, [tree, treeSortOrder, bookmarkFilterActive, bookmarks]);
  const [codingAgentSettings, setCodingAgentSettings] = useState({
    provider: DEFAULT_PROVIDER_SLUG,
    model: 'claude-sonnet-4-5',
    apiKey: '',
    skills: { global: {}, workspaces: {} },
  });
  const codingAgentSettingsRef = useSyncRef(codingAgentSettings);
  // Global agent secrets — list of { name, description, token, createdAt, updatedAt }.
  // Tokens come from main already decrypted; persisted via the standard settings flow.
  const [agentSecrets, setAgentSecrets] = useState([]);
  const agentSecretsRef = useSyncRef(agentSecrets);
  // AssemblyAI streaming transcription config. apiKey arrives decrypted from main.
  const [transcription, setTranscription] = useState({ provider: 'assemblyai', apiKey: '' });
  const transcriptionRef = useSyncRef(transcription);
  // GitHub sync config. PAT arrives decrypted from main and is sent back as
  // plaintext on every save (main re-encrypts via safeStorage's idempotent
  // encryptSecret).
  const [sync, setSync] = useState({ pat: '', pullIntervalSeconds: 10 });
  const syncRef = useSyncRef(sync);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [bootDone, setBootDone] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const sidebarWidthRef = useRef(260);
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const chatSidebarOpenRef = useRef(false);
  const [chatSidebarWidth, setChatSidebarWidth] = useState(360);
  const chatSidebarWidthRef = useRef(360);
  const [viewMode, setViewMode] = useState(VIEW_MODES.LIVE);
  const [editorStats, setEditorStats] = useState({ words: 0, chars: 0 });
  const [editorHistory, setEditorHistory] = useState({ canUndo: false, canRedo: false });
  const [saveState, setSaveState] = useState(SAVE_STATES.SAVED);
  // Pending "Send to Agent" payload waiting on the Replace/Append decision.
  // Non-null only while the collision dialog is open.
  const [sendToAgentPending, setSendToAgentPending] = useState(null);
  // Sync engine status pushed from main via `sync:status` events.
  // status: 'disabled' | 'idle' | 'syncing' | 'paused' | 'error'.
  const [syncStatus, setSyncStatus] = useState({ status: 'disabled', detail: '', lastSyncAt: null });

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const workspacePath = activeWorkspace?.path ?? null;
  const workspacePathRef = useSyncRef(workspacePath);

  // Live ref to the active file's absolute path. Used by the editor's image
  // paste/drop handler (target dir for the saved image) and the inline image
  // renderer (base for resolving relative URLs). Null for drafts.
  const activeFilePathRef = useRef(null);

  // ---- app title ----
  useEffect(() => {
    document.title = APP_NAME;
  }, []);

  // Sync engine bridge — once on mount, no workspace dep. The engine asks us
  // to flush dirty editor tabs before each tick; we writeNow then ack with
  // the same token. Status events update the status-bar icon.
  useEffect(() => {
    const unsubFlush = window.api.sync.onFlushRequest(async (token) => {
      try { await writeNowRef.current(); } catch {}
      window.api.sync.flushDone(token).catch(() => {});
    });
    const unsubStatus = window.api.sync.onStatus((s) => setSyncStatus(s));
    // Seed the current status so the icon doesn't flash 'disabled' on reload
    // when the engine is already running.
    window.api.sync.engineStatus().then((s) => { if (s) setSyncStatus(s); }).catch(() => {});
    return () => {
      unsubFlush();
      unsubStatus();
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
  const errorTimerRef = useRef(null);
  const showError = useCallback((msg) => {
    setErrorMessage(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null;
      setErrorMessage(null);
    }, 4000);
  }, []);

  // ---- editor ref ----
  const editorRef = useRef(null);
  // ---- file tree ref (imperative API: editNode(id)) ----
  const fileTreeRef = useRef(null);
  // ---- chat sidebar ref (imperative API: setComposerText, getComposerText, focusComposer) ----
  // Use a callback ref + ready flag so the "Send to Agent" pending injection
  // effect re-runs when ChatSidebar mounts (sidebar was previously collapsed).
  const chatSidebarRef = useRef(null);
  const [chatSidebarReady, setChatSidebarReady] = useState(false);
  const setChatSidebarRef = useCallback((handle) => {
    chatSidebarRef.current = handle;
    setChatSidebarReady(!!handle);
  }, []);
  // { text, append } waiting for the sidebar's imperative ref to attach.
  const [pendingComposerInjection, setPendingComposerInjection] = useState(null);

  // ---- save lifecycle (stays in App, crosses concerns) ----
  // dirtyTabIdRef holds the tab id that needs flushing. For drafts (no path
  // yet) writeNow creates the file using titleDraft (or "Untitled") at the
  // moment of save; for real files it writes through. Per-tab in-flight guard
  // coalesces concurrent calls so two near-simultaneous saves can't both fire
  // createFile and leave an orphan disambiguated file behind.
  const dirtyTabIdRef = useRef(null);
  const saveTimerRef = useRef(null);
  const writeInFlightRef = useRef(new Map());
  // Forward refs filled below by useSyncRef once useTabs/newFileDir exist.
  const tabsRef = useRef([]);
  const activeTabIdRef = useRef(null);
  const titleDraftRef = useSyncRef(titleDraft);
  const newFileDirRef = useRef(() => null);
  const promoteTabPathRef = useRef(() => {});

  const linkIndex = useLinkIndex(tree);

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
        if (tab.isDraft) {
          // Only trust titleDraft when the dirty tab is also the active tab;
          // for any other tab (background flush during switch) fall back.
          const candidate = tabId === activeTabIdRef.current ? (titleDraftRef.current || '') : '';
          const name = (candidate || 'Untitled').replace(/\.md$/i, '').trim() || 'Untitled';
          const targetDir = newFileDirRef.current();
          if (!targetDir) throw new Error('No active workspace');
          path = await window.api.createFile(targetDir, `${name}.md`, text);
          promoteTabPathRef.current(tabId, path);
        } else {
          path = tab.path;
          await window.api.writeFile(path, text);
        }
        linkIndex.updateFile(path, text);
        if (dirtyTabIdRef.current === null) setSaveState(SAVE_STATES.SAVED);
        return path;
      } catch (err) {
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
    closeTabsForPath,
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
    if (!node.data.name.toLowerCase().endsWith('.md')) return;
    if (graphMode) setGraphMode(false);
    await openInActiveTab(node.id);
  }, [openInActiveTab, graphMode]);

  // ---- workspace operations ----
  const viewModeRef = useSyncRef(viewMode);

  // 'idle' | 'saving' | 'saved' | 'error'. `idle` hides the indicator; we land
  // there 1.5s after a successful save so the badge fades out when nothing's
  // happening. A ref counts in-flight writes so overlapping saves don't flip
  // us back to 'saved' too early.
  const [saveStatus, setSaveStatus] = useState('idle');
  const inFlightSavesRef = useRef(0);
  const savedFadeTimerRef = useRef(null);

  const persistSettings = useCallback(async (next) => {
    inFlightSavesRef.current += 1;
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
    setSaveStatus('saving');
    try {
      await window.api.settings.write({
        workspaces: next.workspaces,
      activeWorkspaceId: next.activeWorkspaceId,
      appearance: {
        themeMode: next.themeMode,
        hideLineNumbers: next.hideLineNumbers ?? hideLineNumbersRef.current,
      },
      dailyNote: next.dailyNote ?? dailyNoteRef.current,
      treeSortOrder: next.treeSortOrder ?? treeSortOrderRef.current,
      codingAgent: next.codingAgent ?? codingAgentSettingsRef.current,
      agentSecrets: next.agentSecrets ?? agentSecretsRef.current,
      transcription: next.transcription ?? transcriptionRef.current,
      sync: next.sync ?? syncRef.current,
      sidebarWidth: next.sidebarWidth ?? sidebarWidthRef.current,
      viewMode: next.viewMode ?? viewModeRef.current,
      chatSidebarOpen: next.chatSidebarOpen ?? chatSidebarOpenRef.current,
      chatSidebarWidth: next.chatSidebarWidth ?? chatSidebarWidthRef.current,
      });
      inFlightSavesRef.current -= 1;
      if (inFlightSavesRef.current === 0) {
        setSaveStatus('saved');
        // Fade back to idle after 1.5s so the badge isn't permanent.
        savedFadeTimerRef.current = setTimeout(() => {
          savedFadeTimerRef.current = null;
          setSaveStatus('idle');
        }, 1500);
      }
    } catch (err) {
      inFlightSavesRef.current -= 1;
      setSaveStatus('error');
    }
  }, []);

  const persistSidebarWidth = useCallback(async (width) => {
    sidebarWidthRef.current = width;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, sidebarWidth: width });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const loadWorkspace = useCallback(async (workspace) => {
    await writeNow();
    await window.api.watchStop();
    resetTabs();
    setTree([]);
    setSelectedFolderPath(null);
    setGraphMode(false);
    setSaveState(SAVE_STATES.SAVED);
    setBookmarks(new Set());
    setBookmarkFilterActive(false);
    const [treeData, files, bookmarkRelPaths] = await Promise.all([
      window.api.readTree(workspace.path),
      window.api.readAllMarkdown(workspace.path),
      window.api.bookmarks.read(workspace.path),
    ]);
    setTree(treeData);
    linkIndex.rebuild(files);
    // Convert stored rel paths to abs paths and prune stale entries (files
    // that no longer exist on disk). A subsequent write trims the on-disk
    // file too — we don't keep dangling refs around.
    const absSet = new Set();
    const stillExists = new Set(files.map((f) => f.path));
    let needsRewrite = false;
    for (const rel of bookmarkRelPaths) {
      const abs = toAbsPath(rel, workspace.path);
      if (abs && stillExists.has(abs)) absSet.add(abs);
      else needsRewrite = true;
    }
    setBookmarks(absSet);
    bookmarksRef.current = absSet;
    if (needsRewrite) {
      const cleaned = Array.from(absSet).map((p) => toRelPath(p, workspace.path)).filter(Boolean);
      window.api.bookmarks.write(workspace.path, cleaned).catch(() => {});
    }
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
      await persistSettings({ workspaces: removed, activeWorkspaceId: null, themeMode });
      showError(`Workspace "${ws.name}" no longer exists.`);
      return;
    }
    setActiveWorkspaceId(id);
    await persistSettings({ workspaces, activeWorkspaceId: id, themeMode });
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
    await persistSettings({ workspaces: next, activeWorkspaceId: ws.id, themeMode });
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
    await persistSettings({ workspaces: next, activeWorkspaceId: newActive, themeMode });
  }, [workspaces, activeWorkspaceId, persistSettings, themeMode, resetTabs]);

  const onThemeModeChange = useCallback(async (mode) => {
    setThemeMode(mode);
    await persistSettings({ workspaces, activeWorkspaceId, themeMode: mode });
  }, [persistSettings, workspaces, activeWorkspaceId]);

  const onHideLineNumbersChange = useCallback(async (next) => {
    setHideLineNumbers(next);
    hideLineNumbersRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, hideLineNumbers: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onDailyNoteChange = useCallback(async (next) => {
    setDailyNote(next);
    dailyNoteRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, dailyNote: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onTreeSortOrderChange = useCallback(async (next) => {
    setTreeSortOrder(next);
    treeSortOrderRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, treeSortOrder: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  // Bookmark toggle. Writes the new set to disk (workspace-relative paths).
  const toggleBookmark = useCallback(async (absPath) => {
    if (!workspacePath || !absPath) return;
    const next = new Set(bookmarksRef.current);
    if (next.has(absPath)) next.delete(absPath);
    else next.add(absPath);
    setBookmarks(next);
    bookmarksRef.current = next;
    const rels = Array.from(next).map((p) => toRelPath(p, workspacePath)).filter(Boolean);
    try {
      await window.api.bookmarks.write(workspacePath, rels);
    } catch (err) {
      showError(`Failed to save bookmarks: ${err.message ?? err}`);
    }
  }, [workspacePath, showError]);

  // Force every path in `paths` to bookmarked === `desired`. One write to disk
  // for the whole batch (a loop of toggleBookmark would write N times).
  const setBookmarksForPaths = useCallback(async (paths, desired) => {
    if (!workspacePath || !paths || paths.length === 0) return;
    const next = new Set(bookmarksRef.current);
    for (const p of paths) {
      if (desired) next.add(p);
      else next.delete(p);
    }
    setBookmarks(next);
    bookmarksRef.current = next;
    const rels = Array.from(next).map((p) => toRelPath(p, workspacePath)).filter(Boolean);
    try {
      await window.api.bookmarks.write(workspacePath, rels);
    } catch (err) {
      showError(`Failed to save bookmarks: ${err.message ?? err}`);
    }
  }, [workspacePath, showError]);

  // Rewrite a single path inside the bookmark set (used by rename flows).
  // No write here — caller batches and persists once.
  const renameBookmarkPath = useCallback((oldPath, newPath) => {
    const cur = bookmarksRef.current;
    if (!cur.has(oldPath)) return false;
    const next = new Set(cur);
    next.delete(oldPath);
    next.add(newPath);
    setBookmarks(next);
    bookmarksRef.current = next;
    return true;
  }, []);

  // Drop a path from the bookmark set (used when a file is deleted).
  const removeBookmarkPath = useCallback((absPath) => {
    const cur = bookmarksRef.current;
    if (!cur.has(absPath)) return false;
    const next = new Set(cur);
    next.delete(absPath);
    setBookmarks(next);
    bookmarksRef.current = next;
    return true;
  }, []);

  // Persist current bookmarks to disk. Used after batched rename/delete edits.
  const persistBookmarks = useCallback(async () => {
    if (!workspacePath) return;
    const rels = Array.from(bookmarksRef.current).map((p) => toRelPath(p, workspacePath)).filter(Boolean);
    try {
      await window.api.bookmarks.write(workspacePath, rels);
    } catch (err) {
      console.warn('[bookmarks] persist failed:', err);
    }
  }, [workspacePath]);

  // Bulk-delete confirmation state. Set by the action wrapper when DELETE
  // arrives with >1 path; the ConfirmDialog renders below.
  const [bulkDeleteCandidates, setBulkDeleteCandidates] = useState(null);

  // Action wrapper around fileOps.onFileAction. Two responsibilities:
  // 1) Handle TOGGLE_BOOKMARK (kept here so useFileOps stays bookmark-free).
  // 2) Handle multi-path actions — FileTree passes an array of paths from a
  //    right-click on a multi-selection. Single-target actions (DUPLICATE,
  //    REVEAL, RENAME) collapse to the first path; bulk-safe actions
  //    (TOGGLE_BOOKMARK, DELETE, NEW_TAB) fan out.
  const onFileActionWithBookmarks = useCallback((action, filePathOrPaths) => {
    const paths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
    if (paths.length === 0) return;

    if (action === FILE_ACTIONS.TOGGLE_BOOKMARK) {
      if (paths.length === 1) {
        toggleBookmark(paths[0]);
      } else {
        // Mirror the menu label: if all selected files are bookmarked, the user
        // saw "Remove N bookmarks" — clear them. Otherwise they saw
        // "Bookmark N files" — set them all bookmarked.
        const allBookmarked = paths.every((p) => bookmarksRef.current.has(p));
        setBookmarksForPaths(paths, !allBookmarked);
      }
      return;
    }

    if (action === FILE_ACTIONS.DELETE && paths.length > 1) {
      // Bulk delete: skip per-file OS confirms, show one renderer-side confirm.
      setBulkDeleteCandidates(paths);
      return;
    }

    if (action === FILE_ACTIONS.NEW_TAB && paths.length > 1) {
      for (const p of paths) fileOps.onFileAction(action, p);
      return;
    }

    // Single-target actions: act on the first path.
    fileOps.onFileAction(action, paths[0]);
  }, [fileOps, toggleBookmark, setBookmarksForPaths]);

  const cancelBulkDelete = useCallback(() => setBulkDeleteCandidates(null), []);
  const confirmBulkDelete = useCallback(async () => {
    const paths = bulkDeleteCandidates;
    setBulkDeleteCandidates(null);
    if (!paths) return;
    try {
      const trashed = await window.api.trashFiles(paths);
      for (const p of trashed) {
        closeTabsForPath(p);
        linkIndex.removeFile(p);
      }
      if (trashed.length > 0) await fileOps.treeAndIndexChanged();
    } catch (err) {
      showError(err.message ?? String(err));
    }
  }, [bulkDeleteCandidates, closeTabsForPath, linkIndex, fileOps, showError]);

  const onToggleViewMode = useCallback(async () => {
    const next = viewMode === VIEW_MODES.LIVE ? VIEW_MODES.RAW : VIEW_MODES.LIVE;
    setViewMode(next);
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, viewMode: next });
  }, [viewMode, persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onUndo = useCallback(() => { editorRef.current?.undo(); }, []);
  const onRedo = useCallback(() => { editorRef.current?.redo(); }, []);

  const onCodingAgentChange = useCallback(async (next) => {
    setCodingAgentSettings(next);
    codingAgentSettingsRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, codingAgent: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onAgentSecretsChange = useCallback(async (next) => {
    setAgentSecrets(next);
    agentSecretsRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, agentSecrets: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onTranscriptionChange = useCallback(async (next) => {
    setTranscription(next);
    transcriptionRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, transcription: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  const onSyncChange = useCallback(async (next) => {
    setSync(next);
    syncRef.current = next;
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, sync: next });
    // Restart the engine so PAT / interval changes take effect immediately.
    // engineStart no-ops cleanly when there's no active workspace.
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (ws) {
      window.api.sync.engineStart({
        workspacePath: ws.path,
        intervalSeconds: next.pullIntervalSeconds,
      }).catch(() => {});
    }
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

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
    await fileOps.performRename(activeFile, newName);
  }, [activeTab, activeFile, writeNow, fileOps, titleDraftRef]);

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

  // ---- create a folder + put it into rename mode ----
  const createFolderAt = useCallback(async (dirPath) => {
    try {
      const newPath = await window.api.createFolder(dirPath, 'New folder');
      await fileOps.treeAndIndexChanged();
      fileTreeRef.current?.editNode(newPath);
    } catch (err) {
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
        const confirmed = await window.api.trashFolder(folderPath);
        if (!confirmed) return;
        // Sweep up any link-index entries inside the trashed folder so
        // backlinks/graph drop them immediately (don't wait for the watcher).
        const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
        const affected = [];
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
      }
    } catch (err) {
      showError(err.message ?? String(err));
    }
  }, [addDraftTab, createFolderAt, closeTabsUnderPath, fileOps, linkIndex, selectedFolderPath, showError]);

  // ---- new folder from thin sidebar (root level, or current selected folder) ----
  const onNewFolder = useCallback(async () => {
    if (!workspacePath) return;
    const dir = selectedFolderPath || workspacePath;
    await createFolderAt(dir);
  }, [workspacePath, selectedFolderPath, createFolderAt]);

  // ---- journal (calendar in thin sidebar) ----
  // openJournal(date?) — opens (or creates) the daily note for `date` (default
  // today) using the user's configured format + folder. If the format contains
  // "/" the leading segments become subfolders. Existing notes are opened in
  // place regardless of where they live (basename uniqueness is workspace-wide).
  const openJournal = useCallback(async (date) => {
    if (!workspacePath) return;
    const d = date ?? new Date();
    const dn = dailyNoteRef.current;
    const formatted = formatDailyNote(dn.format, d);
    if (!formatted) {
      showError('Daily note format is invalid. Open Settings → Daily Note to fix it.');
      return;
    }
    const { dir, name } = resolveDailyNotePath(workspacePath, dn.folder, formatted);
    try {
      await writeNow();
      const existing = linkIndex.pageIndexRef.current.get(name.toLowerCase());
      if (existing) {
        await openInActiveTab(existing);
        return;
      }
      await window.api.ensureDir(dir);
      const newPath = await window.api.createFile(dir, `${name}.md`, '');
      linkIndex.updateFile(newPath, '');
      await fileOps.treeAndIndexChanged();
      await openInActiveTab(newPath);
    } catch (err) {
      showError(err.message ?? String(err));
    }
  }, [workspacePath, writeNow, linkIndex, openInActiveTab, fileOps, showError]);

  // ---- handle drag-and-drop moves from the tree ----
  // dragIds = list of source paths (files or folders). destFolderId is the destination
  // folder's path, or null for the workspace root.
  const onMoveItems = useCallback(async (dragIds, destFolderId) => {
    const destDir = destFolderId ?? workspacePath;
    if (!destDir) return;
    const affectedRenames = []; // [{oldPath, newPath}] for FILES (immediate + nested)

    for (const src of dragIds) {
      try {
        // No-op: dropping into the current parent.
        if (dirOf(src) === destDir) continue;
        // No-op: dropping a folder onto itself.
        if (src === destDir) continue;
        // Capture every linkIndex entry currently under this src (files + folder contents).
        const srcAsDir = src.endsWith('/') ? src : src + '/';
        const insideSrc = [];
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
      } catch (err) {
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
    const isFolder = !id.toLowerCase().endsWith('.md');
    if (isFolder) {
      try {
        // Capture nested .md paths from the index BEFORE renaming.
        const srcAsDir = id.endsWith('/') ? id : id + '/';
        const insideSrc = [];
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
      } catch (err) {
        showError(err.message ?? String(err));
      }
      return;
    }
    return fileOps.performRename(id, name);
  }, [fileOps, linkIndex, renameTabsPath, selectedFolderPath, showError, writeNow]);

  // ---- URL prompt (used by editor "Add" / "Edit" external link) ----
  // Always resolves to { url, text } | null. `text` is undefined in Add mode.
  const requestUrl = useCallback((opts = {}) => {
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
  const openSettings = useCallback((section) => {
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
  // later. The renderer has already called linkIndex.updateFile with a Date.now()
  // mtime, so the echo's stat.mtimeMs will be <= the stored mtime. We compare and
  // skip stale events so the echo can't clobber fresh in-memory state.
  // Stable refs so the watcher subscription below depends ONLY on workspacePath
  // and never tears down on re-render. Critical: `linkIndex.bump()` (called by
  // `applyParsedLinks` / `removeFile` / `renameFile`) triggers a re-render; if
  // this effect re-ran on that, the 80ms `refreshTimer` set inside the listener
  // would be cleared by cleanup before it could fire, and the tree would never
  // refresh for external .md adds. See the deep dive on the file-watcher
  // gotcha in CLAUDE.md → Development workflow.
  const linkIndexRefForWatcher = useSyncRef(linkIndex);
  const refreshTreeRef = useSyncRef(refreshTree);
  const renameTabsPathRef = useSyncRef(renameTabsPath);
  const showErrorRef = useSyncRef(showError);
  // Watcher reads activeFile via this ref so the subscription doesn't retear
  // every time the user switches tabs.
  const activeFileRef = useSyncRef(activeFile);
  const activeIsDraftRef = useSyncRef(activeIsDraft);

  useEffect(() => {
    if (!workspacePath) return undefined;
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshTreeRef.current();
      }, 80);
    };
    const unsub = window.api.onFsChanged((evt) => {
      const li = linkIndexRefForWatcher.current;
      if (evt.type === 'tree') {
        scheduleRefresh();
        return;
      }
      if (evt.type === 'unlink') {
        li.removeFile(evt.path);
        scheduleRefresh();
        return;
      }
      if (evt.type === 'rename') {
        // 1) Re-key the index so subsequent events for newPath are coherent.
        li.renameFile(evt.oldPath, evt.newPath);
        // 2) Refresh outgoing links if content changed during the move (rare).
        const stored = li.getMtime(evt.newPath);
        if (stored == null || evt.mtime > stored) {
          li.applyParsedLinks(evt.newPath, evt.outgoingLinks, evt.mtime);
        }
        // 3) Update any open tabs pointing at the old path.
        renameTabsPathRef.current(evt.oldPath, evt.newPath);
        // 4) Rewrite `[[OldName]]` references in other files. Idempotent — if
        //    the rename was in-app, these were already rewritten and the regex
        //    matches nothing on the watcher echo.
        const oldBaseName = evt.oldPath.split('/').pop().replace(/\.md$/i, '');
        const newBaseName = evt.newPath.split('/').pop().replace(/\.md$/i, '');
        if (oldBaseName !== newBaseName) {
          (async () => {
            try {
              await rewriteReferences({
                api: window.api,
                linkIndex: li.linkIndexRef.current,
                oldBaseName,
                newBaseName,
                selfPath: evt.newPath,
              });
              // Re-read self in case self-refs were rewritten on disk.
              try {
                const content = await window.api.readFile(evt.newPath);
                li.updateFile(evt.newPath, content);
              } catch { /* file may have moved again */ }
            } catch (err) {
              showErrorRef.current(err.message ?? String(err));
            }
          })();
        }
        scheduleRefresh();
        return;
      }
      // 'add' | 'change'
      const stored = li.getMtime(evt.path);
      const isFresh = stored == null || evt.mtime > stored;
      if (isFresh) {
        li.applyParsedLinks(evt.path, evt.outgoingLinks, evt.mtime);
      }
      // If the changed file is the open tab, reload the buffer from disk and
      // flash the added text green. Skipping the freshness check here means a
      // self-echo (renderer just wrote) is ignored — the stored mtime gate
      // above already filtered for that.
      if (
        evt.type === 'change' &&
        isFresh &&
        evt.path === activeFileRef.current &&
        !activeIsDraftRef.current
      ) {
        (async () => {
          try {
            const editor = editorRef.current;
            if (!editor) return;
            const oldText = editor.getText();
            const newText = await window.api.readFile(evt.path);
            if (oldText === newText) return;
            const viewState = editor.getViewState();
            editor.setContent(newText, viewState);
            const changes = diffWordsWithSpace(oldText, newText);
            const ranges = rangesAddedFromDiff(changes);
            if (ranges.length > 0) editor.flashRanges(ranges);
          } catch (err) {
            // File may have been deleted or moved before we could read it.
          }
        })();
      }
      if (evt.type === 'add') scheduleRefresh();
    });
    return () => {
      unsub();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [workspacePath]);

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
      setSystemPrefersDark(!!initialTheme.dark);
      setThemeMode(settings.appearance?.themeMode || THEME_MODES.SYSTEM);
      const hide = !!settings.appearance?.hideLineNumbers;
      setHideLineNumbers(hide);
      hideLineNumbersRef.current = hide;
      if (settings.dailyNote) {
        const dn = {
          format: settings.dailyNote.format || 'YYYY-MM-DD',
          folder: settings.dailyNote.folder ?? '',
        };
        setDailyNote(dn);
        dailyNoteRef.current = dn;
      }
      if (typeof settings.treeSortOrder === 'string') {
        setTreeSortOrder(settings.treeSortOrder);
        treeSortOrderRef.current = settings.treeSortOrder;
      }
      setWorkspaces(settings.workspaces || []);
      if (settings.codingAgent) {
        setCodingAgentSettings(settings.codingAgent);
        codingAgentSettingsRef.current = settings.codingAgent;
      }
      if (Array.isArray(settings.agentSecrets)) {
        setAgentSecrets(settings.agentSecrets);
        agentSecretsRef.current = settings.agentSecrets;
      }
      if (settings.transcription) {
        const t = {
          provider: settings.transcription.provider || 'assemblyai',
          apiKey: settings.transcription.apiKey || '',
        };
        setTranscription(t);
        transcriptionRef.current = t;
      }
      if (settings.sync) {
        const s = {
          pat: settings.sync.pat || '',
          pullIntervalSeconds:
            typeof settings.sync.pullIntervalSeconds === 'number' && settings.sync.pullIntervalSeconds > 0
              ? settings.sync.pullIntervalSeconds
              : 10,
        };
        setSync(s);
        syncRef.current = s;
      }
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
        viewModeRef.current = settings.viewMode;
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
            // Drop it from the list and persist.
            const next = (settings.workspaces || []).filter((w) => w.id !== lastId);
            setWorkspaces(next);
            await window.api.settings.write({
              workspaces: next,
              activeWorkspaceId: null,
              appearance: settings.appearance ?? { themeMode: THEME_MODES.SYSTEM },
            });
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
  const lastLoadRef = useRef({ tabId: null, path: null, isDark: null });
  useEffect(() => {
    if (!workspacePath) return;
    const editor = editorRef.current;
    if (!editor) return;
    const last = lastLoadRef.current;
    if (activeIsDraft || !activeFile) {
      editor.setContent('', null);
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
      } catch (err) {
        if (!cancelled) showError(err.message ?? String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [activeFile, activeIsDraft, activeTabId, workspacePath, isDark, tabsApi.viewStateByPath, showError]);

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
    await persistSettings({ workspaces, activeWorkspaceId, themeMode });
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
  const buildSendToAgentSnippet = useCallback((payload) => {
    if (!workspacePath || !payload?.relPath) return '';
    const { relPath } = payload;
    if (payload.hasSelection) {
      return (
        `I've copied the selected text below from ${relPath} at line ${payload.fromLine}, column ${payload.fromCol} to line ${payload.toLine}, column ${payload.toCol}:\n\n` +
        `~~~\n${payload.selection}\n~~~\n\n`
      );
    }
    return `My cursor is at line ${payload.line}, column ${payload.col} in ${relPath}.\n\n`;
  }, [workspacePath]);

  const applySendToAgent = useCallback((snippet, { append }) => {
    if (!chatSidebarOpenRef.current) {
      chatSidebarOpenRef.current = true;
      setChatSidebarOpen(true);
      persistChatSidebar();
    }
    // Either fires immediately (sidebar already open + ref attached) or once
    // the mount completes and the callback ref flips chatSidebarReady to true.
    setPendingComposerInjection({ text: snippet, append });
  }, [persistChatSidebar]);

  // Drain a pending composer injection once the sidebar's ref is attached.
  useEffect(() => {
    if (!chatSidebarReady || !pendingComposerInjection) return;
    const { text, append } = pendingComposerInjection;
    chatSidebarRef.current?.setComposerText(text, { append });
    requestAnimationFrame(() => chatSidebarRef.current?.focusComposer());
    setPendingComposerInjection(null);
  }, [chatSidebarReady, pendingComposerInjection]);

  const onSendToAgent = useCallback((info) => {
    if (!workspacePath || !activeFile) return;
    // Prefix the workspace-relative path with `[cwd]/` so the agent reads it
    // as "relative to your cwd" (which pi sets to the active workspace). Root
    // files still get the prefix so the snippet shape is uniform.
    let rel = activeFile;
    if (activeFile.startsWith(workspacePath)) {
      rel = activeFile.slice(workspacePath.length).replace(/^\/+/, '');
    }
    const relPath = `[cwd]/${rel}`;
    const snippet = buildSendToAgentSnippet({ ...info, relPath });
    if (!snippet) return;
    // Sidebar closed → composer guaranteed empty (component is unmounted), no
    // need to prompt. Sidebar open → ask before clobbering existing text.
    if (chatSidebarOpenRef.current) {
      const existing = chatSidebarRef.current?.getComposerText?.() ?? '';
      if (existing.trim()) {
        setSendToAgentPending(snippet);
        return;
      }
    }
    applySendToAgent(snippet, { append: false });
  }, [workspacePath, activeFile, buildSendToAgentSnippet, applySendToAgent]);

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
      }}
    >
      <ThinSidebar
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
        onOpenJournal={() => openJournal()}
        onJournalContextMenu={(x, y) => setJournalPickerAnchor({ x, y })}
        onToggleGraph={onToggleGraph}
        graphMode={graphMode}
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
          onToggleBookmarkFilter={() => setBookmarkFilterActive((v) => !v)}
          bookmarks={bookmarks}
          workspacePath={workspacePath}
          onPickBookmark={async (absPath) => {
            if (graphMode) setGraphMode(false);
            await openInActiveTab(absPath);
          }}
          disabled={!workspacePath}
        />
        <div className="tree-wrap">
          {sortedTree.length > 0 ? (
            <FileTree
              ref={fileTreeRef}
              data={sortedTree}
              onSelect={onSelect}
              onRename={onTreeRename}
              onFileAction={onFileActionWithBookmarks}
              onFolderAction={onFolderAction}
              onMoveItems={onMoveItems}
              disableDrop={disableDrop}
              bookmarkedPaths={bookmarks}
            />
          ) : (
            <div className="empty">
              {!workspacePath
                ? 'No workspace open'
                : bookmarkFilterActive
                  ? 'No bookmarks'
                  : 'Empty workspace'}
            </div>
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
            <div className="editor-scroll">
              <div className={activeTab ? '' : 'editor-zone-hidden'}>
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
              <div className={activeTab ? '' : 'editor-zone-hidden'}>
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
              {activeTab ? (
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
                words={editorStats.words}
                chars={editorStats.chars}
                viewMode={viewMode}
                onToggleViewMode={onToggleViewMode}
                saveState={saveState}
                canUndo={editorHistory.canUndo}
                canRedo={editorHistory.canRedo}
                onUndo={onUndo}
                onRedo={onRedo}
                syncStatus={syncStatus}
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
        open={!!bulkDeleteCandidates}
        title="Delete files"
        message={
          bulkDeleteCandidates
            ? `Move ${bulkDeleteCandidates.length} files to the Trash? This cannot be undone from inside the app.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmBulkDelete}
        onClose={cancelBulkDelete}
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
          dailyNote={dailyNote}
          onDailyNoteChange={onDailyNoteChange}
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
          saveStatus={saveStatus}
        />
      )}
    </div>
  );
}
