// Renders [text](url) as a clickable link showing just `text`.
// Click opens the URL externally. When the cursor (or any selection range)
// touches the link, the raw `[text](url)` syntax is revealed so the user can
// edit it — same convention as hideMarkdownMarkers.

import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

class MdLinkWidget extends WidgetType {
  constructor(text, url) {
    super();
    this.text = text;
    this.url = url;
  }
  eq(other) { return other.text === this.text && other.url === this.url; }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-md-link';
    a.textContent = this.text;
    a.href = this.url;
    a.title = this.url;
    a.addEventListener('mousedown', (e) => e.preventDefault());
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(this.url);
    });
    return a;
  }
  ignoreEvent() { return false; }
}

function extractParts(state, linkNode) {
  // Walk children of a Link node: LinkMark "[", inline content, LinkMark "]",
  // LinkMark "(", URL, LinkMark ")". Returns either:
  //   { kind: 'text', text, url }         — normal link, replace with widget
  //   { kind: 'image', imageFrom, imageTo, url }
  //                                       — link wrapping an image; caller
  //                                         hides the wrapper, leaves image
  let openBracketEnd = -1;
  let closeBracketStart = -1;
  let urlText = '';
  let imageRange = null;
  if (!linkNode.firstChild) return null;
  let cursor = linkNode.cursor();
  if (!cursor.firstChild()) return null;
  do {
    if (cursor.name === 'Image' && !imageRange) {
      imageRange = { from: cursor.from, to: cursor.to };
    } else if (cursor.name === 'LinkMark') {
      const tok = state.doc.sliceString(cursor.from, cursor.to);
      if (tok === '[' && openBracketEnd === -1) openBracketEnd = cursor.to;
      else if (tok === ']' && closeBracketStart === -1) closeBracketStart = cursor.from;
    } else if (cursor.name === 'URL') {
      urlText = state.doc.sliceString(cursor.from, cursor.to);
    }
  } while (cursor.nextSibling());
  if (openBracketEnd === -1 || closeBracketStart === -1 || !urlText) return null;
  if (imageRange) {
    return { kind: 'image', imageFrom: imageRange.from, imageTo: imageRange.to, url: urlText };
  }
  const text = state.doc.sliceString(openBracketEnd, closeBracketStart);
  if (!text) return null;
  return { kind: 'text', text, url: urlText };
}

const hide = Decoration.replace({});

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const state = view.state;
  const ranges = state.selection.ranges;
  const touchesSelection = (from, to) => {
    for (const r of ranges) {
      if (r.from <= to && r.to >= from) return true;
    }
    return false;
  };

  // Collect first, then sort + emit — image-link wrappers emit two ranges
  // (prefix + suffix) and RangeSetBuilder requires strictly ordered input.
  const decos = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'Link') return;
        if (touchesSelection(node.from, node.to)) return false;
        const parts = extractParts(state, node.node);
        if (!parts) return false;
        if (parts.kind === 'image') {
          // Hide [ before the image and ](url) after — image widget renders
          // in the gap.
          decos.push({
            from: node.from,
            to: parts.imageFrom,
            deco: hide,
          });
          decos.push({
            from: parts.imageTo,
            to: node.to,
            deco: hide,
          });
        } else {
          decos.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new MdLinkWidget(parts.text, parts.url) }),
          });
        }
        return false;
      },
    });
  }
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const d of decos) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

// Returns the enclosing [text](url) / [![alt](src)](url) link at `pos`, or null.
// Shape: { from, to, kind: 'text'|'image', text?, imageFrom?, imageTo?, url }.
// Used by the editor context menu to enable Edit / Remove link.
export function findLinkAtPos(state, pos) {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Link') node = node.parent;
  if (!node) return null;
  const parts = extractParts(state, node);
  if (!parts) return null;
  return { from: node.from, to: node.to, ...parts };
}

export const markdownLinks = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
