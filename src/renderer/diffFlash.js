// Multi-range green flash. Used when the editor's active file is reloaded
// from disk (e.g. an external editor or the coding agent edits it) so the
// user can see which lines were just added. Reuses the same .cm-ai-stream-done
// style + 1s pulse as the inline-AI completion flourish.
//
// Lifecycle:
//   flashRanges(view, ranges)
//     → set the decoration ranges, schedule a clear in DONE_ANIM_MS.
//   Subsequent flashRanges() before the timer fires replaces the ranges
//   and restarts the animation.

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

const setRanges = StateEffect.define();
const clearRanges = StateEffect.define();

// Must match the .cm-ai-stream-done animation duration in styles.css.
const DONE_ANIM_MS = 1000;

const flashField = StateField.define({
  create: () => [],
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setRanges)) next = e.value;
      else if (e.is(clearRanges)) next = [];
    }
    if (next.length > 0 && tr.docChanged) {
      next = next
        .map((r) => ({
          from: tr.changes.mapPos(r.from, -1),
          to: tr.changes.mapPos(r.to, 1),
        }))
        .filter((r) => r.from < r.to);
    }
    return next;
  },
});

const doneMark = Decoration.mark({ class: 'cm-ai-stream-done' });

const flashDecorations = EditorView.decorations.compute([flashField], (state) => {
  const ranges = state.field(flashField);
  if (!ranges.length) return Decoration.none;
  const docLen = state.doc.length;
  const valid = ranges
    .filter((r) => r.from < r.to && r.to <= docLen)
    .sort((a, b) => a.from - b.from)
    .map((r) => doneMark.range(r.from, r.to));
  return Decoration.set(valid);
});

export const diffFlashExtension = [flashField, flashDecorations];

export function flashRanges(view, ranges) {
  if (!view || !ranges || ranges.length === 0) return;
  view.dispatch({ effects: setRanges.of(ranges) });
  setTimeout(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: clearRanges.of(null) });
  }, DONE_ANIM_MS);
}

// Walk a `diff.diffLines(old, new)` change array and return the [{from,to}]
// offsets of added text in the new doc. `old`/`new` are the same strings
// passed to diffLines (we recompute via length tracking).
export function rangesAddedFromDiff(changes) {
  const ranges = [];
  let pos = 0;
  for (const part of changes) {
    const len = part.value.length;
    if (part.removed) continue; // not in new doc
    if (part.added) ranges.push({ from: pos, to: pos + len });
    pos += len;
  }
  return ranges;
}
