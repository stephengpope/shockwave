import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { oneDark } from '@codemirror/theme-one-dark';
import { taskCheckboxes } from './taskCheckboxes.js';
import { bulletPoints } from './bulletPoints.js';
import { wikiLinks } from './wikiLinks.js';
import { wikiLinkCompletions } from './wikiCompletions.js';
import { hideMarkdownMarkers } from './hideMarkdownMarkers.js';
import { headingStyles } from './headingStyles.js';
import { autoLinks } from './autoLinks.js';
import { imagePaste } from './imagePaste.js';
import { imageWidgets } from './imageWidgets.js';
import {
  streamingInsertExtension,
  beginStreamInsert,
  appendStreamChunk,
  endStreamInsert,
} from './streamingInsert.js';
import { EDITOR_ACTIONS, VIEW_MODES } from './constants.js';

function computeStats(state) {
  const chars = state.doc.length;
  if (chars === 0) return { words: 0, chars: 0 };
  const text = state.doc.toString();
  const trimmed = text.trim();
  const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  return { words, chars };
}

/**
 * Imperative editor wrapper.
 *
 * Props:
 *   onLinkClick(name)              — wiki-link clicks
 *   onChange()                     — fired when the user changes the doc (not for programmatic load)
 *   getPageIndexRef                — ref whose .current is the latest pageIndex Map (autocomplete reads it live)
 *   getVaultPathRef                — ref whose .current is the active workspace path
 *   dark                           — boolean; when changed, the editor is recreated with/without oneDark
 *
 * Ref API (parent uses it to load content + read state):
 *   setContent(text, viewState?)   — replaces doc; restores cursor/scroll if viewState provided, else resets to top
 *   getText()                      — current doc text
 *   getViewState()                 — { cursor, scrollTop } snapshot
 *   clear()                        — empties the doc, resets cursor
 */
