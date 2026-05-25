// Bare URLs (http://… and https://…) in the document become clickable links.
//
// Implementation:
//   - Process only visible ranges.
//   - Use the syntax tree to skip URLs that are already part of an explicit
//     markdown link [text](url), inline/fenced code, or HTML — those have
//     their own rendering and shouldn't be double-decorated.
//   - Render each URL as an atomic widget (<a>-like span). The widget itself
//     handles clicks; the cursor flows around it so we don't fight with
//     ordinary text positioning.
//   - Rebuild on doc + viewport changes only (no per-cursor rebuilds).

import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}'"`]+/g;

// Don't strip the whole tail — common URLs end legitimately in many chars.
// Just trim the obvious sentence-terminating punctuation that almost never
// belongs to a URL.
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

class UrlWidget extends WidgetType {
  constructor(url) {
    super();
    this.url = url;
  }
  eq(other) { return other.url === this.url; }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-autolink';
    a.textContent = this.url;
    a.href = this.url;
    a.addEventListener('mousedown', (e) => {
      // Block CodeMirror's selection drag so the click registers as a click.
      e.preventDefault();
    });
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(this.url);
    });
    return a;
  }
  ignoreEvent() { return false; }
}

// Returns true if [from, to] falls inside any node we should NOT auto-link.
function isInsideExcludedNode(state, from, to) {
  let excluded = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      switch (node.name) {
        case 'Link':            // [text](url) — the url part is its own thing
        case 'URL':             // url inside a markdown link
        case 'Autolink':        // <https://...>
        case 'InlineCode':
        case 'CodeBlock':
        case 'FencedCode':
        case 'HTMLBlock':
        case 'HTMLTag':
          excluded = true;
          return false;
        default:
          return undefined;
      }
    },
  });
  return excluded;
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    URL_RE.lastIndex = 0;
    let match;
    while ((match = URL_RE.exec(text)) != null) {
      let url = match[0];
      const trail = url.match(TRAILING_PUNCT_RE);
      if (trail) url = url.slice(0, url.length - trail[0].length);
      if (!url) continue;
      const start = from + match.index;
      const end = start + url.length;
      if (isInsideExcludedNode(view.state, start, end)) continue;
      builder.add(start, end, Decoration.replace({ widget: new UrlWidget(url) }));
    }
  }
  return builder.finish();
}

export const autoLinks = ViewPlugin.fromClass(
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
  },
);
