import { Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// Vertical indent guides — the grey lines down the left of indented content.
// This is the sole guide renderer (no third-party indent-marker plugin).
//
// Positions are MEASURED, not placed on a `ch` grid: we measure the font's
// space-advance once via a canvas (cheap, no editor-layout read — CodeMirror
// forbids layout reads during an update) and compute each indent level's real
// pixel x arithmetically (a space advances one space-width, a tab snaps to the
// next tab stop). That keeps every guide just left of the content at its level,
// for spaces or tabs, instead of drifting off and cutting through the text the
// way a fixed `ch` grid does in a proportional font.
//
// Behaviour:
//   • Plain indented text — a guide at every indent level (like a normal
//     code-editor indent guide), each aligned to the real indentation.
//   • Bullet lines — capped to the indent of the TOP-level bullet of the
//     contiguous list block, so the top bullet's line runs straight down through
//     its sub-bullets and nested bullets add no deeper lines (the bullet glyph
//     already shows the nesting).
//   • Blank and non-indented lines — nothing.
//
// The plugin sets each line's guides as stacked 1px background gradients via an
// inline style; styles.css only handles the active-line color swap.
const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s|$)/;
const INDENT_UNIT = 2; // columns between guides

// --- font measurement (canvas; no editor-layout read) ---
let cachedFont = '';
let cachedSpace = 0;
let measureCtx: CanvasRenderingContext2D | null = null;
function spaceWidth(view: EditorView) {
  const cs = getComputedStyle(view.contentDOM);
  const font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
  if (font !== cachedFont || !cachedSpace) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return 0;
    measureCtx.font = font;
    cachedFont = font;
    cachedSpace = measureCtx.measureText(' ').width;
  }
  return cachedSpace;
}
function tabStopPx(view: EditorView, sp: number) {
  const ts = getComputedStyle(view.contentDOM).tabSize;
  const n = parseFloat(ts);
  if (!n) return sp * 4;
  return ts.includes('px') ? n : n * sp; // unitless = number of space-widths
}

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
    if (ch === '\t') {
      col += 4 - (col % 4);
      px = (Math.floor(px / tabPx) + 1) * tabPx;
    } else {
      col += 1;
      px += sp;
    }
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
    const pos = positions.map((x) => `${x.toFixed(2)}px 0`).join(', ');
    const style =
      `background-image: ${layers};` +
      `background-position: ${pos};` +
      `background-size: 1px 100%;` +
      `background-repeat: no-repeat;` +
      `background-origin: content-box;`;
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

  let blockMin = Infinity; // indent (cols) of the shallowest bullet in the current block
  for (let i = start; i <= lastVisible; i++) {
    const line = doc.line(i);
    const text = line.text;
    if (text.trim() === '') continue; // blank line — no guide, keep block context
    const m = text.match(LIST_RE);
    const ws = m ? m[1] : text.match(/^\s*/)![0];
    let cap: number; // draw guides only for indent columns <= cap
    if (m) {
      const cols = indentColsOf(ws);
      if (cols < blockMin) blockMin = cols;
      cap = blockMin; // bullet: capped to the block's top-level indent
    } else {
      blockMin = Infinity; // non-list line ends the block
      cap = indentColsOf(ws); // plain text: every level
    }
    if (cap > 0 && inView(line.from)) {
      // A guide sits at the left edge of each level's unit — keep boundaries
      // strictly shallower than the content/cap so the deepest guide is one
      // step left of the text.
      const positions = guideBoundaries(ws, sp, tabPx)
        .filter((b) => b.col < cap)
        .map((b) => b.px);
      if (positions.length) builder.add(line.from, line.from, guideDeco(positions));
    }
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