const Editor = forwardRef(function Editor(
  { onLinkClick, onChange, getPageIndexRef, getVaultPathRef, getActiveFilePathRef, onImageError, onRequestUrl, onAskAgent, onStats, dark, viewMode },
  ref,
) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const readOnlyCompartmentRef = useRef(null);
  const livePreviewCompartmentRef = useRef(null);
  const livePreviewExtensionsRef = useRef(null);
  const linkClickRef = useRef(onLinkClick);
  const changeRef = useRef(onChange);
  const requestUrlRef = useRef(onRequestUrl);
  const askAgentRef = useRef(onAskAgent);
  const imageErrorRef = useRef(onImageError);
  const statsRef = useRef(onStats);
  const statsRafRef = useRef(0);
  const isProgrammaticRef = useRef(false);

  useEffect(() => { linkClickRef.current = onLinkClick; }, [onLinkClick]);
  useEffect(() => { changeRef.current = onChange; }, [onChange]);
  useEffect(() => { requestUrlRef.current = onRequestUrl; }, [onRequestUrl]);
  useEffect(() => { askAgentRef.current = onAskAgent; }, [onAskAgent]);
  useEffect(() => { imageErrorRef.current = onImageError; }, [onImageError]);
  useEffect(() => { statsRef.current = onStats; }, [onStats]);

  // Toggle the live-preview decoration bundle without rebuilding the editor.
  // Cursor, history, scroll all survive a reconfigure.
  useEffect(() => {
    const view = viewRef.current;
    const cmp = livePreviewCompartmentRef.current;
    const live = livePreviewExtensionsRef.current;
    if (!view || !cmp || !live) return;
    const next = viewMode === VIEW_MODES.RAW ? [] : live;
    view.dispatch({ effects: cmp.reconfigure(next) });
  }, [viewMode]);

  const handleContextMenu = async (e) => {
    e.preventDefault();
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const hasSelection = from !== to;
    const action = await window.api.showEditorContextMenu({ hasSelection });
    if (!action) return;
    if (action === EDITOR_ACTIONS.ADD_LINK) {
      const selected = view.state.sliceDoc(from, to);
      const insert = `[[${selected}]]`;
      // Empty selection → cursor between brackets so the user can type the name.
      // Non-empty selection → cursor after the closing ]] so typing continues normally.
      const anchor = selected ? from + insert.length : from + 2;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.ADD_EXTERNAL_LINK) {
      // Capture {from,to} BEFORE opening the modal — focus leaves the editor.
      const selected = view.state.sliceDoc(from, to);
      const url = await requestUrlRef.current?.();
      if (!url) { view.focus(); return; }
      const v2 = viewRef.current;
      if (!v2) return;
      const text = selected || url;
      const insert = `[${text}](${url})`;
      v2.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      v2.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.INLINE_AI) {
      // Capture range + selection text + surrounding context BEFORE the modal
      // opens (focus leaves the editor). The parent owns the modal and the
      // streaming dispatch.
      const selection = view.state.sliceDoc(from, to);
      const docText = view.state.doc.toString();
      const contextBefore = docText.slice(0, from);
      const contextAfter = docText.slice(to);
      askAgentRef.current?.({ from, to, selection, contextBefore, contextAfter });
    }
  };

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? '',
    getViewState: () => {
      const view = viewRef.current;
      if (!view) return null;
      return {
        cursor: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
      };
    },
    setContent: (text, viewState) => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      isProgrammaticRef.current = true;
      if (current !== text) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
      }
      isProgrammaticRef.current = false;
      const len = view.state.doc.length;
      if (viewState) {
        const cursor = Math.min(viewState.cursor ?? 0, len);
        view.dispatch({ selection: { anchor: cursor } });
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = viewState.scrollTop ?? 0;
        });
      } else {
        view.dispatch({ selection: { anchor: 0 } });
        requestAnimationFrame(() => { view.scrollDOM.scrollTop = 0; });
      }
      statsRef.current?.(computeStats(view.state));
    },
    clear: () => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      isProgrammaticRef.current = true;
      view.dispatch({ changes: { from: 0, to: current.length, insert: '' } });
      isProgrammaticRef.current = false;
      view.dispatch({ selection: { anchor: 0 } });
      statsRef.current?.({ words: 0, chars: 0 });
    },
    beginStream: (from, to) => {
      const view = viewRef.current;
      if (!view) return null;
      return beginStreamInsert(view, from, to);
    },
    appendStream: (text) => {
      const view = viewRef.current;
      if (!view) return;
      appendStreamChunk(view, text);
    },
    endStream: (completed) => {
      const view = viewRef.current;
      if (!view) return;
      endStreamInsert(view, !!completed);
    },
    setReadOnly: (ro) => {
      const view = viewRef.current;
      const cmp = readOnlyCompartmentRef.current;
      if (!view || !cmp) return;
      view.dispatch({ effects: cmp.reconfigure(EditorState.readOnly.of(!!ro)) });
    },
    focus: () => { viewRef.current?.focus(); },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const completionSource = wikiLinkCompletions(
      () => getPageIndexRef?.current ?? new Map(),
      () => getVaultPathRef?.current ?? null,
    );

    const readOnlyCompartment = new Compartment();
    readOnlyCompartmentRef.current = readOnlyCompartment;

    const livePreviewCompartment = new Compartment();
    livePreviewCompartmentRef.current = livePreviewCompartment;

    // Decorations that turn the editor into a live preview. Toggling them off
    // (raw mode) shows the underlying markdown syntax. `markdown()` syntax
    // highlighting stays on either way so headings/code keep their colors.
    // Autocomplete stays on too — `[[` completion is useful in raw mode.
    const livePreviewExtensions = [
      headingStyles,
      hideMarkdownMarkers,
      autoLinks,
      taskCheckboxes,
      bulletPoints,
      imageWidgets(
        () => getActiveFilePathRef?.current ?? null,
        () => getVaultPathRef?.current ?? null,
      ),
      wikiLinks(
        (name) => linkClickRef.current?.(name),
        () => getPageIndexRef?.current ?? new Map(),
      ),
    ];
    livePreviewExtensionsRef.current = livePreviewExtensions;

    const initialLive = viewMode === VIEW_MODES.RAW ? [] : livePreviewExtensions;

    const extensions = [
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      streamingInsertExtension,
      lineNumbers(),
      highlightActiveLine(),
      history(),
      indentOnInput(),
      indentationMarkers({
        thickness: 1,
        activeThickness: 1,
        markerType: 'codeOnly',
        colors: dark
          ? { dark: '#3a3a3a', activeDark: '#5a5a5a' }
          : { light: '#e0e0e0', activeLight: '#c0c0c0' },
      }),
      markdown({ extensions: [{ remove: ['SetextHeading'] }] }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      livePreviewCompartment.of(initialLive),
      imagePaste({
        getActiveFilePath: () => getActiveFilePathRef?.current ?? null,
        onError: (msg) => imageErrorRef.current?.(msg),
      }),
      autocompletion({
        override: [completionSource],
        activateOnTyping: true,
        maxRenderedOptions: 30,
      }),
      keymap.of([
        indentWithTab,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isProgrammaticRef.current) {
          changeRef.current?.();
        }
        if (update.docChanged) {
          // Coalesce stats across rapid keystrokes — at most one compute per frame.
          if (statsRafRef.current) cancelAnimationFrame(statsRafRef.current);
          statsRafRef.current = requestAnimationFrame(() => {
            statsRafRef.current = 0;
            const v = viewRef.current;
            if (!v) return;
            statsRef.current?.(computeStats(v.state));
          });
        }
      }),
      EditorView.theme({
        '&': { fontSize: '14px', backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
          overflow: 'visible',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          backgroundColor: 'transparent',
        },
        '.cm-content': { paddingLeft: '4px', paddingRight: 'var(--text-col-left)' },
        '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: 'none' },
        '.cm-lineNumbers': { paddingLeft: '8px', paddingRight: '12px' },
        // Reserve room for up to 5-digit line numbers so the gutter width stays
        // stable through 1 → 10 → 100 → 1000 → 10000 lines.
        '.cm-lineNumbers .cm-gutterElement': { minWidth: '5ch', boxSizing: 'content-box' },
      }),
    ];
    if (dark) extensions.push(oneDark);

    const state = EditorState.create({ doc: '', extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    statsRef.current?.({ words: 0, chars: 0 });
    return () => {
      if (statsRafRef.current) {
        cancelAnimationFrame(statsRafRef.current);
        statsRafRef.current = 0;
      }
      view.destroy();
      viewRef.current = null;
      readOnlyCompartmentRef.current = null;
      livePreviewCompartmentRef.current = null;
      livePreviewExtensionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  return <div ref={hostRef} className="editor-host" onContextMenu={handleContextMenu} />;
});

export default Editor;
