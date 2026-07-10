import { toRelPath, dirOf, basenameOf } from './pathUtils';

const TRIGGER_RE = /\[\[([^\]\n|#]*)$/;

function applyCompletion(insertBody) {
  return (view, _completion, from, to) => {
    const followsClose = view.state.sliceDoc(to, to + 2) === ']]';
    const insert = followsClose ? insertBody : `${insertBody}]]`;
    const cursor = followsClose ? to + 2 : from + insert.length;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: cursor },
      userEvent: 'input.complete',
    });
  };
}

export function wikiLinkCompletions(getCache, getWorkspacePath) {
  return (context) => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 200), context.pos);
    const m = before.match(TRIGGER_RE);
    if (!m) return null;
    const start = context.pos - m[1].length;
    const cache = getCache();
    const ws = getWorkspacePath?.() ?? null;
    // One option per file. When a basename is shared, each candidate shows its
    // folder as detail and inserts the shortest disambiguating path form, so an
    // ambiguous bare link is never authored. CM does the fuzzy filtering.
    const options: any[] = [];
    for (const path of cache.allPaths()) {
      const rel = toRelPath(path, ws) || basenameOf(path);
      const label = basenameOf(rel).replace(/\.md$/i, '');
      const ambiguous = cache.candidatesFor(label.toLowerCase()).length > 1;
      options.push({
        label,
        detail: ambiguous ? (dirOf(rel) || '/') : undefined,
        apply: applyCompletion(cache.shortestUniqueLinkFor(path)),
      });
    }
    if (options.length === 0 && !context.explicit) return null;
    return { from: start, options };
  };
}
