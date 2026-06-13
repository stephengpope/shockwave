import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { diffWordsWithSpace } from 'diff';
import { useSyncRef } from './useSyncRef';
import { rangesAddedFromDiff } from '../diffFlash.js';
import { rewriteReferences } from '../renameOps.js';
import { bookmarkKey } from './useBookmarks';
import { isDrawing } from '../MediaView';
import type { DrawingViewHandle } from '../DrawingView';
import type { FsChangedEvent } from '../../shared/api';

// Minimal shapes of the untyped JS collaborators this hook drives.
interface LinkIndexApi {
  removeFile: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => void;
  getMtime: (path: string) => number | null;
  applyParsedLinks: (path: string, links: unknown, mtime: number) => void;
  updateFile: (path: string, content: string) => void;
  linkIndexRef: { current: unknown };
}
interface EditorHandle {
  getText: () => string;
  getViewState: () => unknown;
  setContent: (text: string, viewState: unknown) => void;
  flashRanges: (ranges: unknown) => void;
}

interface UseFsWatcherOpts {
  workspacePath: string | null;
  linkIndex: LinkIndexApi;
  refreshTree: () => unknown;
  renameTabsPath: (oldPath: string, newPath: string) => void;
  showError: (msg: string) => void;
  activeFile: string | null;
  activeIsDraft: boolean;
  editorRef: MutableRefObject<EditorHandle | null>;
  renameBookmarkName: (oldKey: string, newKey: string) => boolean;
  removeBookmarkName: (key: string) => boolean;
  persistBookmarks: () => void;
  // Drawing reload: the live canvas (when the active tab is a `.excalidraw`)
  // and the per-path mtime store that guards the self-echo (drawings aren't in
  // the link index, so they need their own store — same role as li.getMtime).
  drawingViewRef: MutableRefObject<DrawingViewHandle | null>;
  drawingMtimesRef: MutableRefObject<Map<string, number>>;
}

// Subscribes to main's `fs:changed` push events and reconciles the renderer's
// link index, open tabs, bookmark set, and (for the active file) the editor
// buffer. CRITICAL DISCIPLINE: subscribe ONCE per workspacePath and read every
// dependency via a ref — never add a value to the effect's dep array, or the
// listener re-tears every render and races the 80ms refresh timer set inside
// it (see renderer CLAUDE.md → "fs:changed listener discipline").
export function useFsWatcher({
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
}: UseFsWatcherOpts) {
  const linkIndexRefForWatcher = useSyncRef(linkIndex);
  const refreshTreeRef = useSyncRef(refreshTree);
  const renameTabsPathRef = useSyncRef(renameTabsPath);
  const showErrorRef = useSyncRef(showError);
  // Read activeFile via ref so the subscription doesn't re-tear on tab switch.
  const activeFileRef = useSyncRef(activeFile);
  const activeIsDraftRef = useSyncRef(activeIsDraft);
  // Bookmark sync on external/echoed rename + delete, via refs to stay stable.
  // Bookmarks are keyed by .md basename: a move keeps the name (no-op), only a
  // true rename re-keys; an unlink drops the name.
  const renameBookmarkNameRef = useSyncRef(renameBookmarkName);
  const removeBookmarkNameRef = useSyncRef(removeBookmarkName);
  const persistBookmarksRef = useSyncRef(persistBookmarks);

  useEffect(() => {
    if (!workspacePath) return undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshTreeRef.current();
      }, 80);
    };
    const unsub = window.api.onFsChanged((evt: FsChangedEvent) => {
      const li = linkIndexRefForWatcher.current;
      if (evt.type === 'tree') {
        scheduleRefresh();
        return;
      }
      if (evt.type === 'unlink') {
        li.removeFile(evt.path);
        if (/\.md$/i.test(evt.path) && removeBookmarkNameRef.current(bookmarkKey(evt.path))) persistBookmarksRef.current();
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
        // 3b) Re-key the bookmark by basename. A pure move keeps the basename →
        //     renameBookmarkName no-ops; only a true rename changes it.
        if (renameBookmarkNameRef.current(bookmarkKey(evt.oldPath), bookmarkKey(evt.newPath))) persistBookmarksRef.current();
        // 4) Rewrite `[[OldName]]` references in other files. Idempotent — if
        //    the rename was in-app, these were already rewritten and the regex
        //    matches nothing on the watcher echo.
        const oldBaseName = evt.oldPath.split('/').pop()!.replace(/\.md$/i, '');
        const newBaseName = evt.newPath.split('/').pop()!.replace(/\.md$/i, '');
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
            } catch (err: any) {
              showErrorRef.current(err.message ?? String(err));
            }
          })();
        }
        scheduleRefresh();
        return;
      }
      // 'add' | 'change'
      // Drawings: not in the link index. Use the dedicated mtime store for the
      // self-echo guard, and reload the live canvas if this is the open drawing.
      if (isDrawing(evt.path)) {
        const store = drawingMtimesRef.current;
        const prior = store.get(evt.path);
        const fresh = prior == null || evt.mtime > prior;
        store.set(evt.path, Math.max(prior ?? 0, evt.mtime));
        if (
          evt.type === 'change' &&
          fresh &&
          evt.path === activeFileRef.current &&
          !activeIsDraftRef.current
        ) {
          (async () => {
            try {
              const json = await window.api.readFile(evt.path);
              drawingViewRef.current?.reloadScene(json);
            } catch { /* file may have been deleted or moved */ }
          })();
        }
        if (evt.type === 'add') scheduleRefresh();
        return;
      }
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
          } catch {
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
  }, [workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps -- subscribe once per workspace; all other deps read via refs (see header)
}
