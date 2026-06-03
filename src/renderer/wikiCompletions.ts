import { prettyName } from './linkIndex.js';

const TRIGGER_RE = /\[\[([^\]\n|#]*)$/;

function applyCompletion(display) {
  return (view, _completion, from, to) => {
    const followsClose = view.state.sliceDoc(to, to + 2) === ']]';
    const insert = followsClose ? display : `${display}]]`;
    const replaceTo = to;
    const cursor = followsClose ? to + 2 : from + insert.length;
    view.dispatch({
      changes: { from, to: replaceTo, insert },
      selection: { anchor: cursor },
      userEvent: 'input.complete',
    });
  };
}

export function wikiLinkCompletions(getPageIndex) {
  return (context) => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 200), context.pos);
    const m = before.match(TRIGGER_RE);
    if (!m) return null;
    const start = context.pos - m[1].length;
    const index = getPageIndex();
    // Hand CM every basename (links are basename-only, workspace-unique) and let
    // its built-in autocomplete matcher do the fuzzy filtering, ranking, and
    // match highlighting. No pre-filter, no custom render — CM owns all of it.
    const options: any[] = [];
    for (const [, path] of index) {
      const display = prettyName(path).split('/').pop();
      options.push({ label: display, apply: applyCompletion(display) });
    }
    if (options.length === 0 && !context.explicit) return null;
    return { from: start, options };
  };
}
