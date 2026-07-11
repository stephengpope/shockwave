// Code styling for the live-preview editor:
//   `inline code`   → monospace pill (faint background), backticks hidden
//   ```fenced```     → monospace block (full-width background box)
//
// Cursor-aware reveal (same convention as hideMarkdownMarkers.ts): the backtick
// markers (` and the ``` fence + language info) stay hidden EXCEPT when the
// cursor / a selection range touches the code node. Click in → markers reappear
// so you can edit; click out → they hide and the emptied fence lines read as the
// box's top/bottom padding.
//
// Two separate plugins so their RangeSetBuilders never mix decoration kinds:
//   - codeMarks: inline mark + cursor-aware marker hiding (all inline ranges)
//   - codeBlockLines: full-width line backgrounds (line decorations only)
// Styling lives in app.css (.cm-inline-code / .cm-code-block*) so dark mode
// rides the existing --bg-code theme token — no per-theme HighlightStyle.

import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

const hide = Decoration.replace({});
const inlinePill = Decoration.mark({ class: 'cm-inline-code' });

function touchesSelection(ranges, from, to) {
  for (const r of ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

// ---- inline pill + cursor-aware marker hiding (inline ranges only) ----

function buildMarks(view) {
  const state = view.state;
  const ranges = state.selection.ranges;
  const decos: any[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'InlineCode') {
          const open = node.node.firstChild;
          const close = node.node.lastChild;
          if (!open || !close) return;
          // Pill wraps just the content between the backticks (always on).
          if (close.from > open.to) {
            decos.push({ from: open.to, to: close.from, deco: inlinePill });
          }
          if (!touchesSelection(ranges, node.from, node.to)) {
            decos.push({ from: open.from, to: open.to, deco: hide });
            decos.push({ from: close.from, to: close.to, deco: hide });
          }
        } else if (node.name === 'FencedCode') {
          if (touchesSelection(ranges, node.from, node.to)) return;
          // Hide the ``` fence marks + the language info on the open line.
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'CodeMark' || c.name === 'CodeInfo') {
              decos.push({ from: c.from, to: c.to, deco: hide });
            }
          }
        }
      },
    });
  }
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder();
  for (const d of decos) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

const codeMarks = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view) {
      this.decorations = buildMarks(view);
    }
    update(update) {
      // selectionSet: marker reveal depends on cursor position.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildMarks(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- full-width fenced-block background (line decorations only) ----

function buildLines(view) {
  const state = view.state;
  const doc = state.doc;
  const decos: any[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'FencedCode') return;
        const startLine = doc.lineAt(node.from).number;
        // node.to can land on the next line's start (after the closing \n);
        // clamp to node.to - 1 so we don't paint a trailing blank line.
        const endLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let n = startLine; n <= endLine; n++) {
          let cls = 'cm-code-block';
          if (n === startLine) cls += ' cm-code-block-first';
          if (n === endLine) cls += ' cm-code-block-last';
          decos.push({ from: doc.line(n).from, deco: Decoration.line({ class: cls }) });
        }
      },
    });
  }
  decos.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder();
  for (const d of decos) builder.add(d.from, d.from, d.deco);
  return builder.finish();
}

const codeBlockLines = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view) {
      this.decorations = buildLines(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildLines(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- copy button, top-right of each fenced block (widget decorations only) ----

// Icons mirror Icons.tsx (CopyIcon / CheckIcon) — same stroke style, inlined as
// markup since the widget is vanilla DOM, not React.
const SVG_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const COPY_SVG = `<svg ${SVG_ATTRS}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg ${SVG_ATTRS}><polyline points="20 6 9 17 4 12"/></svg>`;

class CopyButtonWidget extends WidgetType {
  code: string;
  constructor(code) {
    super();
    this.code = code;
  }
  eq(other) {
    return other.code === this.code;
  }
  toDOM() {
    const btn = document.createElement('button');
    btn.className = 'cm-code-copy';
    btn.type = 'button';
    btn.innerHTML = COPY_SVG;
    btn.setAttribute('aria-label', 'Copy code');
    // mousedown preventDefault so clicking doesn't move the editor selection.
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.code).then(
        () => {
          btn.innerHTML = CHECK_SVG;
          btn.classList.add('is-copied');
          setTimeout(() => { btn.innerHTML = COPY_SVG; btn.classList.remove('is-copied'); }, 1200);
        },
        () => {
          btn.classList.add('is-failed');
          setTimeout(() => { btn.classList.remove('is-failed'); }, 1200);
        },
      );
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

function buildCopyButtons(view) {
  const state = view.state;
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const decos: any[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'FencedCode') return;
        // Rendered mode only — hide the button while editing inside the block.
        if (touchesSelection(ranges, node.from, node.to)) return;
        const startLine = doc.lineAt(node.from).number;
        const endLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;
        // Code body = lines between the open/close fence lines (no fences).
        let code = '';
        if (endLine - 1 >= startLine + 1) {
          code = doc.sliceString(doc.line(startLine + 1).from, doc.line(endLine - 1).to);
        }
        decos.push({
          from: doc.line(startLine).from,
          deco: Decoration.widget({ widget: new CopyButtonWidget(code), side: 1 }),
        });
      },
    });
  }
  decos.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder();
  for (const d of decos) builder.add(d.from, d.from, d.deco);
  return builder.finish();
}

const codeCopyButtons = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view) {
      this.decorations = buildCopyButtons(view);
    }
    update(update) {
      // selectionSet: button hides when the cursor enters the block.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildCopyButtons(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const codeStyles = [codeMarks, codeBlockLines, codeCopyButtons];
