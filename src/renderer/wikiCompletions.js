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

export function wikiLinkCompletions(getPageIndex, getVaultPath) {
  return (context) => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 200), context.pos);
    const m = before.match(TRIGGER_RE);
    if (!m) return null;
    const partial = m[1].toLowerCase();
    const start = context.pos - m[1].length;
    const index = getPageIndex();
    const vaultPath = getVaultPath();
    const options = [];
    for (const [key, path] of index) {
      if (!key.includes(partial)) continue;
      const display = prettyName(path).split('/').pop();
      const full = prettyName(path, vaultPath);
      options.push({
        label: display,
        apply: applyCompletion(display),
        detail: full !== display ? full : undefined,
        boost: key.startsWith(partial) ? 1 : 0,
      });
      if (options.length >= 50) break;
    }
    if (options.length === 0 && !context.explicit) return null;
    return { from: start, options };
  };
}
