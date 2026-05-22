// Inline image rendering for the markdown editor.
//
// Canonical CodeMirror 6 pattern from https://codemirror.net/examples/decoration/:
//   MatchDecorator     — finds `![alt](url)` ranges by regex and maintains
//                        the decoration set incrementally across edits.
//   Decoration.replace — atomically replaces the matched source with a widget.
//   atomicRanges       — cursor navigation skips over the widget as one unit.
//
// The widget shows an <img> served by the `app://media/<rel-to-vault>` protocol
// (registered in electron/main.js). URLs that resolve outside the vault, or
// can't be parsed, fall through to no decoration (source stays visible).
//
// Decorations rebuild only on docChanged || viewportChanged (per the official
// example) — NOT on selectionSet. That's deliberate; selection-driven rebuilds
// cause cursor jitter and interact badly with other decoration extensions.

import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

class ImageWidget extends WidgetType {
  constructor(url, alt) {
    super();
    this.url = url;
    this.alt = alt;
  }
  eq(other) {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-image-embed';
    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt || '';
    img.loading = 'lazy';
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function dirOf(filePath) {
  const i = filePath.lastIndexOf('/');
  return i >= 0 ? filePath.slice(0, i) : '';
}

// Resolve a markdown image URL to a loadable src. Returns null when the path
// resolves outside the vault — those stay as plain text rather than render
// something the protocol handler will 403 anyway.
function resolveImageUrl(raw, activeDir, vault) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^(https?:|data:|app:|file:)/i.test(trimmed)) return trimmed;
  let decoded;
  try { decoded = decodeURI(trimmed); } catch { decoded = trimmed; }
  let abs;
  if (decoded.startsWith('/')) abs = decoded;
  else abs = (activeDir ? activeDir + '/' : '') + decoded;
  const parts = abs.split('/');
  const norm = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') norm.pop();
    else norm.push(seg);
  }
  abs = '/' + norm.join('/');
  if (!vault) return null;
  if (abs !== vault && !abs.startsWith(vault + '/')) return null;
  const rel = abs === vault ? '' : abs.slice(vault.length + 1);
  return 'app://media/' + rel.split('/').map(encodeURIComponent).join('/');
}

export function imageWidgets(getActiveFilePath, getVaultPath) {
  const matcher = new MatchDecorator({
    // `![alt](url)` — alt may be empty, url disallows `)` and whitespace
    // (CommonMark spec); optional `"title"` after the url is stripped.
    regexp: /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
    decoration: (match) => {
      const alt = match[1];
      const rawUrl = match[2];
      const activePath = getActiveFilePath();
      const vault = getVaultPath();
      const src = resolveImageUrl(rawUrl, dirOf(activePath || ''), vault);
      if (!src) return null;
      return Decoration.replace({ widget: new ImageWidget(src, alt) });
    },
  });

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = matcher.createDeco(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = matcher.updateDeco(update, this.decorations);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.decorations || Decoration.none,
        ),
    },
  );
}
