import { Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { spaceWidth, tabStopPx, nextPx } from './indentMetrics.js';

// Vertical indent guides — the grey lines down the left of indented content.
// This is the sole guide renderer (no third-party indent-marker plugin).
//
// Positions are MEASURED, not placed on a `ch` grid (the math lives in
// indentMetrics.ts, shared with hangingIndent.ts so the two can't disagree).
// That keeps every guide just left of the content at its level, for spaces or
// tabs, instead of drifting off and cutting through the text the way a fixed
// `ch` grid does in a proportional font.
//
// Behaviour:
//   • Plain indented text — a guide at every indent level (like a normal
//     code-editor indent guide), each aligned to the real indentation.
//   • Bullet lines — capped to the indent of the TOP-level bullet of the
//     contiguous list block, so the top bullet's line runs straight down through
//     its sub-bullets and nested bullets add no deeper lines (the bullet glyph
//     already shows the nesting).
//   • Blank lines — BRIDGED, VS Code-style: a blank line BETWEEN two content
//     lines borrows the guides of whichever neighbour is indented deeper. A
//     guide therefore runs unbroken through the blank rows inside a block, and
//     up through the blanks above it until the first line with content at a
//     shallower indent. Without this a stray Enter punches a visible hole in it.
//     A blank with no content on one side (the runs at the very top and bottom
//     of the file) belongs to no block and gets nothing — which is what stops
//     the guide after the last content line rather than trailing to EOF.
//   • Non-indented lines — nothing.
//
// The plugin sets each line's guides as stacked 1px background gradients via an
// inline style; app.css only handles the active-line color swap.
const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s|$)/;
const INDENT_UNIT = 2; // columns between guides

// Pixel x (from content start) of each indent-unit boundary in a line's leading
// whitespace, including column 0. A guide for a level is drawn at the LEFT edge
// of that level's unit (the boundary one step shallower than the content), so it
// sits a full indent-step left of the text rather than hugging it. Returns
// [{ col, px }] starting at { 0, 0 }. A tab snaps px to the next tab stop.
function guideBoundaries(ws: string, sp: number, tabPx: number) {
  const out: { col: number; px: number }[] = [{ col: 0, px: 0 }];
  let col = 0;
  let px = 0;
  for (const ch of ws) {
    col += ch === '\t' ? 4 - (col % 4) : 1;
    px = nextPx(px, ch, sp, tabPx);
    if (col % INDENT_UNIT === 0) out.push({ col, px });
  }
  return out;
}

// One Decoration per distinct guide layout, keyed by its position list.
const decoCache = new Map<string, Decoration>();
function guideDeco(positions: number[]) {
  const key = positions.map((x) => x.toFixed(1)).join(',');
  let d = decoCache.get(key);
  if (!d) {
    const layers = positions
      .map(() => 'linear-gradient(var(--indent-line), var(--indent-line))')
      .join(', ');
    // Anchored to the PADDING box, offset by --line-pad — deliberately not the
    // content box. hangingIndent.ts varies .cm-line's padding-left per line, so
    // a content-box origin would drag every guide right along with the hang and
    // straight through the text. The padding box doesn't move.
    const pos = positions
      .map((x) => `calc(var(--line-pad) + ${x.toFixed(2)}px) 0`)
      .join(', ');
    const style =
      `background-image: ${layers};` +
      `background-position: ${pos};` +
      `background-size: 1px 100%;` +
      `background-repeat: no-repeat;` +
      `background-origin: padding-box;`;
    d = Decoration.line({ attributes: { class: 'cm-iguide', style } });
    decoCache.set(key, d);
  }
  return d;
}

function indentColsOf(ws: string) {
  let col = 0;
  for (const ch of ws) col += ch === '\t' ? 4 - (col % 4) : 1;
  return col;
}

function buildDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const ranges = view.visibleRanges;
  if (ranges.length === 0) return builder.finish();
  const sp = spaceWidth(view);
  if (!sp) return builder.finish();
  const tabPx = tabStopPx(view, sp);
  const inView = (from: number) => ranges.some((r) => from >= r.from && from <= r.to);

  const firstVisible = doc.lineAt(ranges[0].from).number;
  const lastVisible = doc.lineAt(ranges[ranges.length - 1].to).number;

  // Walk up to the start of the list block the first visible line sits in, so
  // the block's top-level indent is known even when it scrolled off the top.
  let start = firstVisible;
  while (start > 1) {
    const t = doc.line(start - 1).text;
    if (t.trim() === '' || LIST_RE.test(t)) start--;
    else break;
  }

  // A blank line borrows from its nearest CONTENT neighbours, so the scan has to
  // reach past the viewport on both sides: one content line above (the walk-up
  // already consumed any blanks, so start - 1 is content), and below, past a run
  // of trailing blanks to the content line that ends it.
  const scanStart = Math.max(1, start - 1);
  let scanEnd = lastVisible;
  while (scanEnd < doc.lines && doc.line(scanEnd + 1).text.trim() === '') scanEnd++;
  if (scanEnd < doc.lines) scanEnd++;

  // Pass 1 — guides + indent depth for every CONTENT line in the scan window.
  // Only content lines drive the list-block state machine; blanks are resolved in
  // pass 2. A line present in `guides` is content (its array may be empty).
  const guides = new Map<number, number[]>();
  const depth = new Map<number, number>();
  let blockMin = Infinity; // indent (cols) of the shallowest bullet in the current block
  for (let i = scanStart; i <= scanEnd; i++) {
    const text = doc.line(i).text;
    if (text.trim() === '') continue;
    const m = text.match(LIST_RE);
    const ws = m ? m[1] : text.match(/^\s*/)![0];
    const cols = indentColsOf(ws);
    let cap: number; // draw guides only for indent columns <= cap
    if (m) {
      if (cols < blockMin) blockMin = cols;
      cap = blockMin; // bullet: capped to the block's top-level indent
    } else {
      blockMin = Infinity; // non-list line ends the block
      cap = cols; // plain text: every level
    }
    depth.set(i, cols);
    // A guide sits at the left edge of each level's unit — keep boundaries
    // strictly shallower than the content/cap so the deepest guide is one step
    // left of the text.
    guides.set(
      i,
      cap > 0 ? guideBoundaries(ws, sp, tabPx).filter((b) => b.col < cap).map((b) => b.px) : [],
    );
  }

  // Nearest content line above / below each line in the window (0 = none).
  const above: number[] = [];
  const below: number[] = [];
  for (let i = scanStart, seen = 0; i <= scanEnd; i++) {
    above[i] = seen;
    if (guides.has(i)) seen = i;
  }
  for (let i = scanEnd, seen = 0; i >= scanStart; i--) {
    below[i] = seen;
    if (guides.has(i)) seen = i;
  }

  // Pass 2 — emit for the visible lines, bridging blanks to the deeper neighbour.
  for (let i = firstVisible; i <= lastVisible; i++) {
    const line = doc.line(i);
    if (!inView(line.from)) continue;
    let src = i;
    if (!guides.has(i)) {
      const a = above[i];
      const b = below[i];
      // A blank only bridges BETWEEN two content lines. Run off either end of
      // the file and there's no block to belong to, so draw nothing — this is
      // what stops the guide at the trailing blank lines after the last content
      // line (and matches VS Code).
      if (!a || !b) continue;
      src = depth.get(a)! >= depth.get(b)! ? a : b;
    }
    const positions = guides.get(src);
    if (positions?.length) builder.add(line.from, line.from, guideDeco(positions));
  }
  return builder.finish();
}

export const indentGuides = ViewPlugin.fromClass(
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
