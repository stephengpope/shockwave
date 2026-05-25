// ESM mirror of src/linkIndex.js's parser pieces.
// Keep LINK_RE / normalizeTarget / parseLinks in sync if either file changes.

const LINK_RE = /\[\[([^\]\n]+?)\]\]/g;

function normalizeTarget(raw) {
  const beforePipe = raw.split('|')[0];
  const beforeHash = beforePipe.split('#')[0];
  const name = beforeHash.trim().replace(/\.md$/i, '');
  return name.toLowerCase();
}

function leadingWidth(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
}

function collectContext(lines, startIdx, max = 20) {
  const baseIndent = leadingWidth(lines[startIdx]);
  const ctx = [];
  const pendingBlanks = [];
  for (let j = startIdx + 1; j < lines.length && ctx.length < max; j++) {
    const line = lines[j];
    if (line.trim() === '') {
      pendingBlanks.push(line);
      continue;
    }
    if (leadingWidth(line) <= baseIndent) break;
    ctx.push(...pendingBlanks, line);
    pendingBlanks.length = 0;
  }
  return ctx;
}

function parseLinks(content) {
  const out = [];
  if (!content) return out;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    LINK_RE.lastIndex = 0;
    let m;
    let foundOnThisLine = false;
    let contextForThisLine = null;
    while ((m = LINK_RE.exec(line)) !== null) {
      const target = normalizeTarget(m[1]);
      if (!target) continue;
      if (!foundOnThisLine) {
        contextForThisLine = collectContext(lines, i);
        foundOnThisLine = true;
      }
      out.push({
        target,
        lineNumber: i + 1,
        lineText: line,
        contextLines: contextForThisLine,
      });
    }
  }
  return out;
}

export { parseLinks, normalizeTarget };
