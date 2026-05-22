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
import ErrorDialog from './ErrorDialog.jsx';
import InlineAiModal from './InlineAiModal.jsx';
import { prettyName } from './linkIndex.js';
import { SETTINGS_SECTIONS, THEME_MODES, APP_NAME, FOLDER_ACTIONS, AI_PROVIDERS, AI_ACTIONS } from './constants.js';
import { useLinkIndex } from './hooks/useLinkIndex.js';
import { useTabs } from './hooks/useTabs.js';
import { useFileOps } from './hooks/useFileOps.js';
import { useInlineAi } from './hooks/useInlineAi.js';

const SAVE_DEBOUNCE_MS = 500;

function genWorkspaceId() {
  return 'ws_' + Math.random().toString(36).slice(2, 10);
}

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

function flattenAll(nodes, out = []) {
  for (const n of nodes) {
    if (n.children) flattenAll(n.children, out);
    out.push(n);
  }
  return out;
}

function findNameConflict({ tree, currentPath, newName, workspacePath }) {
  const clean = newName.replace(/\.md$/i, '').toLowerCase().trim();
  if (!clean) return null;
  const targetDir = currentPath ? dirOf(currentPath) : workspacePath;
  for (const node of flattenAll(tree)) {
    if (node.children) continue;
    if (node.id === currentPath) continue;
    if (!node.name.toLowerCase().endsWith('.md')) continue;
    if (dirOf(node.id) !== targetDir) continue;
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
  // When set, renders <UrlPromptModal>. The function is the awaiting promise's resolver.
  const [urlPromptResolve, setUrlPromptResolve] = useState(null);
  const [themeMode, setThemeMode] = useState(THEME_MODES.SYSTEM);
  const [aiSettings, setAiSettings] = useState({
    provider: AI_PROVIDERS.ANTHROPIC,
    model: 'claude-sonnet-4-5',
    apiKey: '',
    includeContextByDefault: false,
  });
  const [aiError, setAiError] = useState(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [bootDone, setBootDone] = useState(false);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;
  const workspacePath = activeWorkspace?.path ?? null;
  const workspacePathRef = useRef(workspacePath);
  useEffect(() => { workspacePathRef.current = workspacePath; }, [workspacePath]);

  // ---- app title ----
  useEffect(() => {
    document.title = APP_NAME;
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
  const showError = useCallback((msg) => {
    setErrorMessage(msg);
    setTimeout(() => setErrorMessage(null), 4000);
  }, []);

  // ---- editor ref ----
  const editorRef = useRef(null);
  // ---- file tree ref (imperative API: editNode(id)) ----
  const fileTreeRef = useRef(null);

  // ---- save lifecycle (stays in App, crosses concerns) ----
  const dirtyPathRef = useRef(null);
  const saveTimerRef = useRef(null);

  const linkIndex = useLinkIndex(tree);

  // ---- Inline AI (Ask / Rewrite) ----
  // The hook owns streaming, the editor lock, and cancellation. The modal
  // gathers the user's prompt before we dispatch.
  //
  // writeNow saves; it does NOT cancel the AI stream — the debounced save
  // fires every ~500ms during streaming and we don't want to kill the stream.
  // flushAndCancel is the variant used by paths that change the active file
  // (tab switch, workspace switch, beforeunload), where the stream MUST stop.
  const inlineAiRef = useRef(null);
  const inlineAi = useInlineAi({ editorRef, onError: setAiError });
  inlineAiRef.current = inlineAi;

  // The modal is open whenever this is non-null. It holds everything we
  // captured from the editor at the moment of right-click, since focus will
  // move into the modal and we can't read the selection again later.
  const [inlineAiRequest, setInlineAiRequest] = useState(null);

  const onInlineAiTrigger = useCallback(({ from, to, selection, contextBefore, contextAfter }) => {
    const hasSelection = from !== to;
    setInlineAiRequest({
      action: hasSelection ? AI_ACTIONS.REWRITE : AI_ACTIONS.INSERT,
      from,
      to,
      selection,
      contextBefore,
      contextAfter,
    });
  }, []);

  const onInlineAiCancel = useCallback(() => {
    setInlineAiRequest(null);
  }, []);

  const onInlineAiSubmit = useCallback(({ prompt, includeContext }) => {
    if (!inlineAiRequest) return;
    const { action, from, to, selection, contextBefore, contextAfter } = inlineAiRequest;
    const params = action === AI_ACTIONS.REWRITE
      ? { userPrompt: prompt, selection, contextBefore, contextAfter, includeContext }
      : { userPrompt: prompt, contextBefore, contextAfter, includeContext };
    inlineAi.run({ action, params, range: { from, to } });
    setInlineAiRequest(null);
    editorRef.current?.focus();
  }, [inlineAi, inlineAiRequest]);

  const writeNow = useCallback(async () => {
    const path = dirtyPathRef.current;
    if (!path) return;
    dirtyPathRef.current = null;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.getText();
    await window.api.writeFile(path, text);
    linkIndex.updateFile(path, text);
  }, [linkIndex]);

  const flushAndCancel = useCallback(async () => {
    inlineAiRef.current?.cancel();
    setInlineAiRequest(null);
    await writeNow();
  }, [writeNow]);

  // ---- tabs (drafts live here) ----
  const onAfterSwitch = useCallback(() => {
    if (graphMode) setGraphMode(false);
  }, [graphMode]);

  const tabsApi = useTabs({ editorRef, writeNow: flushAndCancel, onAfterSwitch });
  const { activeFile, activeIsDraft, activeTab, openInActiveTab, openInNewTab, addDraftTab,
          switchTab, closeTab, closeTabsForPath, closeTabsUnderPath, renameTabsPath, resetTabs,
          promoteDraft, tabs, activeTabId, goBack, goForward, canGoBack, canGoForward } = tabsApi;

  const onBack = useCallback(() => { if (activeTabId) goBack(activeTabId); }, [activeTabId, goBack]);
  const onForward = useCallback(() => { if (activeTabId) goForward(activeTabId); }, [activeTabId, goForward]);

  // Where a new file should be created when promoting a draft.
  // Priority: explicitly selected folder → dir of the active file → vault root.
  const newFileDir = useCallback(() => {
    if (selectedFolderPath) return selectedFolderPath;
    if (activeFile) return dirOf(activeFile);
    return workspacePath;
  }, [selectedFolderPath, activeFile, workspacePath]);

  // ---- on editor change: schedule debounced save; promote drafts ----
  const onEditorChange = useCallback(() => {
    if (!activeTab) return;
    if (activeTab.isDraft) {
      // Promote then schedule a save against the new path.
      (async () => {
        try {
          const editor = editorRef.current;
          const currentText = editor?.getText() ?? '';
          const newPath = await promoteDraft(activeTab.id, newFileDir(), {
            name: titleDraft || 'Untitled',
            initialContent: '',
          });
          linkIndex.updateFile(newPath, currentText);
          dirtyPathRef.current = newPath;
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => writeNow(), SAVE_DEBOUNCE_MS);
        } catch (err) {
          showError(err.message ?? String(err));
        }
      })();
      return;
    }
    dirtyPathRef.current = activeFile;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => writeNow(), SAVE_DEBOUNCE_MS);
  }, [activeTab, activeFile, writeNow, promoteDraft, newFileDir, titleDraft, linkIndex, showError]);

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
  // Files clear it and open in the active tab.
  const onSelect = useCallback(async (nodes) => {
    const node = nodes[0];
    if (!node) return;
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
  const persistSettings = useCallback(async (next) => {
    await window.api.settings.write({
      workspaces: next.workspaces,
      activeWorkspaceId: next.activeWorkspaceId,
      appearance: { themeMode: next.themeMode },
      ai: next.ai,
    });
  }, []);

  const loadWorkspace = useCallback(async (workspace) => {
    await flushAndCancel();
    await window.api.watchStop();
    resetTabs();
    setTree([]);
    setSelectedFolderPath(null);
    setGraphMode(false);
    const [treeData, files] = await Promise.all([
      window.api.readTree(workspace.path),
      window.api.readAllMarkdown(workspace.path),
    ]);
    setTree(treeData);
    linkIndex.rebuild(files);
    await window.api.watchStart(workspace.path);
  }, [flushAndCancel, resetTabs, linkIndex]);

  const switchWorkspace = useCallback(async (id) => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    const exists = await window.api.pathExists(ws.path);
    if (!exists) {
      const removed = workspaces.filter((w) => w.id !== id);
      setWorkspaces(removed);
      setActiveWorkspaceId(null);
      await persistSettings({ workspaces: removed, activeWorkspaceId: null, themeMode, ai: aiSettings });
      showError(`Workspace "${ws.name}" no longer exists.`);
      return;
    }
    setActiveWorkspaceId(id);
    await persistSettings({ workspaces, activeWorkspaceId: id, themeMode, ai: aiSettings });
    await loadWorkspace(ws);
  }, [workspaces, persistSettings, themeMode, aiSettings, loadWorkspace, showError]);

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
    await persistSettings({ workspaces: next, activeWorkspaceId: ws.id, themeMode, ai: aiSettings });
    await loadWorkspace(ws);
  }, [workspaces, persistSettings, themeMode, aiSettings, loadWorkspace, switchWorkspace]);

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
    await persistSettings({ workspaces: next, activeWorkspaceId: newActive, themeMode, ai: aiSettings });
  }, [workspaces, activeWorkspaceId, persistSettings, themeMode, aiSettings, resetTabs]);

  const onThemeModeChange = useCallback(async (mode) => {
    setThemeMode(mode);
    await persistSettings({ workspaces, activeWorkspaceId, themeMode: mode, ai: aiSettings });
  }, [persistSettings, workspaces, activeWorkspaceId, aiSettings]);

  const onAiChange = useCallback(async (next) => {
    setAiSettings(next);
    await persistSettings({ workspaces, activeWorkspaceId, themeMode, ai: next });
  }, [persistSettings, workspaces, activeWorkspaceId, themeMode]);

  // ---- title commit (rename existing or promote draft) ----
  const onTitleCommit = useCallback(async (newName) => {
    if (!activeTab) return;
    if (activeTab.isDraft) {
      try {
        const editor = editorRef.current;
        const text = editor?.getText() ?? '';
        const newPath = await promoteDraft(activeTab.id, newFileDir(), {
          name: newName,
          initialContent: text,
        });
        linkIndex.updateFile(newPath, text);
        await fileOps.treeAndIndexChanged();
      } catch (err) {
        showError(err.message ?? String(err));
      }
      return;
    }
    if (!activeFile) return;
    await fileOps.performRename(activeFile, newName);
  }, [activeTab, activeFile, newFileDir, linkIndex, promoteDraft, fileOps, showError]);

  // ---- graph toggle ----
  const onToggleGraph = useCallback(async () => {
    await flushAndCancel();
    setGraphMode((g) => !g);
  }, [flushAndCancel]);

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
        const outgoing = linkIndex.linkIndexRef.current.getOutgoingMap();
        const affected = [];
        for (const p of outgoing.keys()) {
          if (p.startsWith(prefix)) affected.push(p);
        }
        for (const p of affected) linkIndex.linkIndexRef.current.removeFile(p);
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
        const outgoing = linkIndex.linkIndexRef.current.getOutgoingMap();
        const insideSrc = [];
        const srcAsDir = src.endsWith('/') ? src : src + '/';
        for (const p of outgoing.keys()) {
          if (p === src || p.startsWith(srcAsDir)) insideSrc.push(p);
        }

        const newPath = await window.api.moveItem(src, destDir);
        const newAsDir = newPath.endsWith('/') ? newPath : newPath + '/';

        // For folders: the folder rename causes every nested .md path to change.
        // For files: insideSrc contains just the file itself (if it was in the index).
        for (const oldP of insideSrc) {
          const suffix = oldP === src ? '' : oldP.slice(srcAsDir.length);
          const newP = suffix ? (newAsDir + suffix) : newPath;
          linkIndex.linkIndexRef.current.renameFile(oldP, newP);
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
  const onTreeRename = useCallback(async ({ id, name }) => {
    const isFolder = !id.toLowerCase().endsWith('.md');
    if (isFolder) {
      try {
        await window.api.renameFolder(id, name);
        await fileOps.treeAndIndexChanged();
      } catch (err) {
        showError(err.message ?? String(err));
      }
      return;
    }
    return fileOps.performRename(id, name);
  }, [fileOps, showError]);

  // ---- URL prompt (used by editor "Add external link") ----
  const requestUrl = useCallback(() => {
    return new Promise((resolve) => {
      // Wrap the resolver so React's setState doesn't try to invoke it.
      setUrlPromptResolve(() => resolve);
    });
  }, []);

  const handleUrlSubmit = useCallback((url) => {
    setUrlPromptResolve((prev) => { prev?.(url); return null; });
  }, []);

  const handleUrlCancel = useCallback(() => {
    setUrlPromptResolve((prev) => { prev?.(null); return null; });
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
    const flush = () => { flushAndCancel(); };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [flushAndCancel]);

  // ---- external file change subscription ----
  //
  // Watcher events fall into three buckets:
  //   - {type:'add'|'change', path, mtime, outgoingLinks}  — .md file appeared or modified
  //   - {type:'unlink', path}                              — .md file removed
  //   - {type:'tree'}                                       — folder change / non-.md (tree refresh only)
  //
  // Self-echo guard: every renderer-initiated write triggers a watcher event ~350ms
  // later. The renderer has already called linkIndex.updateFile with a Date.now()
  // mtime, so the echo's stat.mtimeMs will be <= the stored mtime. We compare and
  // skip stale events so the echo can't clobber fresh in-memory state.
  useEffect(() => {
    if (!workspacePath) return undefined;
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshTree();
      }, 80);
    };
    const unsub = window.api.onFsChanged((evt) => {
      if (evt.type === 'tree') {
        scheduleRefresh();
        return;
      }
      if (evt.type === 'unlink') {
        linkIndex.removeFile(evt.path);
        scheduleRefresh();
        return;
      }
      // 'add' | 'change'
      const stored = linkIndex.linkIndexRef.current.getMtime(evt.path);
      if (stored == null || evt.mtime > stored) {
        linkIndex.applyParsedLinks(evt.path, evt.outgoingLinks, evt.mtime);
      }
      if (evt.type === 'add') scheduleRefresh();
    });
    return () => {
      unsub();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
    // linkIndex methods are stable useCallbacks; linkIndexRef is a stable useRef.
  }, [workspacePath, refreshTree, linkIndex.applyParsedLinks, linkIndex.removeFile, linkIndex.linkIndexRef]);

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
      setWorkspaces(settings.workspaces || []);
      if (settings.ai) setAiSettings(settings.ai);

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
              ai: settings.ai,
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

  // ---- effect: load the active file's content into the editor whenever activeFile or draft state changes ----
  useEffect(() => {
    if (!workspacePath) return;
    const editor = editorRef.current;
    if (!editor) return;
    if (activeIsDraft || !activeFile) {
      editor.setContent('', null);
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
      } catch (err) {
        if (!cancelled) showError(err.message ?? String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [activeFile, activeIsDraft, workspacePath, isDark, tabsApi.viewStateByPath, showError]);

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
      workspacePath,
    });
  }, [titleDraft, tree, workspacePath, activeFile, activeIsDraft, titleFromActive]);

  return (
    <div className="app">
      <ThinSidebar
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
        onToggleGraph={onToggleGraph}
        graphMode={graphMode}
        disabled={!workspacePath}
      />

      <aside className="sidebar">
        <div className="tree-wrap">
          {tree.length > 0 ? (
            <FileTree
              ref={fileTreeRef}
              data={tree}
              onSelect={onSelect}
              onRename={onTreeRename}
              onFileAction={fileOps.onFileAction}
              onFolderAction={onFolderAction}
              onMoveItems={onMoveItems}
              disableDrop={disableDrop}
            />
          ) : (
            <div className="empty">
              {workspacePath ? 'Empty workspace' : 'No workspace open'}
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
            outgoingByFile={linkIndex.linkIndexRef.current.getOutgoingMap()}
            linkIndexVersion={linkIndex.version}
            dark={isDark}
            onOpenFile={async (id) => {
              setGraphMode(false);
              await openInActiveTab(id);
            }}
          />
        ) : workspacePath ? (
          <>
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
                onRequestUrl={requestUrl}
                onAskAgent={onInlineAiTrigger}
                dark={isDark}
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
          </>
        ) : (
          <div className="empty centered">
            {bootDone ? `Welcome to ${APP_NAME}. Add a workspace from the gear icon to get started.` : ''}
          </div>
        )}
      </main>

      {urlPromptResolve && (
        <UrlPromptModal onSubmit={handleUrlSubmit} onCancel={handleUrlCancel} />
      )}

      <ErrorDialog
        open={!!aiError}
        message={aiError}
        title="AI request failed"
        onClose={() => setAiError(null)}
      />

      <InlineAiModal
        open={!!inlineAiRequest}
        action={inlineAiRequest?.action}
        defaultIncludeContext={!!aiSettings.includeContextByDefault}
        onSubmit={onInlineAiSubmit}
        onCancel={onInlineAiCancel}
      />

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
          ai={aiSettings}
          onAiChange={onAiChange}
        />
      )}
    </div>
  );
}
