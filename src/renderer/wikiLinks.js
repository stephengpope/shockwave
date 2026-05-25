import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { LINK_RE, normalizeTarget } from './linkIndex.js';

function splitLink(raw) {
  const [beforePipe, ...rest] = raw.split('|');
  const alias = rest.length > 0 ? rest.join('|').trim() : '';
  const targetName = beforePipe.split('#')[0].trim();
  return { targetName, display: alias || beforePipe.trim() };
}

class LinkWidget extends WidgetType {
  constructor(targetName, display, resolved, onClick) {
    super();
    this.targetName = targetName;
    this.display = display;
    this.resolved = resolved;
    this.onClick = onClick;
  }

  eq(other) {
    return this.targetName === other.targetName
      && this.display === other.display
      && this.resolved === other.resolved;
  }

  toDOM() {
    const a = document.createElement('a');
    a.className = this.resolved
      ? 'cm-wiki-link'
      : 'cm-wiki-link cm-wiki-link-unresolved';
    a.textContent = this.display;
    a.href = '#';
    a.addEventListener('mousedown', (e) => e.preventDefault());
    a.addEventListener('click', (e) => {
      e.preventDefault();
      this.onClick(this.targetName);
    });
    return a;
  }

  ignoreEvent(event) {
    return event.type !== 'mousedown' && event.type !== 'click';
  }
}

function buildDecorations(view, onClick, pageIndex) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(line.text)) !== null) {
        const { targetName, display } = splitLink(m[1]);
        if (!targetName) continue;
        const resolved = pageIndex.has(normalizeTarget(targetName));
        const start = line.from + m.index;
        const end = start + m[0].length;
        builder.add(
          start,
          end,
          Decoration.replace({ widget: new LinkWidget(targetName, display, resolved, onClick) })
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function wikiLinks(onClick, getPageIndex) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.pageIndex = getPageIndex();
        this.decorations = buildDecorations(view, onClick, this.pageIndex);
      }
      update(update) {
        const pageIndex = getPageIndex();
        // Identity changes when the tree changes (useMemo in useLinkIndex).
        if (update.docChanged || update.viewportChanged || pageIndex !== this.pageIndex) {
          this.pageIndex = pageIndex;
          this.decorations = buildDecorations(update.view, onClick, pageIndex);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
