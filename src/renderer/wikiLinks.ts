import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { LINK_RE, parseTarget } from './linkIndex.js';

function splitLink(raw) {
  const [beforePipe, ...rest] = raw.split('|');
  const alias = rest.length > 0 ? rest.join('|').trim() : '';
  const targetName = beforePipe.split('#')[0].trim();
  return { targetName, display: alias || beforePipe.trim() };
}

class LinkWidget extends WidgetType {
  targetName; resolved; display; onClick; sourcePath;
  constructor(targetName, display, resolved, onClick, sourcePath) {
    super();
    this.targetName = targetName;
    this.display = display;
    this.resolved = resolved;
    this.onClick = onClick;
    this.sourcePath = sourcePath;
  }

  eq(other) {
    return this.targetName === other.targetName
      && this.display === other.display
      && this.resolved === other.resolved
      && this.sourcePath === other.sourcePath;
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
      this.onClick(this.targetName, this.sourcePath);
    });
    return a;
  }

  ignoreEvent(event) {
    return event.type !== 'mousedown' && event.type !== 'click';
  }
}

function buildDecorations(view, onClick, cache, sourcePath) {
  const builder = new RangeSetBuilder();
  const ranges = view.state.selection.ranges;
  const touchesSelection = (from, to) => {
    for (const r of ranges) {
      if (r.from <= to && r.to >= from) return true;
    }
    return false;
  };
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(line.text)) !== null) {
        const { targetName, display } = splitLink(m[1]);
        if (!targetName) continue;
        // Ask the metadata cache to resolve (path-qualified or bare, with the
        // same-folder/shortest tiebreaker) — Obsidian's getFirstLinkpathDest.
        const resolved = !!cache && cache.getFirstLinkpathDest(parseTarget(m[1]), sourcePath) != null;
        const start = line.from + m.index;
        const end = start + m[0].length;
        // Reveal raw [[name]] when the cursor/selection touches the link, so
        // the user can edit it (same convention as markdownLinks.ts).
        if (touchesSelection(start, end)) continue;
        builder.add(
          start,
          end,
          Decoration.replace({ widget: new LinkWidget(targetName, display, resolved, onClick, sourcePath) })
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function wikiLinks(onClick, getCache, getSourcePath) {
  return ViewPlugin.fromClass(
    class {
      decorations;
      sourcePath;
      constructor(view) {
        this.sourcePath = getSourcePath?.() ?? null;
        this.decorations = buildDecorations(view, onClick, getCache(), this.sourcePath);
      }
      update(update) {
        const sourcePath = getSourcePath?.() ?? null;
        // Rebuild on doc/viewport/selection change or when the active file
        // switches — reading the live cache, so resolution is always current as
        // of the last editor interaction.
        if (update.docChanged || update.viewportChanged || update.selectionSet || sourcePath !== this.sourcePath) {
          this.sourcePath = sourcePath;
          this.decorations = buildDecorations(update.view, onClick, getCache(), sourcePath);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
