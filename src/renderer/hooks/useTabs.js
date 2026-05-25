import { useCallback, useRef, useState } from 'react';

let nextTabId = 1;
const makeTabId = () => `t${nextTabId++}`;

/**
 * Owns: tabs, activeTabId, viewStateByPath, and per-tab navigation history.
 *
 * Tab shape: { id, path, isDraft, history: string[], historyIndex: number }.
 * `history`/`historyIndex` model browser-style back/forward inside a single tab.
 * Drafts have history: [] / historyIndex: -1; back/forward are disabled.
 *
 * Does NOT load content into the editor — that's done by App via an effect that watches
 * activeFile and writes via the editor's imperative `setContent` API. This keeps the
 * load timing decoupled from React state-update ordering.
 *
 * Inputs:
 *   editorRef         — ref to the imperative Editor (for capturing current view state on leave)
 *   writeNow          — flushes any pending debounced save
 *   onAfterSwitch?    — optional, fires after any tab op completes (e.g., turn off graph mode)
 */
export function useTabs({ editorRef, writeNow, onAfterSwitch }) {
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const viewStateByPath = useRef(new Map());

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  const activeFile = activeTab?.path ?? null;
  const activeIsDraft = !!activeTab?.isDraft;
  const canGoBack = !!activeTab && activeTab.historyIndex > 0;
  const canGoForward = !!activeTab && activeTab.historyIndex < activeTab.history.length - 1;

  // Capture the editor's view state for the currently-active file BEFORE we change tabs.
  const captureCurrentViewState = useCallback(() => {
    if (!activeFile) return;
    const editor = editorRef.current;
    if (!editor) return;
    const state = editor.getViewState();
    if (state) viewStateByPath.current.set(activeFile, state);
  }, [activeFile, editorRef]);

  const renameTabsPath = useCallback((oldPath, newPath) => {
    setTabs((prev) => prev.map((t) => {
      const touchesPath = t.path === oldPath;
      const touchesHistory = t.history.includes(oldPath);
      if (!touchesPath && !touchesHistory) return t;
      return {
        ...t,
        path: touchesPath ? newPath : t.path,
        isDraft: touchesPath ? false : t.isDraft,
        history: touchesHistory ? t.history.map((p) => (p === oldPath ? newPath : p)) : t.history,
      };
    }));
    const vs = viewStateByPath.current.get(oldPath);
    if (vs !== undefined) {
      viewStateByPath.current.set(newPath, vs);
      viewStateByPath.current.delete(oldPath);
    }
  }, []);

  const openInActiveTab = useCallback(async (filePath) => {
    await writeNow();
    captureCurrentViewState();
    setTabs((prev) => {
      if (prev.length === 0) {
        const id = makeTabId();
        setActiveTabId(id);
        return [{ id, path: filePath, isDraft: false, history: [filePath], historyIndex: 0 }];
      }
      return prev.map((t) => {
        if (t.id !== activeTabId) return t;
        // Truncate forward history, then push (skip if it would duplicate the current entry).
        const truncated = t.history.slice(0, t.historyIndex + 1);
        const top = truncated[truncated.length - 1];
        const nextHistory = top === filePath ? truncated : [...truncated, filePath];
        return {
          ...t,
          path: filePath,
          isDraft: false,
          history: nextHistory,
          historyIndex: nextHistory.length - 1,
        };
      });
    });
    onAfterSwitch?.();
  }, [writeNow, activeTabId, captureCurrentViewState, onAfterSwitch]);

  const openInNewTab = useCallback(async (filePath) => {
    await writeNow();
    captureCurrentViewState();
    const id = makeTabId();
    setTabs((prev) => [...prev, { id, path: filePath, isDraft: false, history: [filePath], historyIndex: 0 }]);
    setActiveTabId(id);
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  const addDraftTab = useCallback(async () => {
    await writeNow();
    captureCurrentViewState();
    const id = makeTabId();
    setTabs((prev) => [...prev, { id, path: null, isDraft: true, history: [], historyIndex: -1 }]);
    setActiveTabId(id);
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  const switchTab = useCallback(async (id) => {
    if (id === activeTabId) return;
    await writeNow();
    captureCurrentViewState();
    setActiveTabId(id);
    onAfterSwitch?.();
  }, [activeTabId, writeNow, captureCurrentViewState, onAfterSwitch]);

  const closeTab = useCallback(async (id) => {
    await writeNow();
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeTabId) {
        if (next.length === 0) {
          setActiveTabId(null);
        } else {
          const newActive = next[Math.max(0, idx - 1)];
          setActiveTabId(newActive.id);
        }
      }
      return next;
    });
  }, [activeTabId, writeNow]);

  const closeTabsForPath = useCallback((filePath) => {
    setTabs((prev) => {
      const activeWasClosed = prev.find((t) => t.id === activeTabId)?.path === filePath;
      const next = [];
      for (const t of prev) {
        if (t.path === filePath) continue;
        if (!t.history.includes(filePath)) {
          next.push(t);
          continue;
        }
        // Purge deleted path from this tab's history; shift the index for each removed entry at or before it.
        const nextHistory = [];
        let nextIndex = t.historyIndex;
        for (let i = 0; i < t.history.length; i++) {
          if (t.history[i] === filePath) {
            if (i <= t.historyIndex) nextIndex--;
          } else {
            nextHistory.push(t.history[i]);
          }
        }
        next.push({
          ...t,
          history: nextHistory,
          historyIndex: Math.max(-1, Math.min(nextIndex, nextHistory.length - 1)),
        });
      }
      if (next.length === prev.length) return prev;
      if (activeWasClosed) {
        setActiveTabId(next.length === 0 ? null : next[0].id);
      }
      return next;
    });
    viewStateByPath.current.delete(filePath);
  }, [activeTabId]);

  // Close every tab whose current path is inside the given folder; purge folder paths from history too.
  const closeTabsUnderPath = useCallback((folderPath) => {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    const inFolder = (p) => typeof p === 'string' && p.startsWith(prefix);
    setTabs((prev) => {
      const activeTab = prev.find((t) => t.id === activeTabId);
      const activeWasClosed = activeTab && inFolder(activeTab.path);
      const next = [];
      for (const t of prev) {
        if (inFolder(t.path)) continue;
        const hasFolderInHistory = t.history.some(inFolder);
        if (!hasFolderInHistory) { next.push(t); continue; }
        const nextHistory = [];
        let nextIndex = t.historyIndex;
        for (let i = 0; i < t.history.length; i++) {
          if (inFolder(t.history[i])) {
            if (i <= t.historyIndex) nextIndex--;
          } else {
            nextHistory.push(t.history[i]);
          }
        }
        next.push({
          ...t,
          history: nextHistory,
          historyIndex: Math.max(-1, Math.min(nextIndex, nextHistory.length - 1)),
        });
      }
      if (next.length === prev.length && !next.some((t, i) => t !== prev[i])) return prev;
      if (activeWasClosed) {
        setActiveTabId(next.length === 0 ? null : next[0].id);
      }
      // Drop view-state entries for all removed paths.
      for (const t of prev) {
        if (inFolder(t.path)) viewStateByPath.current.delete(t.path);
      }
      return next;
    });
  }, [activeTabId]);

  const resetTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    viewStateByPath.current.clear();
  }, []);

  const goBack = useCallback(async (tabId) => {
    await writeNow();
    captureCurrentViewState();
    setTabs((prev) => prev.map((t) => {
      if (t.id !== tabId || t.historyIndex <= 0) return t;
      const nextIndex = t.historyIndex - 1;
      return { ...t, path: t.history[nextIndex], historyIndex: nextIndex };
    }));
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  const goForward = useCallback(async (tabId) => {
    await writeNow();
    captureCurrentViewState();
    setTabs((prev) => prev.map((t) => {
      if (t.id !== tabId || t.historyIndex >= t.history.length - 1) return t;
      const nextIndex = t.historyIndex + 1;
      return { ...t, path: t.history[nextIndex], historyIndex: nextIndex };
    }));
    onAfterSwitch?.();
  }, [writeNow, captureCurrentViewState, onAfterSwitch]);

  /**
   * Promote a draft tab to a real file on disk. Returns the new path.
   * Concurrency-guarded so two rapid edits don't race to create two files.
   */
  const promotionInFlight = useRef(new Map());
  const promoteDraft = useCallback(async (tabId, vaultPath, { name, initialContent = '' }) => {
    if (!vaultPath) throw new Error('No active workspace');
    const existing = promotionInFlight.current.get(tabId);
    if (existing) return existing;
    const work = (async () => {
      const cleanName = (name || 'Untitled').replace(/\.md$/i, '').trim() || 'Untitled';
      const newPath = await window.api.createFile(vaultPath, `${cleanName}.md`, initialContent);
      setTabs((prev) => prev.map((t) => (
        t.id === tabId
          ? { ...t, path: newPath, isDraft: false, history: [newPath], historyIndex: 0 }
          : t
      )));
      return newPath;
    })();
    promotionInFlight.current.set(tabId, work);
    try {
      return await work;
    } finally {
      promotionInFlight.current.delete(tabId);
    }
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab,
    activeFile,
    activeIsDraft,
    canGoBack,
    canGoForward,
    setActiveTabId,
    setTabs,
    openInActiveTab,
    openInNewTab,
    addDraftTab,
    switchTab,
    closeTab,
    closeTabsForPath,
    closeTabsUnderPath,
    renameTabsPath,
    captureCurrentViewState,
    resetTabs,
    promoteDraft,
    goBack,
    goForward,
    viewStateByPath,
  };
}
