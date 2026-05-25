import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// Match a list-item marker at line start. Skip task items — taskCheckboxes.js
// swallows the whole `bullet [ ]` range, so decorating the bullet here would
// collide with that decoration.
const LIST_RE = /^(\s*)([-*+])(\s+)(?!\[[ xX]\])/;

class BulletWidget extends WidgetType {
  eq() { return true; }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = '•';
    return span;
  }

  ignoreEvent() { return true; }
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const match = line.text.match(LIST_RE);
      if (match) {
        const markerStart = line.from + match[1].length;
        builder.add(
          markerStart,
          markerStart + 1,
          Decoration.replace({ widget: new BulletWidget() }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const bulletPoints = ViewPlugin.fromClass(
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
