import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { markdown, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { indentGuides } from './indentGuides.js';
import { oneDark } from '@codemirror/theme-one-dark';
import { taskCheckboxes, taskEnterKeymap } from './taskCheckboxes.js';
import { blankLineOutdentKeymap } from './blankLineOutdent.js';
import { listContinueKeymap } from './listContinue.js';
import { bulletPoints } from './bulletPoints.js';
import { codeStyles } from './codeBlocks.js';
import { wikiLinks } from './wikiLinks.js';
import { wikiLinkCompletions } from './wikiCompletions.js';
import { hideMarkdownMarkers } from './hideMarkdownMarkers.js';
import { headingStyles } from './headingStyles.js';
import { autoLinks } from './autoLinks.js';
import { markdownLinks, findLinkAtPos } from './markdownLinks.js';
import { imagePaste } from './imagePaste.js';
import { imageWidgets } from './imageWidgets.js';
import { diffFlashExtension, flashRanges as flashRangesHelper } from './diffFlash.js';
import { EDITOR_ACTIONS, VIEW_MODES } from './constants.js';

// Markdown list/quote Enter + Backspace. `nonTightLists: false` makes an empty
// bullet/quote collapse immediately on Enter, instead of CM's default
// tight→loose conversion (which inserts a blank line, pushing the marker down,
// and only collapses on a *second* Enter).
//
// We must own this keymap explicitly: markdown() defaults to addKeymap:true,
// which injects its own markdownKeymap at Prec.high — that high-prec copy beats
// our manually-ordered keymap below, pre-empting taskEnterKeymap (so `- [ ]`
// never collapses) and carrying the buggy default tight-list config. We pass
// addKeymap:false to markdown() and bind these ourselves, AFTER taskEnterKeymap.
const markdownEnterKeymap = [
  { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
  { key: 'Backspace', run: deleteMarkupBackward },
];

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
const Editor = forwardRef<any, any>(function Editor(
  { onLinkClick, onChange, getPageIndexRef, getVaultPathRef, getActiveFilePathRef, flushDraftToDiskRef, onImageError, onRequestUrl, onSendToAgent, onStats, onHistory, dark, viewMode, hideLineNumbers },
  ref,
) {
  const hostRef = useRef<any>(null);
  const viewRef = useRef<any>(null);
  const readOnlyCompartmentRef = useRef<any>(null);
  const livePreviewCompartmentRef = useRef<any>(null);
  const livePreviewExtensionsRef = useRef<any>(null);
  const linkClickRef = useRef(onLinkClick);
  const changeRef = useRef(onChange);
  const requestUrlRef = useRef(onRequestUrl);
  const sendToAgentRef = useRef(onSendToAgent);
  const imageErrorRef = useRef(onImageError);
  const statsRef = useRef(onStats);
  const historyRef = useRef(onHistory);
  const statsRafRef = useRef(0);
  const isProgrammaticRef = useRef(false);

  useEffect(() => { linkClickRef.current = onLinkClick; }, [onLinkClick]);
  useEffect(() => { changeRef.current = onChange; }, [onChange]);
  useEffect(() => { requestUrlRef.current = onRequestUrl; }, [onRequestUrl]);
  useEffect(() => { sendToAgentRef.current = onSendToAgent; }, [onSendToAgent]);
  useEffect(() => { imageErrorRef.current = onImageError; }, [onImageError]);
  useEffect(() => { statsRef.current = onStats; }, [onStats]);
  useEffect(() => { historyRef.current = onHistory; }, [onHistory]);

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

  // "Hide line numbers" doesn't actually remove the gutter — we keep its
  // reserved width so the text column doesn't shift left. The class on the
  // host element drives CSS that makes the digits + active-line highlight
  // invisible. See styles.css `.editor-host-no-line-numbers`.

  const handleContextMenu = async (e) => {
    e.preventDefault();
    const view = viewRef.current;
    if (!view) return;
    const { from, to, head } = view.state.selection.main;
    const hasSelection = from !== to;
    const hasFilePath = !!(getActiveFilePathRef?.current);
    // Detect a markdown link (text or image-wrapping) under the cursor/selection
    // so the context menu can offer Edit / Remove link.
    const linkAtCursor = findLinkAtPos(view.state, hasSelection ? from : head);
    const action = await window.api.showEditorContextMenu({
      hasSelection,
      hasFilePath,
      hasLink: !!linkAtCursor,
    });
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
      const result = await requestUrlRef.current?.();
      const url = result?.url;
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
    if (action === EDITOR_ACTIONS.REMOVE_EXTERNAL_LINK) {
      if (!linkAtCursor) { view.focus(); return; }
      // Text link → unwrap to `text`. Image-wrapping link → unwrap to the
      // image markdown (preserves the embed, drops only the hyperlink).
      const replacement = linkAtCursor.kind === 'image'
        ? view.state.sliceDoc(linkAtCursor.imageFrom, linkAtCursor.imageTo)
        : linkAtCursor.text;
      view.dispatch({
        changes: { from: linkAtCursor.from, to: linkAtCursor.to, insert: replacement },
        selection: { anchor: linkAtCursor.from + replacement.length },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.EDIT_EXTERNAL_LINK) {
      if (!linkAtCursor) { view.focus(); return; }
      // For image-wrapping links, the visible "text" IS the image markdown —
      // surface it in the modal so the user can swap the entire content if
      // they want (or leave it).
      const initialText = linkAtCursor.kind === 'image'
        ? view.state.sliceDoc(linkAtCursor.imageFrom, linkAtCursor.imageTo)
        : (linkAtCursor.text ?? '');
      const result = await requestUrlRef.current?.({
        initialUrl: linkAtCursor.url,
        initialText,
      });
      if (!result?.url) { view.focus(); return; }
      const v2 = viewRef.current;
      if (!v2) return;
      const newText = result.text ?? initialText;
      const insert = `[${newText}](${result.url})`;
      v2.dispatch({
        changes: { from: linkAtCursor.from, to: linkAtCursor.to, insert },
        selection: { anchor: linkAtCursor.from + insert.length },
        scrollIntoView: true,
      });
      v2.focus();
      return;
    }
    if (action === EDITOR_ACTIONS.SEND_TO_AGENT) {
      const doc = view.state.doc;
      if (hasSelection) {
        const startLine = doc.lineAt(from);
        const endLine = doc.lineAt(to);
        sendToAgentRef.current?.({
          hasSelection: true,
          selection: view.state.sliceDoc(from, to),
          fromLine: startLine.number,
          fromCol: from - startLine.from + 1,
          toLine: endLine.number,
          toCol: to - endLine.from + 1,
        });
      } else {
        const line = doc.lineAt(head);
        sendToAgentRef.current?.({
          hasSelection: false,
          line: line.number,
          col: head - line.from + 1,
        });
      }
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
      historyRef.current?.({
        canUndo: undoDepth(view.state) > 0,
        canRedo: redoDepth(view.state) > 0,
      });
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
      historyRef.current?.({
        canUndo: undoDepth(view.state) > 0,
        canRedo: redoDepth(view.state) > 0,
      });
    },
    undo: () => {
      const view = viewRef.current;
      if (!view) return false;
      const result = undo(view);
      view.focus();
      return result;
    },
    redo: () => {
      const view = viewRef.current;
      if (!view) return false;
      const result = redo(view);
      view.focus();
      return result;
    },
    flashRanges: (ranges) => {
      const view = viewRef.current;
      if (!view) return;
      flashRangesHelper(view, ranges);
    },
    setReadOnly: (ro) => {
      const view = viewRef.current;
      const cmp = readOnlyCompartmentRef.current;
      if (!view || !cmp) return;
      view.dispatch({ effects: cmp.reconfigure(EditorState.readOnly.of(!!ro)) });
    },
    focus: () => { viewRef.current?.focus(); },
    // Insert text at the current cursor (replacing any selection). NOT marked
    // programmatic, so it flows through the updateListener → onChange → dirty →
    // autosave path, exactly like typing. Used by the template picker.
    insertAtCursor: (text) => {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const completionSource = wikiLinkCompletions(
      () => getPageIndexRef?.current ?? new Map(),
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
      markdownLinks,
      taskCheckboxes,
      bulletPoints,
      codeStyles,
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
      diffFlashExtension,
      lineNumbers(),
      highlightActiveLine(),
      history(),
      indentOnInput(),
      indentGuides,
      markdown({ addKeymap: false, extensions: [{ remove: ['SetextHeading'] }] }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      livePreviewCompartment.of(initialLive),
      imagePaste({
        getActiveFilePath: () => getActiveFilePathRef?.current ?? null,
        flushDraftToDisk: () => flushDraftToDiskRef?.current?.() ?? null,
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
        ...taskEnterKeymap,
        ...listContinueKeymap,
        ...markdownEnterKeymap,
        ...blankLineOutdentKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isProgrammaticRef.current) {
          changeRef.current?.();
        }
        if (update.docChanged) {
          // Coalesce stats + history-depth across rapid keystrokes — at most
          // one compute per frame. undoDepth/redoDepth are O(1) array-length
          // reads, so piggybacking is free.
          if (statsRafRef.current) cancelAnimationFrame(statsRafRef.current);
          statsRafRef.current = requestAnimationFrame(() => {
            statsRafRef.current = 0;
            const v = viewRef.current;
            if (!v) return;
            statsRef.current?.(computeStats(v.state));
            historyRef.current?.({
              canUndo: undoDepth(v.state) > 0,
              canRedo: redoDepth(v.state) > 0,
            });
          });
        }
      }),
      EditorView.theme({
        '&': { fontSize: '16px', backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
          overflow: 'visible',
          fontFamily: 'Inter, sans-serif',
          backgroundColor: 'transparent',
        },
        '.cm-content': { paddingLeft: '0', paddingRight: 'var(--text-col-left)' },
        '.cm-activeLine': { backgroundColor: 'var(--bg-active-line)' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--bg-active-line)' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: 'none' },
        '.cm-lineNumbers': { paddingLeft: '0', paddingRight: '0' },
        // Gutter is 66px wide (hardcoded). CodeMirror's built-in .cm-line
        // padding-left adds 6px, so typed text lands at 72 = --text-col-left,
        // the column title and backlinks anchor to. Numbers right-align inside.
        '.cm-lineNumbers .cm-gutterElement': {
          minWidth: '66px',
          paddingRight: '12px',
          boxSizing: 'border-box',
          textAlign: 'right',
        },
      }),
    ];
    if (dark) extensions.push(oneDark);

    const state = EditorState.create({ doc: '', extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    statsRef.current?.({ words: 0, chars: 0 });
    historyRef.current?.({ canUndo: false, canRedo: false });
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

  return (
    <div
      ref={hostRef}
      className={`editor-host ${hideLineNumbers ? 'editor-host-no-line-numbers' : ''}`}
      onContextMenu={handleContextMenu}
    />
  );
});

export default Editor;
