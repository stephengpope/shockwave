import { Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { spaceWidth, tabStopPx, leadingWidthPx } from './indentMetrics.js';

// Hanging indent for wrapped lines.
//
// CodeMirror renders each line as ONE block with `white-space: pre-wrap`, and a
// line's indentation is CONTENT (leading tab characters), not layout — so a
// wrapped continuation returns to the text column and the indent is lost. The
// fix: give the line a padding-left equal to its own indent, and cancel it on
// the first line with a matching negative text-indent. The first line renders
// exactly where it always did; every wrapped line hangs at the indent.
//
// The hang is the width of the leading whitespace ONLY — a wrapped bullet hangs
// at its indent level, under the bullet. Deliberately NOT the width of the
// bullet/marker too (aligning under the marker's text): CSS measures tab stops
// from the block's content edge, which this padding moves. Whitespace-only
// indent is always a whole number of 20px tab stops (app.css `--editor-tab-size`
// is the one knob), so the grid shifts by whole tabs and lands identically. A
// hang that isn't a tab multiple drags every tab on the line left instead.
//
// `--hang` is consumed by the `.cm-line` rule in app.css.

const LEADING_WS_RE = /^[ \t]*/;

// One Decoration per distinct hang width — lines at the same depth share it.
const decoCache = new Map<string, Decoration>();
function hangDeco(px: number) {
  const key = px.toFixed(2);
  let d = decoCache.get(key);
  if (!d) {
    d = Decoration.line({ attributes: { style: `--hang: ${key}px` } });
    decoCache.set(key, d);
  }
  return d;
}

function buildDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  const sp = spaceWidth(view);
  if (!sp) return builder.finish();
  const tabPx = tabStopPx(view, sp);
  const doc = view.state.doc;
  let lastLine = 0; // a line can straddle two visible ranges — add it once

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number !== lastLine) {
        lastLine = line.number;
        const ws = LEADING_WS_RE.exec(line.text)![0];
        // Skip blank/whitespace-only lines — nothing there to wrap.
        if (ws && ws.length < line.text.length) {
          const px = leadingWidthPx(ws, sp, tabPx);
          if (px > 0) builder.add(line.from, line.from, hangDeco(px));
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
