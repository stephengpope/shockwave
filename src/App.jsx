import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileTree from './FileTree.jsx';
import Editor from './Editor.jsx';
import BacklinksPanel from './BacklinksPanel.jsx';
import GraphView from './GraphView.jsx';
import TabStrip from './TabStrip.jsx';
import EditorTitle from './EditorTitle.jsx';
import ThinSidebar from './ThinSidebar.jsx';
import WorkspaceSelector from './WorkspaceSelector.jsx';
import SettingsModal from './SettingsModal.jsx';
import { prettyName } from './linkIndex.js';
import { SETTINGS_SECTIONS, THEME_MODES, APP_NAME } from './constants.js';
import { useLinkIndex } from './hooks/useLinkIndex.js';
import { useTabs } from './hooks/useTabs.js';
import { useFileOps } from './hooks/useFileOps.js';

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
  const [graphMode, setGraphMode] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState(SETTINGS_SECTIONS.WORKSPACES);
  const [themeMode, setThemeMode] = useState(THEME_MODES.SYSTEM);
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

  // ---- save lifecycle (stays in App, crosses concerns) ----
  const dirtyPathRef = useRef(null);
  const saveTimerRef = useRef(null);

  const linkIndex = useLinkIndex(tree);

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

  // ---- tabs (drafts live here) ----
  const onAfterSwitch = useCallback(() => {
    if (graphMode) setGraphMode(false);
  }, [graphMode]);

  const tabsApi = useTabs({ editorRef, writeNow, onAfterSwitch });
  const { activeFile, activeIsDraft, activeTab, openInActiveTab, openInNewTab, addDraftTab,
          switchTab, closeTab, closeTabsForPath, renameTabsPath, resetTabs,
          promoteDraft, tabs, activeTabId } = tabsApi;

  // ---- on editor change: schedule debounced save; promote drafts ----
  const onEditorChange = useCallback(() => {
    if (!activeTab) return;
    if (activeTab.isDraft) {
      // Promote then schedule a save against the new path.
      (async () => {
        try {
          const editor = editorRef.current;
          const currentText = editor?.getText() ?? '';
          const newPath = await promoteDraft(activeTab.id, workspacePath, {
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
  }, [activeTab, activeFile, writeNow, promoteDraft, workspacePath, titleDraft, linkIndex, showError]);

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
  const onSelect = useCallback(async (nodes) => {
    const node = nodes[0];
    if (!node || node.children) return;
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
    });
  }, []);

  const loadWorkspace = useCallback(async (workspace) => {
    await writeNow();
    resetTabs();
    setTree([]);
    setGraphMode(false);
    const [treeData, files] = await Promise.all([
      window.api.readTree(workspace.path),
      window.api.readAllMarkdown(workspace.path),
    ]);
    setTree(treeData);
    linkIndex.rebuild(files);
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
    }
    await persistSettings({ workspaces: next, activeWorkspaceId: newActive, themeMode });
  }, [workspaces, activeWorkspaceId, persistSettings, themeMode, resetTabs]);

  const onThemeModeChange = useCallback(async (mode) => {
    setThemeMode(mode);
    await persistSettings({ workspaces, activeWorkspaceId, themeMode: mode });
  }, [persistSettings, workspaces, activeWorkspaceId]);

  // ---- title commit (rename existing or promote draft) ----
  const onTitleCommit = useCallback(async (newName) => {
    if (!activeTab) return;
    if (activeTab.isDraft) {
      try {
        const editor = editorRef.current;
        const text = editor?.getText() ?? '';
        const newPath = await promoteDraft(activeTab.id, workspacePath, {
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
  }, [activeTab, activeFile, workspacePath, linkIndex, promoteDraft, fileOps, showError]);

  // ---- graph toggle ----
  const onToggleGraph = useCallback(async () => {
    await writeNow();
    setGraphMode((g) => !g);
  }, [writeNow]);

  // ---- new note (thin sidebar) ----
  const onNewNote = useCallback(async () => {
    if (!workspacePath) return;
    await addDraftTab();
  }, [workspacePath, addDraftTab]);

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
  useEffect(() => {
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
        onNewNote={onNewNote}
        onToggleGraph={onToggleGraph}
        graphMode={graphMode}
        disabled={!workspacePath}
      />

      <aside className="sidebar">
        <div className="tree-wrap">
          {tree.length > 0 ? (
            <FileTree
              data={tree}
              onSelect={onSelect}
              onRename={({ id, name }) => fileOps.performRename(id, name)}
              onFileAction={fileOps.onFileAction}
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
            onOpenFile={async (id) => {
              setGraphMode(false);
              await openInActiveTab(id);
            }}
          />
        ) : workspacePath ? (
          <>
            <div className={activeTab ? '' : 'editor-zone-hidden'}>
              <EditorTitle
                value={titleDraft}
                onChange={setTitleDraft}
                onCommit={onTitleCommit}
                conflict={!!titleConflict}
              />
              {titleConflict && (
                <div className="title-conflict">
                  There's already a file with the same name
                </div>
              )}
            </div>
            <div className={activeTab ? '' : 'editor-zone-hidden'}>
              <Editor
                ref={editorRef}
                onLinkClick={fileOps.onLinkClick}
                onChange={onEditorChange}
                getPageIndexRef={linkIndex.pageIndexRef}
                getVaultPathRef={workspacePathRef}
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
                <button className="create-note-btn" onClick={onNewNote}>
                  + Create new note
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
        />
      )}
    </div>
  );
}
