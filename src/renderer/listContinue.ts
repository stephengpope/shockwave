import { KeyBinding } from '@codemirror/view';

// Continue a bullet/ordered list item TIGHTLY on Enter — never the blank line
// CM's insertNewlineContinueMarkup inserts for "loose" lists (items separated by
// a blank line). Without this, once any blank line makes a list loose, every
// Enter perpetuates more blanks: `- a` + Enter → `- a\n\n- ` → `- a\n\n\n- ` …
// which is exactly what users see in note files that already have spacing.
//
// Scope (deliberately narrow — everything else falls through to the next Enter
// handler, returning false):
//   - Only NON-EMPTY items (group 6 requires a non-space char). Empty items
//     return false so markdownEnterKeymap collapses/outdents them (CM handles
//     nesting + the "remove marker" vs "outdent one level" decision well).
//   - Tasks are excluded via the `(?!\[[ xX]\])` lookahead — taskEnterKeymap
//     (bound earlier) already continues those tightly.
//   - Cursor must be at end of line; mid-line Enter falls through.
//
// Ordered lists: the new marker is current-number + 1. Items BELOW the cursor
// are not renumbered (CM does that); the dominant case is appending at the end
// of a list, where there's nothing below to renumber.
//
// Bound AFTER taskEnterKeymap and BEFORE markdownEnterKeymap.
const LIST_CONTINUE_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(?!\[[ xX]\])(\S.*)$/;

export const listContinueKeymap: KeyBinding[] = [{
  key: 'Enter',
  run: (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    if (sel.head !== line.to) return false;
    const m = line.text.match(LIST_CONTINUE_RE);
    if (!m) return false;
    const [, indent, marker, num, delim, space] = m;
    const nextMarker = num !== undefined ? `${parseInt(num, 10) + 1}${delim}` : marker;
    const insert = `\n${indent}${nextMarker}${space}`;
    view.dispatch(state.update({
      changes: { from: sel.head, insert },
      selection: { anchor: sel.head + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    }));
    return true;
  },
}];
