// Hides markdown markup characters so the rendered text reads cleanly:
//   **bold**       → bold
//   *italic*       → italic
//   # Heading      → Heading
//
// Cursor-aware reveal (Obsidian "Live Preview" convention):
//   The markers stay hidden EXCEPT when the cursor (or any selection range)
//   touches the element they belong to. Click into a heading and the `#`
//   reappears so you can edit it; click out and it hides again.
//
// Adding a new marker type later (strikethrough, ==highlight==, etc.):
//   add a case in the iterate() switch — give it the marker node name and
//   the parent node name(s) used to test selection overlap.

import { Decoration, ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

const hide = Decoration.replace({});

const HEADING_NAMES = new Set([
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3',
  'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
]);
const EMPHASIS_PARENTS = new Set(['Emphasis', 'StrongEmphasis']);

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const state = view.state;
  const doc = state.doc;
  const ranges = state.selection.ranges;

  const intersectsSelection = (from, to) => {
    for (const r of ranges) {
      if (r.from <= to && r.to >= from) return true;
    }
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'EmphasisMark') {
          const parent = node.node.parent;
          if (!parent || !EMPHASIS_PARENTS.has(parent.name)) return;
          if (intersectsSelection(parent.from, parent.to)) return;
          builder.add(node.from, node.to, hide);
        } else if (node.name === 'HeaderMark') {
          const parent = node.node.parent;
          if (!parent || !HEADING_NAMES.has(parent.name)) return;
          if (intersectsSelection(parent.from, parent.to)) return;
          // Hide the marker AND the space(s) that follow, so heading text
          // doesn't render with a stray leading space.
          let end = node.to;
          while (end < doc.length && doc.sliceString(end, end + 1) === ' ') end++;
          builder.add(node.from, end, hide);
        }
      },
    });
  }

  return builder.finish();
}

export const hideMarkdownMarkers = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      // Rebuild on cursor moves too — reveal/hide depends on selection.
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
