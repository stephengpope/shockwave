import { EditorView } from '@codemirror/view';

// Shared indent geometry for indentGuides.ts + hangingIndent.ts. Both answer the
// same question — "how many pixels wide is this leading whitespace?" — and they
// MUST agree exactly, or the guides drift off the text they're meant to sit left
// of. One implementation, imported by both.
//
// Positions are MEASURED, not placed on a `ch` grid: we measure the font's
// space-advance once via a canvas (cheap, no editor-layout read — CodeMirror
// forbids layout reads during an update) and advance from there. That keeps the
// math right in a proportional font, for spaces or tabs.

let cachedFont = '';
let cachedSpace = 0;
let measureCtx: CanvasRenderingContext2D | null = null;

export function spaceWidth(view: EditorView) {
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

export function tabStopPx(view: EditorView, sp: number) {
  // Read the custom property, not the computed tab-size — Chromium reports the
  // computed length scaled by devicePixelRatio, custom props come back verbatim.
  const cs = getComputedStyle(view.contentDOM);
  const own = parseFloat(cs.getPropertyValue('--editor-tab-size'));
  if (Number.isFinite(own) && own > 0) return own;
  const ts = cs.tabSize;
  const n = parseFloat(ts);
  if (!n) return sp * 4;
  return ts.includes('px') ? n : n * sp; // unitless = number of space-widths
}

// Advance past one whitespace char: a space adds one space-width, a tab snaps to
// the next tab stop.
export function nextPx(px: number, ch: string, sp: number, tabPx: number) {
  return ch === '\t' ? (Math.floor(px / tabPx) + 1) * tabPx : px + sp;
}

// Pixel width of a run of leading whitespace.
export function leadingWidthPx(ws: string, sp: number, tabPx: number) {
  let px = 0;
  for (const ch of ws) px = nextPx(px, ch, sp, tabPx);
  return px;
}
