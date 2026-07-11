import React, { forwardRef, useImperativeHandle, useEffect, useRef, useState, useCallback } from 'react';
import { Excalidraw, serializeAsJSON, restore } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { DrawingSelectionItem } from './hooks/useSendToAgent';

// Editable Excalidraw canvas for `.excalidraw` files. Unlike MediaView (static
// image/video), drawings load JSON from disk, autosave on change, and reload
// live when the file is rewritten externally (e.g. the coding agent).
//
// Save model: Excalidraw is uncontrolled after init. `onChange` fires on every
// pointer move, so saves are debounced. The pending payload is tagged with the
// path it belongs to, so switching the `path` prop (tab switch reuses the same
// mounted component) can't write one drawing's content to another's file —
// the old path's pending save is flushed before the new scene loads. Each save
// reports its file mtime up via `onSaved` so the parent can record it and skip
// the watcher self-echo (same discipline as the text editor's link-index mtime).

const SAVE_DEBOUNCE_MS = 500;

export type DrawingViewHandle = {
  /** Apply an externally-changed scene (watcher reload). */
  reloadScene: (json: string) => void;
  /** Flush any pending debounced save immediately. */
  flush: () => Promise<void>;
};

function parseScene(json: string) {
  let data: any = {};
  try { data = JSON.parse(json); } catch { data = {}; }
  // restore() normalizes elements/appState and drops volatile fields
  // (collaborators, selection) so they round-trip cleanly.
  return restore(data, null, null);
}

const DrawingView = forwardRef<DrawingViewHandle, {
  path: string;
  dark: boolean;
  onSaved?: (path: string, mtime: number) => void;
  onError?: (msg: string) => void;
  onSendToAgent?: (selected: DrawingSelectionItem[]) => void;
}>(function DrawingView({ path, dark, onSaved, onError, onSendToAgent }, ref) {
  const [initialData, setInitialData] = useState<any | null>(null);
  const apiRef = useRef<any>(null);

  // Debounced-save plumbing. `pendingRef` holds the path it belongs to so a
  // path switch can never write the wrong file.
  const saveTimerRef = useRef<any>(null);
  const pendingRef = useRef<{ path: string; json: string } | null>(null);
  // Suppress the onChange that updateScene() fires when WE apply a remote
  // reload — otherwise we'd immediately re-save the just-loaded content and
  // bounce it back through the watcher.
  const applyingRemoteRef = useRef(false);
  // Don't persist until the user actually touches the canvas. Excalidraw fires
  // onChange on mount (and on font-load reflow) with normalized fields + fresh
  // timestamps — saving those would rewrite every drawing on mere open and
  // churn git sync. Until the first real interaction we only track the baseline;
  // after it we save only when the serialized scene differs from the baseline
  // (so pan / zoom / selection alone don't write).
  const interactedRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null);

  // Flush whatever is pending (for its own path) immediately.
  const flush = useCallback(async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    try {
      const mtime = await window.api.writeFile(pending.path, pending.json);
      onSaved?.(pending.path, mtime);
    } catch (e: any) {
      pendingRef.current = pending; // re-arm for the next attempt
      onError?.(`Couldn't save drawing: ${e?.message || e}`);
    }
  }, [onSaved, onError]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Load (and reload on path change) the scene from disk. Flush the previous
  // path's pending save first so it isn't lost or misrouted.
  useEffect(() => {
    let cancelled = false;
    flushRef.current();
    interactedRef.current = false;
    lastSavedRef.current = null;
    setInitialData(null);
    window.api.readFile(path).then((json) => {
      if (cancelled) return;
      setInitialData(parseScene(json));
    }).catch((e) => {
      if (cancelled) return;
      onError?.(`Couldn't open drawing: ${e?.message || e}`);
      setInitialData(parseScene('{}'));
    });
    return () => { cancelled = true; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = useCallback((elements: any, appState: any, files: any) => {
    if (applyingRemoteRef.current) return;
    const json = serializeAsJSON(elements, appState, files, 'local');
    // Pre-interaction (mount normalization, font reflow): track baseline, don't write.
    if (!interactedRef.current) { lastSavedRef.current = json; return; }
    // No substantive change (pan / zoom / selection): skip.
    if (json === lastSavedRef.current) return;
    lastSavedRef.current = json;
    pendingRef.current = { path, json };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flushRef.current(); }, SAVE_DEBOUNCE_MS);
  }, [path]);

  useImperativeHandle(ref, () => ({
    reloadScene(json: string) {
      const api = apiRef.current;
      if (!api) return;
      const scene = parseScene(json);
      applyingRemoteRef.current = true;
      api.updateScene({ elements: scene.elements, appState: scene.appState });
      if (scene.files) api.addFiles(Object.values(scene.files));
      // Reset the baseline to the reloaded content so a later edit compares
      // against what's now on screen (the suppressed onChange won't set it).
      lastSavedRef.current = serializeAsJSON(scene.elements, scene.appState, scene.files, 'local');
      setTimeout(() => { applyingRemoteRef.current = false; }, 0);
    },
    flush,
  }), [flush]);

  // Flush on unmount so a fast tab-close doesn't drop the last edit.
  useEffect(() => () => { flushRef.current(); }, []);

  const markInteracted = useCallback(() => { interactedRef.current = true; }, []);

  // Send the drawing's file (App adds the path) + the currently-selected
  // elements (id/type/text) to the chat composer, so the agent knows which
  // elements the user means. Reads selection live from the Excalidraw API.
  const sendToAgent = useCallback(() => {
    const api = apiRef.current;
    if (!api || !onSendToAgent) return;
    const sel = api.getAppState()?.selectedElementIds || {};
    const selected: DrawingSelectionItem[] = api.getSceneElements()
      .filter((el: any) => sel[el.id])
      .map((el: any) => ({ id: el.id, type: el.type, text: el.text || undefined }));
    onSendToAgent(selected);
  }, [onSendToAgent]);

  if (!initialData) return <div className="p-6 text-[13px] text-muted-2">Loading drawing…</div>;

  return (
    // drawing-view-host: the `.excalidraw` descendant sizing rule lives in
    // app.css (Excalidraw needs a definitely-sized parent or it collapses).
    <div className="drawing-view-host relative flex min-h-0 flex-1" onPointerDownCapture={markInteracted} onKeyDownCapture={markInteracted}>
      <Excalidraw
        excalidrawAPI={(api) => { apiRef.current = api; }}
        initialData={initialData}
        onChange={onChange}
        theme={dark ? 'dark' : 'light'}
      />
      {onSendToAgent && (
        <button
          // Overlays the canvas bottom-right, just left of Excalidraw's 36px
          // help "?" button (no slot exposed there): bottom 18px centers our
          // 32px button on its center; right 62px clears its ~52px footprint.
          className="absolute bottom-[18px] right-[62px] z-[5] inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-md hover:bg-primary-hover"
          onClick={sendToAgent}
          title="Message the agent about this drawing (includes the file and any selected elements)"
        >
          Message Agent
        </button>
      )}
    </div>
  );
});

export default DrawingView;
