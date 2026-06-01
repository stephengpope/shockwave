import { Decoration, ViewPlugin, WidgetType, KeyBinding } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// A task item: list marker (`- `, `* `, `+ `) followed by `[ ]` or `[x]`.
// The bullet prefix is required (matches GFM/CommonMark); the whole
// `bullet [ ]` range is replaced with the widget so `- [ ] foo` collapses to
// `☐ foo`. Group 1: leading whitespace. Group 2: bullet + space. Group 3: state.
const TASK_RE = /^(\s*)([-*+]\s+)\[([ xX])\]/;

// Match the whole task line so we can read the content after `[ ]`.
const TASK_LINE_RE = /^(\s*)([-*+]\s+)\[([ xX])\]\s*(.*)$/;

class CheckboxWidget extends WidgetType {
  checked; prefixLength;
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

// Enter handler for task list items. Runs BEFORE markdownKeymap so we own the
// `- [ ]` continuation logic (markdownKeymap continues `- ` bullets but doesn't
// know about the `[ ]` part, so without this you'd get a bare `- ` on the next
// line and the empty-task escape never works). Acts when the cursor is in the
// task's content (at or past the start of the text after `[ ]`); a cursor inside
// the marker/prefix falls through to normal Enter handling.
//   non-empty task + Enter at end  →  new `- [ ] ` line below (Obsidian/Notion)
//   non-empty task + Enter mid-text →  split, carrying the after-cursor text
//                                      onto a new `- [ ] ` line (keeps checkbox)
//   empty task + Enter             →  clear the empty `- [ ]` (escape the list)
export const taskEnterKeymap: KeyBinding[] = [{
  key: 'Enter',
  run: (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    const m = line.text.match(TASK_LINE_RE);
    if (!m) return false;
    const [, indent, bullet, , content] = m;
    // Only handle Enter once the cursor is in the content region; inside the
    // `- [ ] ` marker we let the default newline run.
    const contentStart = line.from + (line.text.length - content.length);
    if (sel.head < contentStart) return false;
    if (content.trim() === '') {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      return true;
    }
    // Insert a fresh task marker at the cursor. At end of line this appends an
    // empty `- [ ] `; mid-text it splits — the text after the cursor moves onto
    // the new task line, so the checkbox is preserved on both halves.
    const insert = `\n${indent}${bullet}[ ] `;
    view.dispatch({
      changes: { from: sel.head, insert },
      selection: { anchor: sel.head + insert.length },
      scrollIntoView: true,
    });
    return true;
  },
}];

export const taskCheckboxes = ViewPlugin.fromClass(
  class {
    decorations;
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
