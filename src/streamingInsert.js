// Streaming insert for the AI "Ask the agent" feature.
//
// Maintains a single live range that's being filled by the AI, with a
// background highlight to make it obvious what's in flight. The range maps
// through transactions so positions stay correct.
//
// Lifecycle:
//   beginStreamInsert(view, from, to)
//     → replace the selection with an empty range; start the yellow highlight.
//   appendStreamChunk(view, text)
//     → append text to the live range.
//   endStreamInsert(view, completed)
//     → completed=true:  switch to a one-shot green completion pulse, then clear.
//       completed=false: clear immediately (cancel/error — no flourish).

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

const setRange = StateEffect.define();
const markDone = StateEffect.define();
const clearRange = StateEffect.define();

// Time the green completion pulse runs before the decoration is removed.
// Must match the .cm-ai-stream-done animation duration in styles.css.
const DONE_ANIM_MS = 1000;

const streamField = StateField.define({
  create: () => null,
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setRange)) next = { from: e.value.from, to: e.value.to, done: false };
      else if (e.is(markDone)) next = next ? { ...next, done: true } : next;
      else if (e.is(clearRange)) next = null;
    }
    if (next && tr.docChanged) {
      next = {
        ...next,
        from: tr.changes.mapPos(next.from, -1),
        to: tr.changes.mapPos(next.to, 1),
      };
    }
    return next;
  },
});

const streamingMark = Decoration.mark({ class: 'cm-ai-stream' });
const doneMark = Decoration.mark({ class: 'cm-ai-stream-done' });

const streamDecorations = EditorView.decorations.compute([streamField], (state) => {
  const r = state.field(streamField);
  if (!r || r.from === r.to) return Decoration.none;
  return Decoration.set([(r.done ? doneMark : streamingMark).range(r.from, r.to)]);
});

export const streamingInsertExtension = [streamField, streamDecorations];

export function beginStreamInsert(view, from, to) {
  view.dispatch({
    changes: { from, to, insert: '' },
    effects: setRange.of({ from, to: from }),
    selection: { anchor: from },
    scrollIntoView: true,
  });
  return from;
}

export function appendStreamChunk(view, text) {
  if (!text) return;
  const range = view.state.field(streamField, false);
  if (!range) return;
  const insertAt = range.to;
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert: text },
    selection: { anchor: insertAt + text.length },
    scrollIntoView: true,
  });
}

export function endStreamInsert(view, completed) {
  const range = view.state.field(streamField, false);
  if (!range) return;
  if (!completed) {
    view.dispatch({ effects: clearRange.of(null) });
    return;
  }
  view.dispatch({ effects: markDone.of(null) });
  setTimeout(() => {
    // The view may have been destroyed by then (tab change, etc.) — guard.
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: clearRange.of(null) });
  }, DONE_ANIM_MS);
}
