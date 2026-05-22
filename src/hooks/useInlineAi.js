import { useCallback, useEffect, useRef, useState } from 'react';

// Drives any inline AI action that streams text into the editor.
//
// run({ action, params, range })
//   action  — 'ask' | 'rewrite' (or any other id the main-process action
//             registry understands)
//   params  — object handed verbatim to the main process; the action's
//             buildUserMessage turns it into the model's user message
//   range   — { from, to } target in the editor doc. If from === to we
//             insert at the cursor; otherwise we replace the range.
//
// Lifecycle:
//   1. Lock the editor, remember the range. Selection stays visible until
//      the first chunk actually arrives (so failures leave the doc untouched).
//   2. On the first chunk, replace the range with an empty streaming range
//      and begin the highlight. Subsequent chunks append.
//   3. done → green completion pulse, unlock. error/cancel → clear, unlock.
//
// One stream at a time. Escape cancels.

function genRequestId() {
  return 'r_' + Math.random().toString(36).slice(2, 10);
}

export function useInlineAi({ editorRef, onError }) {
  const requestIdRef = useRef(null);
  const pendingRangeRef = useRef(null);
  const [isAsking, setIsAsking] = useState(false);

  const cleanup = useCallback((completed) => {
    requestIdRef.current = null;
    pendingRangeRef.current = null;
    setIsAsking(false);
    editorRef.current?.endStream(completed);
    editorRef.current?.setReadOnly(false);
  }, [editorRef]);

  const cancel = useCallback(() => {
    const id = requestIdRef.current;
    if (!id) return;
    window.api.ai.cancel(id);
    cleanup(false);
  }, [cleanup]);

  const run = useCallback(({ action, params, range }) => {
    if (requestIdRef.current) cancel();
    const editor = editorRef.current;
    if (!editor) return;
    const id = genRequestId();
    requestIdRef.current = id;
    pendingRangeRef.current = { from: range.from, to: range.to };
    setIsAsking(true);
    editor.setReadOnly(true);
    window.api.ai.run(id, action, params);
  }, [cancel, editorRef]);

  useEffect(() => {
    const offChunk = window.api.ai.onChunk(({ requestId, delta }) => {
      if (requestId !== requestIdRef.current) return;
      const editor = editorRef.current;
      if (!editor) return;
      if (pendingRangeRef.current) {
        const { from, to } = pendingRangeRef.current;
        pendingRangeRef.current = null;
        editor.beginStream(from, to);
      }
      editor.appendStream(delta);
    });
    const offDone = window.api.ai.onDone(({ requestId }) => {
      if (requestId !== requestIdRef.current) return;
      cleanup(true);
    });
    const offError = window.api.ai.onError(({ requestId, message }) => {
      if (requestId !== requestIdRef.current) return;
      cleanup(false);
      onError?.(message || 'AI request failed.');
    });
    return () => { offChunk(); offDone(); offError(); };
  }, [editorRef, cleanup, onError]);

  useEffect(() => {
    if (!isAsking) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isAsking, cancel]);

  return { isAsking, run, cancel };
}
