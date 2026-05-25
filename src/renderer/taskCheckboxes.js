import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// A task item: list marker (`- `, `* `, `+ `) followed by `[ ]` or `[x]`.
// The bullet prefix is required (matches GFM/CommonMark); the whole
// `bullet [ ]` range is replaced with the widget so `- [ ] foo` collapses to
// `☐ foo`. Group 1: leading whitespace. Group 2: bullet + space. Group 3: state.
const TASK_RE = /^(\s*)([-*+]\s+)\[([ xX])\]/;

class CheckboxWidget extends WidgetType {
  constructor(checked, prefixLength) {
    super();
    this.checked = checked;
    // Number of chars in the optional bullet prefix (0, or e.g. 2 for `- `).
    // The `[` lives at pos+prefixLength; the toggle char is at pos+prefixLength+1.
    this.prefixLength = prefixLength;
  }

  eq(other) {
    return this.checked === other.checked && this.prefixLength === other.prefixLength;
  }

  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task-checkbox';

    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    box.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const bracketStart = pos + this.prefixLength;
      const snippet = view.state.doc.sliceString(bracketStart, bracketStart + 3);
      if (!/^\[[ xX]\]$/.test(snippet)) return;
      const newChar = this.checked ? ' ' : 'x';
      view.dispatch({
        changes: { from: bracketStart + 1, to: bracketStart + 2, insert: newChar },
      });
    });

    return box;
  }

  ignoreEvent(event) {
    return event.type !== 'mousedown' && event.type !== 'click';
  }
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const match = line.text.match(TASK_RE);
      if (match) {
        const start = line.from + match[1].length;
        const end = start + match[2].length + 3;
        const checked = match[3] === 'x' || match[3] === 'X';
        builder.add(
          start,
          end,
          Decoration.replace({ widget: new CheckboxWidget(checked, match[2].length) })
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const taskCheckboxes = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
